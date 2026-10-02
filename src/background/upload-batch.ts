/**
 * One hold, every upload window on a form — the sequencing (§ document attachment).
 *
 * Kept apart from `upload-window-service.ts`, which owns the gates (vault,
 * re-auth, P1/P6) and the real `chrome.scripting`, so that this — the part that
 * decides what to press, when, and what counts as done — can be driven against
 * a fixture in a real browser. It reaches nothing itself: every page action
 * goes through `ports.inject`, and every document through `ports.variant`.
 * `run-controller.ts` is built the same way, for the same reason.
 *
 * For each document, in form order:
 *
 *  1. if the form already shows the file under the question, leave it;
 *  2. press the question's own "Add file", found by the question's words at
 *     that moment (`submit-guard.ts`, token-checked);
 *  3. wait for a window that was not on screen before — a hidden one left
 *     behind by the last upload is never it, and a hidden one shown again is;
 *  4. put the fitted document in (file box first, then a drop);
 *  5. wait until **the form shows the file** under the question; if the
 *     window sits waiting for an Upload or Insert press, press it once.
 *
 * Success is read off the form, never assumed from the window closing, and
 * never from memory: a window can close without uploading, and the user can
 * remove a file with its ✕ at any time. One document at a time, never
 * overlapping — two windows open at once is how a document lands in the wrong
 * question.
 */

import type { FieldKey } from '@/matching/taxonomy';
import type { DocConstraint } from '@/shared/types';
import { fileNameFor } from '@/documents/field-constraint';
import { bytesToBase64 } from '@/shared/base64';
import {
  placeFileInWindow,
  probeUploadWindow,
  questionShowsFile,
  type WindowProbe,
} from '@/content/upload-window';
import {
  openUploadWindowWithApproval,
  pressUploadInWindowWithApproval,
  type WindowPressToken,
} from '@/content/submit-guard';

/** One upload question, as the batch needs it. */
export interface BatchSlot {
  ref: string;
  label: string;
  selectors: string[];
  /** Null for a question nobody could place — it is skipped with a reason. */
  key: FieldKey | null;
  constraint: DocConstraint;
}

/** What happened to one document in a batch. */
export interface BatchItem {
  ref: string;
  key: FieldKey | null;
  label: string;
  uploaded: boolean;
  /** A sentence for the user when it did not go. */
  why?: string;
  /**
   * What happened, step by step, with seconds from the start of this document.
   * Shown under a document that did not go, so one screenshot says where.
   */
  trace?: string[];
}

export type FittedFile =
  | { ok: true; bytes: Uint8Array; mime: string; width: number; height: number; passedThrough: boolean }
  | { ok: false; reason: string };

/**
 * One answer per frame. `null` is what Chrome gives for a frame that could not
 * run the function — another site's frame, one mid-navigation, one that threw —
 * and it is the ordinary case on a real page, not an error. Treating only
 * `undefined` as "no answer" crashed on it and stopped every hold after the
 * first document.
 */
export type Injected<R> = { frameId: number; result: R | null | undefined }[];

export interface BatchPorts {
  /**
   * Run a self-contained function in one frame (0 is the top) or in every
   * frame, as `chrome.scripting.executeScript({ func, args })` does. Never
   * throws: a frame that could not be reached or that threw answers `null`.
   */
  inject<A extends unknown[], R>(target: number | 'all', func: (...args: A) => R, args: A): Promise<Injected<R>>;
  /** The document, fitted to the question's requirement. */
  variant(key: FieldKey, constraint: DocConstraint): Promise<FittedFile>;
  /** A single-use token for this document, or null once the approval has lapsed. */
  token(slot: BatchSlot, key: FieldKey): WindowPressToken | null;
  /** Told of each document that arrived, and of each that did not. */
  arrived?(slot: BatchSlot, key: FieldKey, file: Extract<FittedFile, { ok: true }>): void | Promise<void>;
  failed?(slot: BatchSlot, key: FieldKey, why: string): void;
}

export interface BatchClock {
  sleep(ms: number): Promise<void>;
  now(): number;
}

export const realClock: BatchClock = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/** How long a site gets to open its window, and to finish an upload. */
export const WINDOW_OPEN_MS = 15_000;
export const WINDOW_FINISH_MS = 120_000;
const POLL_MS = 400;
/** A window still open this long after the file went in is waiting for its Upload press. */
const PRESS_AFTER_MS = 2_500;
/** A window gone this long with no file on the form did not upload it. */
const ARRIVE_AFTER_CLOSE_MS = 10_000;

/** Frames that are an upload window on screen right now. Hidden stale ones are not. */
export function openWindows(probes: Injected<WindowProbe>): Set<number> {
  return new Set(
    probes
      .filter(
        (entry) =>
          entry.result != null &&
          !entry.result.top &&
          entry.result.shown !== false &&
          (entry.result.fileBoxes > 0 || entry.result.dropAreas > 0),
      )
      .map((entry) => entry.frameId),
  );
}

