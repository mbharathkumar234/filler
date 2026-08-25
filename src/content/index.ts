/**
 * Content script entry (§ Phase 3 harvest, § Phase 5 fill, § Phase 6 resume).
 *
 * Injected on an explicit user gesture via `chrome.scripting.executeScript`,
 * never declared in the manifest — a declared content script auto-injects into
 * every matching page, which is the broad `<all_urls>` behaviour the plan
 * forbids and the store reviews for.
 *
 * The submit guard is installed the moment this script runs, before any value
 * is written, so no fill of ours can reach a submit unapproved.
 *
 * This file is wiring. The Phase 6 behaviour — pause, resume, drift recovery —
 * lives in `run-controller.ts`, which takes its dependencies as ports so that
 * the same code can be driven by Playwright against a fixture page. Everything
 * below connects those ports to the real `chrome.*` and the real overlay.
 */

import { harvest } from './harvester';
import type { HarvestResult } from './harvester';
import { fingerprintForm } from '@/runtime/plan';
import { envelope, isEnvelope } from '@/shared/messages';
import type { ExtensionRequest, Result } from '@/shared/messages';
import type { FieldDescriptor, RunState } from '@/shared/types';
import {
  findDependentSelects,
  runFill,
  undoFill,
} from './fill-run';
import type { PlannedWrite, WriteRecord } from './fill-run';
import { isXPath } from './selectors';
import type { FieldSnapshot } from './filler';
import { detectBlockers } from './blockers';
import { applyEdit, collectValues, focusField } from './review-bridge';
import { isFreshDocument } from './watcher';
import { RunController } from './run-controller';
import {
  installSubmitGuard,
  setToastHandler,
  guardState,
  arm,
  submitWithApproval,
  type ApprovalToken,
} from './submit-guard';
import {
  hidePause,
  mountOverlay,
  setAbortHandler,
  setContinueHandler,
  setProgress,
  setStatus,
  showPause,
  showToast,
} from './overlay';

/** Latest harvest, so a plan ref can be resolved back to a live element. */
let current: HarvestResult | null = null;
/** Pre-fill snapshots for Undo. */
let lastSnapshots: FieldSnapshot[] = [];
let abortRequested = false;
let controller: RunController | null = null;
let tabId: number | null = null;

/** Set once, before anything else runs: was this document freshly loaded? */
const documentWasReloaded = isFreshDocument(window);

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
  /** § Phase 6: human-only steps found on this page. */
  humanSteps: { type: string; instruction: string }[];
  /** § Phase 6: the run state, after any rehydration. */
  runState: RunState['t'];
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

  // § Phase 6: adopt (or resume) the run for this form before reporting.
  await adoptRun(fingerprint);

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
    humanSteps: detectBlockers(document).map((finding) => ({
      type: finding.type,
      instruction: finding.instruction,
    })),
    runState: controller?.state.t ?? 'IDLE',
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

// ---------------------------------------------------------------------------
// § Phase 6 — wiring the controller to chrome and the overlay
// ---------------------------------------------------------------------------

/**
 * Which tab are we in?
 *
 * Asked of the worker, because the run's storage key is `run:${tabId}:…` and a
 * content script has no other way to know. The worker reads it from
 * `sender.tab.id`, which Chrome sets and a page cannot forge.
 */
async function whoAmI(): Promise<number | null> {
  if (tabId !== null) return tabId;
  try {
    const response = (await chrome.runtime.sendMessage(envelope({ type: 'run:hello' }))) as
      | Result<{ tabId: number }>
      | undefined;
    tabId = response?.ok ? response.data.tabId : null;
  } catch {
    tabId = null;
  }
  return tabId;
}

