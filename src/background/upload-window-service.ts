/**
 * "Put … in the upload window" (§ document attachment, Google Forms).
 *
 * The user clicks the form's own Add file; the site opens its upload window;
 * the user presses this; the document goes into that window; the user presses
 * the window's Upload. Four steps, two of them the user's, and the one that
 * sends the file anywhere is always theirs.
 *
 * Works from the panel's last scan rather than a fresh one. A fresh harvest
 * injects `content.js` into every frame — including the upload window that is
 * now open — and there is nothing in that window for the content script to
 * do. The scan the user took before clicking Add file is the one whose
 * questions the panel is showing them.
 */

import type { Result } from '@/shared/messages';
import { isDocumentKey, type FieldKey } from '@/matching/taxonomy';
import { describeConstraint } from '@/documents/constraints';
import { fileNameFor } from '@/documents/field-constraint';
import { describeReauth, reauthCheck } from '@/runtime/reauth';
import { appendAudit } from '@/runtime/audit';
import { bytesToBase64 } from '@/shared/base64';
import { isUnlocked, lastAuthenticatedAt, VaultLockedError } from '@/vault/session';
import {
  placeFileInWindow,
  probeUploadWindow,
  type WindowProbe,
  type WindowResult,
} from '@/content/upload-window';
import type { WindowPressToken } from '@/content/submit-guard';
import type { TabHarvest } from './harvest-service';
import {
  realClock,
  runUploadBatch,
  type BatchClock,
  type BatchItem,
  type BatchPorts,
  type BatchSlot,
} from './upload-batch';
import { variantFor } from './document-service';
import { lastHarvest } from './harvest-service';
import { mayStartRun } from './limits';
import { rememberDocument } from './review-service';
import { originPatternOf } from './injection-failure';
import type { DocumentOutcome } from './fill-service';

export interface WindowPlacement {
  placed: boolean;
  route?: 'file-box' | 'drop';
  /** A sentence for the user when nothing was placed. */
  why?: string;
  code?: string;
  /** What the page asked for, in words. */
  requirement?: string;
  /** The file that went in, or would have. */
  variant?: { mime: string; bytes: number; width: number; height: number };
  /** An upload window on another site the user may allow, as an origin pattern. */
  origin?: string;
}

export type FrameChoice =
  | { ok: true; frameId: number }
  | { ok: false; code: 'no-window' | 'foreign-window'; origin?: string };

/**
 * Which frame is the upload window.
 *
 * A frame that appeared after the scan and has somewhere to put a file is the
 * window the user just opened. Failing that, an open dialog in the top
 * document. Two candidates is refused rather than guessed: a document placed
 * in the wrong window is a document sent to the wrong place.
 *
 * Pure, so the choice is tested without a browser.
 */
export function chooseWindowFrame(
  probes: readonly { frameId: number; result: WindowProbe | null | undefined }[],
  scannedFrames: ReadonlySet<number>,
): FrameChoice {
  const offers = (probe: WindowProbe) => probe.fileBoxes > 0 || probe.dropAreas > 0;

  const nested = probes.filter(
    (entry): entry is { frameId: number; result: WindowProbe } =>
      entry.result != null &&
      !entry.result.top &&
      entry.result.shown !== false &&
      offers(entry.result),
  );
  const fresh = nested.filter((entry) => !scannedFrames.has(entry.frameId));
  const candidates = fresh.length > 0 ? fresh : nested;

  // Several at once — a window left open, or one nested in another: the newest
  // is the one just opened. Chrome numbers frames in the order it creates them.
  if (candidates.length > 0) {
    return { ok: true, frameId: Math.max(...candidates.map((entry) => entry.frameId)) };
  }

  const top = probes.find((entry) => entry.result?.top === true);
  if (top?.result && top.result.dialog && offers(top.result)) return { ok: true, frameId: top.frameId };

  // Something visible is framed from another site, and we could not look in.
  const foreign = top?.result?.frameOrigins.find((origin) => origin !== top.result?.origin);
  if (foreign) return { ok: false, code: 'foreign-window', origin: foreign };

  return { ok: false, code: 'no-window' };
}

const WHY: Record<Exclude<FrameChoice, { ok: true }>['code'], string> = {
  'no-window':
    'No upload window is open. Click the form’s own Add file button first, then press this again.',
  'foreign-window':
    'The upload window belongs to another site, which this extension has not been allowed to open.',
};