export async function runUploadBatch(
  slots: readonly BatchSlot[],
  ports: BatchPorts,
  clock: BatchClock = realClock,
): Promise<BatchItem[]> {
  const inTop = async <A extends unknown[], R>(func: (...args: A) => R, args: A): Promise<R | null> =>
    (await ports.inject(0, func, args))[0]?.result ?? null;
  const windowsNow = async (): Promise<Set<number>> =>
    openWindows(await ports.inject('all', probeUploadWindow, []));
  const shows = async (label: string, name: string): Promise<boolean> =>
    (await inTop(questionShowsFile, [label, name])) === true;

  /**
   * One document, start to finish. Answers 'hold' when a window is left open
   * with the file not on the form — the batch must not open another over it.
   */
  async function uploadOne(
    slot: BatchSlot,
    key: FieldKey,
    item: BatchItem,
    note: (step: string) => void,
  ): Promise<'next' | 'hold'> {
    const fail = (why: string) => {
      item.why = why;
      ports.failed?.(slot, key, why);
    };

    const file = await ports.variant(key, slot.constraint);
    if (!file.ok) {
      fail(file.reason);
      return 'next';
    }
    const name = fileNameFor(key, file.mime);

    // Already on the form: never a second copy.
    if (await shows(slot.label, name)) {
      item.uploaded = true;
      item.why = 'Already on the form.';
      return 'next';
    }

    const token = ports.token(slot, key);
    if (!token) {
      fail('The approval ran out before this one. Hold to upload again.');
      return 'next';
    }

    const before = await windowsNow();
    const how = await inTop(openUploadWindowWithApproval, [slot.label, slot.selectors, token]);
    if (!how) {
      note('Add file not found on the page');
      fail('Its Add file button is not on the page. Scan the page again, then retry.');
      return 'next';
    }
    note(`pressed Add file, found ${how} (${before.size} window${before.size === 1 ? '' : 's'} already open)`);

    // Wait for the window this press opened.
    let windowFrame: number | null = null;
    for (const start = clock.now(); clock.now() - start < WINDOW_OPEN_MS; ) {
      await clock.sleep(POLL_MS);
      const fresh = [...(await windowsNow())].filter((id) => !before.has(id));
      if (fresh.length > 0) {
        // The newest, if the window nests one frame in another.
        windowFrame = Math.max(...fresh);
        break;
      }
    }
    if (windowFrame === null) {
      note('no new window appeared');
      fail('The upload window did not open. Click its Add file button, then use “Put … in the upload window”.');
      return 'next';
    }
    const frame = windowFrame;
    note(`window ${frame} opened`);

    const base64 = bytesToBase64(file.bytes);
    const place = async (mode: 'box' | 'drop') =>
      (await ports.inject(frame, placeFileInWindow, [base64, file.mime, name, mode]))[0]?.result ?? null;
    const placed = await place('box');
    note(placed?.placed ? `file put in (${placed.route})` : `file box refused: ${placed?.why ?? 'no answer'}`);
    // A window may take the file, close, and answer as if it had not; the form decides.
    if (!placed?.placed && !(await shows(slot.label, name))) {
      const dropped = await place('drop');
      note(dropped?.placed ? 'file dropped in' : `drop refused: ${dropped?.why ?? 'no answer'}`);
    }

    // Wait for the form to show the file — the only proof it arrived.
    let arrived = false;
    let pressed = false;
    let closedAt: number | null = null;
    for (const start = clock.now(); clock.now() - start < WINDOW_FINISH_MS; ) {
      await clock.sleep(POLL_MS);
      if (await shows(slot.label, name)) {
        arrived = true;
        note('the form shows the file');
        break;
      }
      const stillOpen = (await windowsNow()).has(frame);
      if (!stillOpen) {
        if (closedAt === null) {
          closedAt = clock.now();
          note('window closed');
        }
        // Closed, and the file never reached the form: it did not upload.
        if (clock.now() - closedAt >= ARRIVE_AFTER_CLOSE_MS) break;
      } else if (!pressed && clock.now() - start >= PRESS_AFTER_MS) {
        pressed = true;
        const didPress = (await ports.inject(frame, pressUploadInWindowWithApproval, [token]))[0]?.result;
        note(didPress ? 'pressed the window’s Upload' : 'window still open; no Upload button to press');
      }
    }

    if (!arrived) {
      note('the form does not show the file');
      if ((await windowsNow()).has(frame)) {
        // Never open a second window over one still in use.
        fail('The upload window is still open and the file has not arrived. Finish it by hand, then hold again.');
        return 'hold';
      }
      fail('The upload window closed, but the form does not show the file. Hold again to retry this one.');
      return 'next';
    }

    item.uploaded = true;
    await ports.arrived?.(slot, key, file);

    // Let the window finish closing before the next Add file.
    for (const start = clock.now(); clock.now() - start < WINDOW_OPEN_MS; ) {
      if (!(await windowsNow()).has(frame)) break;
      await clock.sleep(POLL_MS);
    }
    await clock.sleep(800);
    return 'next';
  }

  const items: BatchItem[] = [];
  let held = false;

  for (const slot of slots) {
    const { key } = slot;
    const item: BatchItem = { ref: slot.ref, key, label: slot.label, uploaded: false };
    items.push(item);
    const began = clock.now();
    const note = (step: string) => {
      (item.trace ??= []).push(`${((clock.now() - began) / 1000).toFixed(1)}s ${step}`);
    };

    if (key === null) {
      item.why = 'Not sure which document this question asks for — choose one, then try again.';
      continue;
    }
    if (held) {
      item.why = 'Not started: an earlier upload window is still open.';
      continue;
    }

    try {
      held = (await uploadOne(slot, key, item, note)) === 'hold';
    } catch (error) {
      // Whatever went wrong, it went wrong for this document only; the rest still go.
      note(`stopped: ${error instanceof Error ? error.message : String(error)}`);
      item.why = 'Something went wrong with this one. Hold again to retry it.';
      ports.failed?.(slot, key, item.why);
    }
  }

  return items;
}
