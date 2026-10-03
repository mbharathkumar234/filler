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

import { harvest, isVisible } from './harvester';
import type { HarvestResult } from './harvester';
import {
  findUploadButton,
  findUploadSlots,
  type UploadButton,
  type UploadSlot,
} from './upload-slots';
import { base64ToBytes } from '@/shared/base64';
import { fingerprintForm } from '@/runtime/plan';
import { envelope, isEnvelope } from '@/shared/messages';
import type { ExtensionRequest, Result } from '@/shared/messages';
import type { FieldDescriptor, FillPlan, RunState } from '@/shared/types';
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
import { startPicker, type PickerHandle } from './picker';
import { isFreshDocument } from './watcher';
import { RunController } from './run-controller';
import type { RunPersistence } from '@/runtime/store';
import type { PersistedRun } from '@/runtime/persistence';
import {
  installSubmitGuard,
  setToastHandler,
  guardState,
  arm,
  disarm,
  disengage,
  engage,
  submitWithApproval,
  type ApprovalToken,
} from './submit-guard';
import { isTerminal } from '@/runtime/machine';
import { pressUpload } from './upload-press';
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
/** Upload slots from the latest harvest (`u0`…), resolved the same way. */
let currentSlots: { slots: UploadSlot[]; elements: Map<string, Element> } = {
  slots: [],
  elements: new Map(),
};
/** Pre-fill snapshots for Undo. */
let lastSnapshots: FieldSnapshot[] = [];
let abortRequested = false;
let controller: RunController | null = null;
let tabId: number | null = null;
/** § Phase 9: the teach-mode picker, while one is running. */
let picker: PickerHandle | null = null;

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
  /**
   * Upload questions with no file box of their own — a Google Forms "Add
   * file", a drag-and-drop area. Kept apart from `fields`: they never enter
   * the fill plan, the review's value rows, or the LLM payload.
   */
  uploadSlots: UploadSlot[];
  /**
   * Each file box's own Upload button, by field ref. Recorded so an approval
   * can name it; pressed only by `submit-guard.ts`, only with a token.
   */
  uploadButtons: Record<string, UploadButton>;
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

/**
 * Locate the form's final submit control, for the Phase 7 approval token.
 *
 * A file box's own Upload button is never it. On a page with no "Submit" in
 * any button's text the last candidate used to win, and that could be the
 * Upload beside the last file box — an approval for the whole application
 * would then have named a single document's upload.
 */
function findSubmit(exclude: ReadonlySet<Element> = new Set()): { selector: string; label: string } | null {
  const candidates = [
    ...document.querySelectorAll<HTMLElement>(
      'button[type="submit"], input[type="submit"], button:not([type])',
    ),
  ].filter(
    (el) => !exclude.has(el) && (el.offsetParent !== null || el.getClientRects().length > 0),
  );

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

/**
 * Each file box's Upload button, keyed by the box's ref.
 *
 * Found before the final submit is chosen, so that choice can exclude them.
 * The final submit is then excluded here in turn — `findUploadButton` never
 * returns it, but the exclusion is stated rather than trusted.
 */
function uploadButtonsFor(result: HarvestResult): {
  buttons: Record<string, UploadButton>;
  elements: Set<Element>;
} {
  const buttons: Record<string, UploadButton> = {};
  const elements = new Set<Element>();
  for (const field of result.fields) {
    if (field.tag !== 'file') continue;
    const input = result.elements.get(field.ref);
    if (!input) continue;
    const found = findUploadButton(input, null);
    if (!found) continue;
    buttons[field.ref] = found.button;
    elements.add(found.element);
  }
  return { buttons, elements };
}

export async function runHarvest(): Promise<HarvestReport> {
  current = harvest(document, { shadowDom: true, frameId: 0 });
  currentSlots = findUploadSlots(document, isVisible);
  const uploads = uploadButtonsFor(current);
  const submit = findSubmit(uploads.elements);

  const visible = current.fields.filter((f) => f.visible);
  const fingerprint = await fingerprintForm({
    url: location.href,
    formAction: formAction(),
    fields: current.fields,
    identifiers: identifiers(current),
    step: current.wizard?.step ?? null,
  });

  // § Phase 6: adopt (or resume) the run for this form before reporting — in
  // the top frame only, where every write goes. A run controller in a
  // sub-frame watched mutations and raised overlays inside a site's own upload
  // window, which is no place for either.
  if (isTopFrame(window)) await adoptRun(fingerprint);

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
    submit,
    uploadSlots: currentSlots.slots,
    uploadButtons: uploads.buttons,
    humanSteps: detectBlockers(document).map((finding) => ({
      type: finding.type,
      instruction: finding.instruction,
    })),
    runState: controller?.state.t ?? 'IDLE',
  };
}