export async function putInUploadWindow(
  tabId: number,
  slotRef: string,
  mode: 'box' | 'drop' = 'box',
  /** The user's pick, for a question the matcher could not place. */
  chosenKey?: FieldKey,
): Promise<Result<WindowPlacement>> {
  if (!isUnlocked()) {
    return { ok: false, error: new VaultLockedError().message, code: 'VAULT_LOCKED' };
  }

  const harvest = lastHarvest(tabId);
  if (!harvest) {
    return { ok: false, error: 'Scan the page first, then open its upload window.', code: 'NO_SCAN' };
  }

  const slot = harvest.uploadSlots.find((candidate) => candidate.ref === slotRef);
  // The matcher's reading wins; the user's pick only fills a question it could
  // not place — and only ever with a document key.
  const key =
    slot?.key ?? (chosenKey !== undefined && isDocumentKey(chosenKey) ? chosenKey : null);
  if (!slot || key === null) {
    return {
      ok: true,
      data: {
        placed: false,
        code: 'unknown-slot',
        why: slot
          ? 'Choose which document this question asks for first.'
          : 'That question is no longer on the page. Scan it again.',
      },
    };
  }
  const requirement = describeConstraint(slot.constraint);

  // P1/P6: never beside a fill already running in this tab, and never past the
  // hourly cap. Not a run of its own, so it does not spend one.
  const allowed = mayStartRun(tabId);
  if (!allowed.allowed) {
    return {
      ok: false,
      error: allowed.message ?? 'Refused.',
      ...(allowed.why === undefined ? {} : { code: allowed.why }),
    };
  }

  // Before a byte is decrypted, as for a fill.
  const gate = reauthCheck([key], lastAuthenticatedAt(), Date.now());
  if (gate.required) {
    return { ok: false, error: describeReauth(gate.keys), code: 'REAUTH_REQUIRED' };
  }

  const variant = await variantFor(key, slot.constraint);
  if (!variant.ok) {
    return { ok: true, data: { placed: false, code: variant.code, why: variant.reason, requirement } };
  }
  const shape = { mime: variant.mime, bytes: variant.bytes.length, width: variant.width, height: variant.height };

  let probes: chrome.scripting.InjectionResult<WindowProbe>[];
  try {
    probes = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: probeUploadWindow,
    });
  } catch {
    return {
      ok: false,
      error: 'This page can no longer be reached. Click the extension’s toolbar icon, scan again, and retry.',
    };
  }

  const choice = chooseWindowFrame(
    probes.map((probe) => ({ frameId: probe.frameId, result: probe.result })),
    new Set(harvest.frames.map((frame) => frame.frameId)),
  );
  if (!choice.ok) {
    const pattern = choice.origin ? originPatternOf(choice.origin) : null;
    return {
      ok: true,
      data: {
        placed: false,
        code: choice.code,
        why: WHY[choice.code],
        requirement,
        variant: shape,
        ...(pattern ? { origin: pattern } : {}),
      },
    };
  }

  let result: WindowResult | undefined;
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [choice.frameId] },
      func: placeFileInWindow,
      args: [bytesToBase64(variant.bytes), variant.mime, fileNameFor(key, variant.mime), mode],
    });
    result = injection?.result;
  } catch {
    result = undefined;
  }

  const placed = result?.placed === true;
  const outcome: DocumentOutcome = {
    ref: slot.ref,
    key,
    portalLabel: slot.label,
    route: 'window',
    attached: placed,
    requirement,
    variant: { ...shape, passedThrough: variant.passedThrough },
    ...(placed ? {} : { code: 'window-refused', reason: result?.why ?? 'The upload window could not be reached.' }),
  };
  rememberDocument(tabId, outcome);

  if (placed) {
    await appendAudit({
      site: harvest.url,
      formFingerprint: harvest.fingerprint,
      event: { t: 'document.placed', key, route: 'window' },
    }).catch(() => {
      // The audit must not undo what the user asked for.
    });
  }

  return {
    ok: true,
    data: {
      placed,
      ...(result?.route ? { route: result.route } : {}),
      ...(placed ? {} : { code: 'window-refused', why: result?.why ?? 'The upload window could not be reached.' }),
      requirement,
      variant: shape,
    },
  };
}