async function adoptRun(fingerprint: string): Promise<void> {
  const id = await whoAmI();
  if (id === null) return;

  controller ??= new RunController({
    tabId: id,
    doc: document,
    reloaded: documentWasReloaded,
    resolve: elementFor,
    requestRefill,
    onState: (state) => {
      void chrome.runtime.sendMessage(envelope({ type: 'run:state', state })).catch(() => {
        // The panel may be closed. The state is persisted regardless.
      });
    },
    onStatus: (status, detail) => {
      mountOverlay();
      setStatus(status, detail);
    },
    onPause: (finding) => {
      mountOverlay();
      showPause(finding.instruction);
    },
    onResume: hidePause,
  });

  await controller.attach(fingerprint);
}

/**
 * Ask the worker to send the values again.
 *
 * The worker decides whether to honour it — see `refillTab`. This side does
 * not hold the values and cannot re-derive them, which is the point.
 */
async function requestRefill(refs: string[]): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = (await chrome.runtime.sendMessage(
      envelope({ type: 'fill:refill', refs }),
    )) as Result<unknown> | undefined;

    if (response?.ok) return { ok: true };
    const error = response?.error ?? 'The refill could not be completed.';
    mountOverlay();
    showToast(error);
    return { ok: false, error };
  } catch {
    return { ok: false, error: 'Could not reach the extension to restore those fields.' };
  }
}

async function performFill(writes: PlannedWrite[]): Promise<{
  records: WriteRecord[];
  aborted: boolean;
  blocked: number;
}> {
  abortRequested = false;
  mountOverlay();

  if (controller && !(await controller.beginFill())) {
    const why =
      controller.blocker?.instruction ?? 'This page is waiting for you before anything is filled.';
    showToast(why);
    return { records: [], aborted: true, blocked: guardState().blocked };
  }

  setStatus('filling', `0 of ${writes.length} fields`);

  const result = await runFill(writes, {
    resolve: elementFor,
    onProgress: setProgress,
    aborted: () => abortRequested || (controller?.halted ?? false),
  });

  lastSnapshots = result.snapshots;
  controller?.remember(writes.map((write) => write.ref));

  // A page that raised a security control mid-fill stops the run here rather
  // than at the next field.
  const stopped = (await controller?.checkBlockers()) ?? false;

  if (!stopped) {
    setStatus(
      result.aborted ? 'paused' : 'review',
      result.aborted
        ? 'Aborted. Nothing was submitted.'
        : `${result.records.filter((r) => r.ok).length} of ${writes.length} filled — review in the side panel.`,
    );
  }

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
    void controller?.abort('user pressed Abort');
    void chrome.runtime.sendMessage(envelope({ type: 'run:abort', why: 'user pressed Abort' }));
  });

  // § Phase 6: "I have completed this — continue".
  setContinueHandler(() => {
    void controller?.userContinue();
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

    // § Phase 7 — the review screen's three page-side operations.
    if (request.type === 'review:collect') {
      sendResponse({ ok: true, data: collectValues(request.refs, elementFor) });
      return true;
    }

    if (request.type === 'field:focus') {
      const el = elementFor(request.ref);
      if (el) focusField(el, document);
      sendResponse({ ok: true, data: null });
      return true;
    }

    if (request.type === 'field:apply-edit') {
      const el = elementFor(request.ref);
      if (!el) {
        sendResponse({ ok: false, error: 'That field is no longer on the page.' });
        return true;
      }
      const outcome = applyEdit(el, request.value);
      // A correction is a fill: the run must remember it, or re-verification
      // would decide the page had reset the field and put our value back.
      controller?.remember([request.ref]);
      sendResponse({ ok: true, data: { ok: outcome.ok, value: outcome.value } });
      return true;
    }

    if (request.type === 'fill:undo') {
      const restored = undoFill(lastSnapshots, elementFor);
      lastSnapshots = [];
      controller?.forget();
      setStatus('idle');
      sendResponse({ ok: true, data: { restored } });
      return true;
    }

    if (request.type === 'run:continue') {
      (controller?.userContinue() ?? Promise.resolve()).then(
        () => sendResponse({ ok: true, data: null }),
        () => sendResponse({ ok: false, error: 'Could not resume.' }),
      );
      return true;
    }

    if (request.type === 'run:abort') {
      abortRequested = true;
      void controller?.abort('user aborted');
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