/** Resolve a descriptor ref to its live element, re-resolving by selector. */
export function elementFor(ref: string): Element | null {
  const known = current?.elements.get(ref) ?? currentSlots.elements.get(ref);
  if (known?.isConnected) return known;

  // The element may have been replaced by a postback; fall back to selectors.
  const descriptor =
    current?.fields.find((field) => field.ref === ref) ??
    currentSlots.slots.find((slot) => slot.ref === ref);
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

/**
 * Run persistence, done by the worker on our behalf.
 *
 * A content script cannot touch `chrome.storage.session` — it is trusted-context
 * only, and reaching for it throws "Access to storage is not allowed from this
 * context", which is what made every scan on a real page fail. The worker is a
 * trusted context, so it stores; it also knows which tab we are, so no tab id
 * crosses the bus.
 *
 * `load` comes back with the approval token stripped. That is deliberate and
 * costs nothing: the token reaches the guard through `fill:submit` from the
 * panel, never from storage.
 */
const workerPersistence: RunPersistence = {
  async save(_tabId: number, fingerprint: string, state: RunState): Promise<void> {
    await chrome.runtime
      .sendMessage(envelope({ type: 'run:save', fingerprint, state }))
      .catch(() => {
        // The worker may be restarting. Losing one write is survivable; the
        // next transition rewrites the whole state.
      });
  },

  async load(_tabId: number, fingerprint: string): Promise<PersistedRun | null> {
    try {
      // The worker returns the whole record, already version-checked and keyed
      // to its own `sender.tab.id`. Taking it wholesale is not laziness: it is
      // what keeps `persistence.ts` — and therefore `chrome.storage.session` —
      // out of this bundle entirely. `content-storage.test.ts` asserts that.
      const response = (await chrome.runtime.sendMessage(
        envelope({ type: 'run:load', fingerprint }),
      )) as Result<PersistedRun | null> | undefined;

      return response?.ok ? response.data : null;
    } catch {
      return null;
    }
  },

  async clear(_tabId: number, fingerprint: string): Promise<void> {
    await chrome.runtime
      .sendMessage(envelope({ type: 'run:clear', fingerprint }))
      .catch(() => {});
  },
};

async function adoptRun(fingerprint: string): Promise<void> {
  const id = await whoAmI();
  if (id === null) return;

  controller ??= new RunController({
    tabId: id,
    doc: document,
    reloaded: documentWasReloaded,
    resolve: elementFor,
    requestRefill,
    persistence: workerPersistence,
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

  const state = await controller.attach(fingerprint);
  // A run still in progress on this page — a postback that came back carrying
  // our values — is exactly what the guard is for. An idle or finished one is
  // not, and a scan of a page is not a reason to lock its buttons.
  if (state.t !== 'IDLE' && !isTerminal(state)) engage();
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

async function performFill(
  writes: PlannedWrite[],
  plan?: FillPlan,
): Promise<{
  records: WriteRecord[];
  aborted: boolean;
  blocked: number;
}> {
  abortRequested = false;
  mountOverlay();

  /*
   * Walk the run to READY before asking to write.
   *
   * `FILL_START` is honoured only from READY (`runtime/machine.ts`), and a
   * freshly attached run is IDLE. Without this the reducer ignored the event,
   * `mayWritePage` stayed false, and *every* fill aborted with the generic
   * "waiting for you" message — a state machine doing exactly what it was told
   * about a plan it had never been given.
   *
   * A refill arrives without a plan on purpose: it is recovering the run that
   * is already attached, not starting one.
   */
  if (controller && plan) await controller.setPlan(plan);

  if (controller && !(await controller.beginFill())) {
    /*
     * Two very different refusals, and they used to read identically.
     *
     * A blocker means the *page* needs the user — a CAPTCHA, an OTP, an
     * e-sign. That is normal, and its instruction says what to do.
     *
     * No blocker means the *run* would not permit a write, which is an
     * internal fault, not something the user did. Reporting it as "this page
     * is waiting for you" sent two rounds of debugging at the page, so the
     * state is named: it is the one fact that distinguishes a run that was
     * never given a plan from one that is blocked, drifted or already
     * finished.
     */
    const why =
      controller.blocker?.instruction ??
      `Nothing was filled — the run was not ready (${controller.state.t}). ` +
        'Press "Scan page", then "Fill this form" again.';
    showToast(why);
    return { records: [], aborted: true, blocked: guardState().blocked };
  }

  setStatus('filling', `0 of ${writes.length} fields`);

  // From here the page carries our values: nothing leaves it unapproved (P2).
  // Before this point the guard is dormant, and the page is the user's.
  engage();

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

/** Disengage the document_start guard unless the worker holds a live run for this tab. */
async function standDownUnlessRunLive(): Promise<void> {
  try {
    const response = (await chrome.runtime.sendMessage(envelope({ type: 'run:active' }))) as
      | { ok: true; data: boolean }
      | { ok: false }
      | undefined;
    if (!(response?.ok === true && response.data === true)) disengage();
  } catch {
    // The worker could not be asked. Guarding a page nobody is filling is the
    // failure the user notices — their own login refused — so hand it back.
    disengage();
  }
}

function isTopFrame(win: Window): boolean {
  try {
    return win.top === win;
  } catch {
    // Unreadable `top` means we are nested somewhere foreign: not the top.
    return false;
  }
}

// The script is injected repeatedly across a session; wire listeners once.
declare global {
  interface Window {
    __autofillContentReady?: boolean;
  }
}

/*
 * Wire once per document, and only count it as wired if it worked.
 *
 * The flag used to be set on the line *before* the wiring, which made any
 * throw permanent: the frame was marked ready, the listener was never
 * registered, and every later injection saw the flag and did nothing. From the
 * panel that looked like "no readable frame responded" forever, with no way
 * back short of reloading the page — and no clue that reloading was the answer.
 *
 * Setting it at the end, and clearing it on the way out of a failure, means a
 * transient error costs one attempt instead of the session.
 */
if (!window.__autofillContentReady) {
  window.__autofillContentReady = true;
  try {
  /*
   * P2 first: the guard is live before anything can be written — in the one
   * frame anything is ever written to.
   *
   * Every write addresses the top frame: `fill:apply`, a refill, a review
   * edit, an approved submit or upload all go to `frameId: 0`, and
   * `elementFor` resolves in this document only. The document_start guard is
   * registered with `allFrames: false` for the same reason (`early-guard.ts`).
   * A guard in a sub-frame protects nothing of ours, and it did harm: a site's
   * own upload window is often a same-origin frame (Google Forms' is), and the
   * guard there blocked the user's own press on its Upload button.
   */
  setToastHandler((message) => {
    mountOverlay();
    setStatus('blocked', 'Nothing was submitted.');
    showToast(message);
  });
  if (isTopFrame(window)) {
    installSubmitGuard(document);
    /*
     * Loaded before the page itself: the per-origin document_start script,
     * which exists only while a run is live on this site (`early-guard.ts`).
     * It is there for one case — a postback that comes back carrying our
     * values and submits during load — so it starts engaged, before the page
     * can act, and asks the worker whether *this tab* has that run. Any other
     * tab of the same site is handed back within a round trip.
     */
    if (document.readyState === 'loading') {
      engage();
      void standDownUnlessRunLive();
    }
  }

  setAbortHandler(() => {
    abortRequested = true;
    setStatus('paused', 'Aborting…');
    // § Phase B: an abort leaves no armed state behind. The worker revokes its
    // own grant when it sees `run:abort`; this is the page side of the same
    // thing, and it happens first because it is the half that can act.
    disengage();
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

    if (request.type === 'run:release') {
      // The run is over; the page is the user's again.
      disengage();
      sendResponse({ ok: true, data: null });
      return false;
    }

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
                bytes: base64ToBytes(write.value.base64),
                mime: write.value.mime,
                filename: write.value.filename,
              },
      })) as PlannedWrite[];

      performFill(writes, request.plan).then(
        (result) => sendResponse({ ok: true, data: result }),
        (error: unknown) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'Fill failed.',
          }),
      );
      return true;
    }

    // § Phase 9 — the teach-mode picker.
    if (request.type === 'teach:pick-start') {
      picker?.stop();
      picker = startPicker(document, {
        known: current?.fields ?? [],
        resolve: elementFor,
        onPick: (picked) => {
          // Selectors and a label only. A pick never carries a value — there
          // is no reason for the panel to learn what is in the box the user
          // is pointing at.
          void chrome.runtime
            .sendMessage(
              envelope({
                type: 'teach:picked',
                ref: picked.ref,
                selectors: picked.selectors,
                label: picked.label,
                tag: picked.tag,
                ...(picked.refused === undefined ? {} : { refused: picked.refused }),
              }),
            )
            .catch(() => {
              // The panel closed mid-teach. Nothing to do.
            });
        },
        onCancel: () => {
          picker = null;
          void chrome.runtime.sendMessage(envelope({ type: 'teach:pick-stop' })).catch(() => {});
        },
      });
      sendResponse({ ok: true, data: null });
      return true;
    }

    if (request.type === 'teach:pick-stop') {
      picker?.stop();
      picker = null;
      sendResponse({ ok: true, data: null });
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
      // A correction from the review screen writes our value into the page.
      engage();
      void applyEdit(el, request.value).then((outcome) => {
        // A correction is a fill: the run must remember it, or re-verification
        // would decide the page had reset the field and put our value back.
        controller?.remember([request.ref]);
        sendResponse({ ok: true, data: { ok: outcome.ok, value: outcome.value } });
      });
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
      disarm();
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

    if (request.type === 'fill:press-upload') {
      // One document's approved upload: same guard, same token discipline as
      // the final submit. See `upload-press.ts` for the one thing it adds.
      const ok = pressUpload(request.token, elementFor(request.ref), document);
      mountOverlay();
      setStatus(ok ? 'review' : 'blocked', ok ? 'Upload pressed.' : 'Could not press Upload.');
      sendResponse({ ok: true, data: { pressed: ok } });
      return true;
    }

    return false;
  });

    void chrome.runtime.sendMessage(envelope({ type: 'harvest:ready' })).catch(() => {
      // The panel may not be open. Nothing to do.
    });
  } catch (error) {
    // Leave the frame injectable again, and make the reason visible in the
    // page's own console — this used to fail silently and permanently.
    window.__autofillContentReady = false;
    console.error('[AutoFill Assistant] could not wire this page:', error);
    throw error;
  }
}