// ---------------------------------------------------------------------------
// Every upload window on the form, after one approval
// ---------------------------------------------------------------------------

export type { BatchItem } from './upload-batch';

/**
 * The real `chrome.scripting`, as the batch's one way into the page.
 *
 * Never throws: a frame that cannot be reached — mid-navigation, or on a site
 * this extension may not open — simply does not answer.
 */
function injector(tabId: number): BatchPorts['inject'] {
  return async (target, func, args) => {
    try {
      const results = await chrome.scripting.executeScript({
        target: target === 'all' ? { tabId, allFrames: true } : { tabId, frameIds: [target] },
        func: func as (...a: unknown[]) => unknown,
        args: args as unknown[],
      });
      return results.map((entry) => ({
        frameId: entry.frameId,
        result: (entry.result ?? null) as ReturnType<typeof func> | null,
      }));
    } catch {
      return [];
    }
  };
}

/**
 * Upload every document the form's upload windows ask for, after one hold.
 *
 * This is the gatekeeper — vault unlocked, a scan to work from, P1/P6, and
 * the re-auth gate for every document before any is decrypted. The sequencing
 * itself is `upload-batch.ts`, which is driven against a fixture in a real
 * browser by `tests/e2e/documents.spec.ts`.
 */
export async function uploadAllToWindows(
  tabId: number,
  picks: Readonly<Record<string, FieldKey>>,
  tokenFor: (
    slot: BatchSlot,
    key: FieldKey,
    harvest: Pick<TabHarvest, 'url' | 'fingerprint'>,
  ) => WindowPressToken | null,
  clock: BatchClock = realClock,
): Promise<Result<{ items: BatchItem[] }>> {
  if (!isUnlocked()) {
    return { ok: false, error: new VaultLockedError().message, code: 'VAULT_LOCKED' };
  }
  const harvest = lastHarvest(tabId);
  if (!harvest) {
    return { ok: false, error: 'Scan the page first.', code: 'NO_SCAN' };
  }

  const slots: BatchSlot[] = harvest.uploadSlots
    .filter((slot) => slot.kind === 'window')
    .map((slot) => {
      const pick = picks[slot.ref];
      return {
        ref: slot.ref,
        label: slot.label,
        selectors: slot.selectors,
        key: slot.key ?? (pick !== undefined && isDocumentKey(pick) ? pick : null),
        constraint: slot.constraint,
      };
    });

  const allowed = mayStartRun(tabId);
  if (!allowed.allowed) {
    return {
      ok: false,
      error: allowed.message ?? 'Refused.',
      ...(allowed.why === undefined ? {} : { code: allowed.why }),
    };
  }

  // Every document's gate at once, before any of them is decrypted.
  const keys = slots.flatMap((slot) => (slot.key === null ? [] : [slot.key]));
  const gate = reauthCheck(keys, lastAuthenticatedAt(), Date.now());
  if (gate.required) {
    return { ok: false, error: describeReauth(gate.keys), code: 'REAUTH_REQUIRED' };
  }

  const items = await runUploadBatch(
    slots,
    {
      inject: injector(tabId),
      variant: (key, constraint) => variantFor(key, constraint),
      token: (slot, key) => tokenFor(slot, key, harvest),
      arrived: async (slot, key, file) => {
        rememberDocument(tabId, {
          ref: slot.ref,
          key,
          portalLabel: slot.label,
          route: 'window',
          attached: true,
          requirement: describeConstraint(slot.constraint),
          variant: {
            mime: file.mime,
            bytes: file.bytes.length,
            width: file.width,
            height: file.height,
            passedThrough: file.passedThrough,
          },
        });
        await appendAudit({
          site: harvest.url,
          formFingerprint: harvest.fingerprint,
          event: { t: 'upload.done', key },
        }).catch(() => {});
      },
      failed: (slot, key, why) => {
        rememberDocument(tabId, {
          ref: slot.ref,
          key,
          portalLabel: slot.label,
          route: 'window',
          attached: false,
          requirement: describeConstraint(slot.constraint),
          code: 'window-refused',
          reason: why,
        });
      },
    },
    clock,
  );

  return { ok: true, data: { items } };
}
