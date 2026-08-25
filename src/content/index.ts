/**
 * Content script entry (§ Phase 3 harvest, § Phase 5 fill).
 *
 * Injected on an explicit user gesture via `chrome.scripting.executeScript`,
 * never declared in the manifest — a declared content script auto-injects into
 * every matching page, which is the broad `<all_urls>` behaviour the plan
 * forbids and the store reviews for.
 *
 * The submit guard is installed the moment this script runs, before any value
 * is written, so no fill of ours can reach a submit unapproved.
 */

import { harvest, type HarvestResult } from './harvester';
import { fingerprintForm } from '@/runtime/plan';
import { envelope, isEnvelope, type ExtensionRequest } from '@/shared/messages';
import type { FieldDescriptor } from '@/shared/types';
import { findDependentSelects, runFill, undoFill, type PlannedWrite, type WriteRecord } from './fill-run';
import { isXPath } from './selectors';
import type { FieldSnapshot } from './filler';
import {
  installSubmitGuard,
  setToastHandler,
  guardState,
  arm,
  submitWithApproval,
  type ApprovalToken,
} from './submit-guard';
import {
  mountOverlay,
  setAbortHandler,
  setProgress,
  setStatus,
  showToast,
} from './overlay';

/** Latest harvest, so a plan ref can be resolved back to a live element. */
let current: HarvestResult | null = null;
/** Pre-fill snapshots for Undo. */
let lastSnapshots: FieldSnapshot[] = [];
let abortRequested = false;

export interface HarvestReport {
  url: string;
  title: string;
  fingerprint: string;
  fields: FieldDescriptor[];
  blockers: HarvestResult['blockers'];
  wizard: HarvestResult['wizard'];
  labelSources: Record<string, string>;
  visibleCount: number;
  labelledCount: number;
  /** Selects whose options are populated by an earlier field (§Phase 3 Should). */
  dependentSelects: string[];
  /** The submit control, recorded so approval can name exactly one element. */
  submit: { selector: string; label: string } | null;
}

function formAction(): string | null {
  return document.querySelector('form')?.getAttribute('action') ?? null;
}

function identifiers(result: HarvestResult): string[] {
  return [...result.elements.values()].map(
    (el) => el.getAttribute('name') ?? el.getAttribute('id') ?? '',
  );
}

/** Locate the form's final submit control, for the Phase 7 approval token. */
function findSubmit(): { selector: string; label: string } | null {
  const candidates = [
    ...document.querySelectorAll<HTMLElement>(
      'button[type="submit"], input[type="submit"], button:not([type])',
    ),
  ].filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);

  const preferred =
    candidates.find((el) =>
      /final submit|submit application|submit/i.test(
        (el.textContent ?? el.getAttribute('value') ?? '').trim(),
      ),
    ) ?? candidates.at(-1);

  if (!preferred) return null;

  const id = preferred.getAttribute('id');
  const name = preferred.getAttribute('name');
  const selector = id
    ? `#${CSS.escape(id)}`
    : name
      ? `${preferred.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`
      : '';
  if (!selector) return null;

  return {
    selector,
    label: (preferred.textContent ?? preferred.getAttribute('value') ?? 'Submit').trim(),
  };
}

export async function runHarvest(): Promise<HarvestReport> {
  current = harvest(document, { shadowDom: true, frameId: 0 });

  const visible = current.fields.filter((f) => f.visible);
  const fingerprint = await fingerprintForm({
    url: location.href,
    formAction: formAction(),
    fields: current.fields,
    identifiers: identifiers(current),
    step: current.wizard?.step ?? null,
  });

  return {
    url: location.href,
    title: document.title,
    fingerprint,
    fields: current.fields,
    blockers: current.blockers,
    wizard: current.wizard,
    labelSources: Object.fromEntries(current.labelSources),
    visibleCount: visible.length,
    labelledCount: visible.filter((f) => f.labelText.trim() !== '').length,
    dependentSelects: [...findDependentSelects(document)],
    submit: findSubmit(),
  };
}

/** Resolve a descriptor ref to its live element, re-resolving by selector. */
export function elementFor(ref: string): Element | null {
  const known = current?.elements.get(ref);
  if (known?.isConnected) return known;

  // The element may have been replaced by a postback; fall back to selectors.
  const descriptor = current?.fields.find((field) => field.ref === ref);
  for (const selector of descriptor?.selectors ?? []) {
    const found = resolveSelector(selector);
    if (found) return found;
  }
  return null;
}

function resolveSelector(selector: string): Element | null {
  try {
    if (isXPath(selector)) {
      return document.evaluate(selector, document, null, 9, null)
        .singleNodeValue as Element | null;
    }
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

async function performFill(writes: PlannedWrite[]): Promise<{
  records: WriteRecord[];
  aborted: boolean;
  blocked: number;
}> {
  abortRequested = false;
  mountOverlay();
  setStatus('filling', `0 of ${writes.length} fields`);

  const result = await runFill(writes, {
    resolve: elementFor,
    onProgress: setProgress,
    aborted: () => abortRequested,
  });

  lastSnapshots = result.snapshots;

  setStatus(
    result.aborted ? 'paused' : 'review',
    result.aborted
      ? 'Aborted. Nothing was submitted.'
      : `${result.records.filter((r) => r.ok).length} of ${writes.length} filled — review in the side panel.`,
  );

  return { records: result.records, aborted: result.aborted, blocked: guardState().blocked };
}

// The script is injected repeatedly across a session; wire listeners once.
declare global {
  interface Window {
    __autofillContentReady?: boolean;
  }
}

if (!window.__autofillContentReady) {
  window.__autofillContentReady = true;

  // P2 first: the guard is live before anything can be written.
  setToastHandler((message) => {
    mountOverlay();
    setStatus('blocked', 'Nothing was submitted.');
    showToast(message);
  });
  installSubmitGuard(document);

  setAbortHandler(() => {
    abortRequested = true;
    setStatus('paused', 'Aborting…');
    void chrome.runtime.sendMessage(envelope({ type: 'run:abort', why: 'user pressed Abort' }));
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isEnvelope(message)) return false;
    if (sender.id !== chrome.runtime.id) return false;

    const request = message.payload as ExtensionRequest;

    if (request.type === 'harvest:request') {
      runHarvest().then(
        (report) => sendResponse({ ok: true, data: report }),
        (error: unknown) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'Harvest failed.',
          }),
      );
      return true;
    }

    if (request.type === 'fill:apply') {
      const writes = request.writes.map((write) => ({
        ...write,
        value:
          typeof write.value === 'string'
            ? write.value
            : {
                bytes: Uint8Array.from(write.value.bytes),
                mime: write.value.mime,
                filename: write.value.filename,
              },
      })) as PlannedWrite[];

      performFill(writes).then(
        (result) => sendResponse({ ok: true, data: result }),
        (error: unknown) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'Fill failed.',
          }),
      );
      return true;
    }

    if (request.type === 'fill:undo') {
      const restored = undoFill(lastSnapshots, elementFor);
      lastSnapshots = [];
      setStatus('idle');
      sendResponse({ ok: true, data: { restored } });
      return true;
    }

    if (request.type === 'run:abort') {
      abortRequested = true;
      setStatus('paused', 'Aborted. Nothing was submitted.');
      sendResponse({ ok: true, data: null });
      return true;
    }

    if (request.type === 'fill:submit') {
      // The single authorised submission (§Phase 7). The guard owns the click.
      const token: ApprovalToken = request.token;
      arm(token);
      const ok = submitWithApproval(token, document);
      setStatus(ok ? 'done' : 'blocked', ok ? 'Submitted.' : 'Could not submit.');
      sendResponse({ ok: true, data: { submitted: ok } });
      return true;
    }

    return false;
  });

  void chrome.runtime.sendMessage(envelope({ type: 'harvest:ready' })).catch(() => {
    // The panel may not be open. Nothing to do.
  });
}
