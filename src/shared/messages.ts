/**
 * Typed message bus.
 *
 * The background service worker is the only holder of the vault key, so every
 * vault operation is a message. Two sender checks guard that surface:
 *
 *  - `isTrustedSender` — the message came from this extension at all. Page
 *    scripts cannot forge `sender.id`.
 *  - `isPrivilegedSender` — the message came from an *extension page* (side
 *    panel, options), not from a content script. Content scripts run inside a
 *    hostile portal page; if one is ever compromised it must not be able to ask
 *    the worker for the user's Aadhaar. Chrome sets `sender.tab` for content
 *    scripts and leaves it undefined for extension pages, which is the
 *    distinction this relies on.
 *
 * Phase 10 adds full schema validation on top of both.
 */

import type { IndicScript } from '@/documents/indic';
import type { ReadTable } from '@/documents/table';
import type { AcademicPath } from '@/matching/pathway';
import type { FieldKey } from '@/matching/taxonomy';
import type { FillPlan, RunState } from './types';
import type { PersistedRun } from '@/runtime/persistence';
import type { ProfileEntry } from '@/vault/profile-store';
import type { Completeness } from '@/vault/profile-store';
import type { VaultStatus } from '@/vault/session';
import type { ImportResult } from '@/vault/backup-format';
import type { DocConstraint } from './types';
import type { DocumentSummary } from '@/vault/document-store';
import type { DerivedPayload, DocumentExtraction, ScannedPage } from '@/background/document-service';
import type { BatchItem, WindowPlacement } from '@/background/upload-window-service';
import type { TabHarvest } from '@/background/harvest-service';
import type { FillReport, WriteInstruction } from '@/background/fill-service';
import type { ReviewPayload } from '@/background/review-service';
import type { AuditEntry, AuditSettings } from '@/runtime/audit';
import type { LlmStatus } from '@/background/llm-service';
import type {
  ProfileVersionSummary,
  SavedProfile,
  TeachSession,
} from '@/background/teach-service';
import type { ProfileHealth } from '@/matching/teach';
import type { EarlyGuardState } from '@/background/early-guard';
import type { ApprovalToken } from '@/content/submit-guard';

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** Requires an unlocked vault and an extension-page sender. */
export type VaultRequest =
  | { type: 'vault:status' }
  | { type: 'vault:create'; passphrase: string }
  | { type: 'vault:unlock'; passphrase: string }
  | { type: 'vault:lock' }
  | { type: 'vault:list' }
  | { type: 'vault:set'; key: FieldKey; value: string; fromDocument?: boolean }
  | { type: 'vault:delete'; key: FieldKey }
  | { type: 'vault:completeness' }
  /*
   * Backup moves a piece at a time.
   *
   * The file is ordinary JSON; only its journey over the bus is split. A vault
   * holding a photo, a signature and forty scans is tens of megabytes, and one
   * message that size is refused — which is what a backup of a full vault now
   * is, since it carries the documents too.
   */
  | { type: 'vault:export-begin' }
  | { type: 'vault:export-chunk'; index: number }
  | { type: 'vault:import-chunk'; index: number; text: string }
  | { type: 'vault:import-commit'; passphrase: string }
  | { type: 'vault:touch' }
  /**
   * The academic path the vault is laid out from (§ vault structure).
   *
   * `vault:set-path` with null forgets it, which the panels read as "show
   * everything" — the state somebody who skips the questions is in.
   *
   * Named with the `vault:` prefix because that is how the worker routes: a
   * vault message called anything else reaches no handler at all, and the
   * panel is told "Unhandled request" by a router that never saw it.
   */
  | { type: 'vault:path' }
  | { type: 'vault:set-path'; path: AcademicPath | null }
  /** § Phase 6 re-auth gate: prove it is still the same person at the desk. */
  | { type: 'vault:reauth'; passphrase: string };

/**
 * Reading a document's pixels (§ reading a document).
 *
 * Worker to offscreen document, and nowhere else. PaddleOCR's models run on
 * ONNX Runtime, whose WebAssembly a service worker can load but should not hold
 * for a whole read, so the recognition runs in an offscreen page — still the
 * extension's own background, never a tab, never a site. The image travels as
 * base64 because the bus is JSON; it is one page of a document the user asked
 * to have read, and it goes no further.
 */
/**
 * A stored photo made a clean scan: stood upright, flattened when it is a page
 * photographed on something, its light evened out. Worker to offscreen page,
 * like a reading; the result goes back to the panel, which saves it only when
 * the user says so.
 */
export type ScanRequest = { type: 'ocr:scan'; image: string; mime: string };

export type OcrRequest = {
  type: 'ocr:recognise';
  /** One page: the stored image as it was, or a PDF page rasterised by the worker. */
  image: string;
  mime: string;
  /**
   * The scripts besides English this page may be in — the ones whose
   * recognisers the reader asks about a box the English model could only guess
   * at. Chosen from where the document's owner lives (`indic.ts` →
   * `readingScripts`); absent, English alone.
   */
  scripts?: IndicScript[];
};

/**
 * A PDF, opened by the page that can open one.
 *
 * A service worker cannot load pdf.js — `import()` is not allowed there, and
 * pdf.js is too large to load on every wake — so the worker hands each PDF to
 * the offscreen page (`offscreen/ocr.ts`), which opens it with pdf.js and
 * answers. Privileged, like `ocr:recognise`: the bytes are one document's, the
 * password is what that one document opens with, and neither goes anywhere
 * else.
 */
export type PdfRequest =
  /** Whether it opens: by itself, not without a password, or not with this one. */
  | { type: 'pdf:lock'; pdf: string; password?: string }
  /** Its text layer, as lines. */
  | { type: 'pdf:text'; pdf: string; password?: string }
  /** One page (from 1; the first unless said) as a PNG this many pixels wide. */
  | { type: 'pdf:render'; pdf: string; password?: string; width: number; page?: number };

/** One piece of text on the page, and where it sits (page pixels). */
export interface OcrItem {
  text: string;
  /** The recogniser's mean character probability, 0–1. */
  score: number;
  box: { x0: number; y0: number; x1: number; y1: number };
}

/** Document operations. Privileged, like the vault requests above. */
export type DocumentRequest =
  | { type: 'doc:list' }
  | {
      type: 'doc:put';
      key: FieldKey;
      label: string;
      mime: string;
      width: number;
      height: number;
      /** Plain array — structured clone over the bus does not keep Uint8Array. */
      bytes: number[];
      /**
       * What a locked PDF opens with, typed by the user when the worker said it
       * needs one. Kept sealed with the document; never sent anywhere else.
       */
      password?: string;
    }
  | { type: 'doc:delete'; id: string }
  | { type: 'doc:derive'; key: FieldKey; constraint: DocConstraint }
  | { type: 'doc:preflight'; key: FieldKey; constraint: DocConstraint }
  | { type: 'doc:extract'; id: string }
  /** A stored photo made a clean scan, for the panel to show — and save only if the user keeps it. */
  | { type: 'doc:scan'; id: string };

/**
 * Put one upload question's document into the site's own upload window, which
 * the user has just opened (Google Forms' "Add file"). The panel names the
 * question; the worker decides the document, fits it, and finds the window. It
 * never presses anything in it — the user presses Upload. Privileged.
 *
 * Its own union rather than a `DocumentRequest`: those are the vault's document
 * store, and this one reaches into a tab.
 */
export type UploadRequest = {
  type: 'doc:to-window';
  tabId: number;
  slotRef: string;
  /** The second try, when the window ignored the first: drop instead of setting its file box. */
  mode?: 'drop';
  /**
   * The document the user picked, for a question the matcher could not place.
   * Only honoured for such a question, and only as a `doc.*` key.
   */
  key?: FieldKey;
};

export type RuntimeRequest =
  | { type: 'ping' }
  | { type: 'harvest:request' }
  | { type: 'harvest:ready' }
  /** Content script asking the worker which tab it is in (§ Phase 6 run keys). */
  | { type: 'run:hello' }
  /**
   * The document_start guard asking whether a fill is live in its own tab.
   * Answered from the worker's run table; a no hands the page back.
   */
  | { type: 'run:active' }
  /** Worker to page: the run is over, and the page is the user's again. */
  | { type: 'run:release' }
  | { type: 'run:state'; state: RunState }
  /** The user pressed "I have completed this" — in the panel or the overlay. */
  | { type: 'run:continue' }
  | { type: 'run:abort'; why: string }
  /**
   * Run persistence, on behalf of a content script.
   *
   * `chrome.storage.session` is trusted-context only, so a content script
   * cannot reach it. These three let it ask the worker, which can — and which
   * strips the approval token before handing state back to an untrusted caller.
   */
  | { type: 'run:save'; fingerprint: string; state: unknown }
  | { type: 'run:load'; fingerprint: string }
  | { type: 'run:clear'; fingerprint: string };

/** Panel-initiated harvest of the active tab. Privileged. */
export type HarvestRequest = { type: 'harvest:tab'; tabId: number };

/**
 * Fill operations. `fill:tab` and `fill:undo:tab` are privileged (panel only).
 * `fill:apply`, `fill:undo` and `fill:submit` travel worker -> content script.
 *
 * `fill:refill` is the exception, and the one that needed thinking about: it
 * travels content script -> worker, so a compromised content script could send
 * it. It is deliberately **not** privileged, because a postback that wipes the
 * form has to be recoverable without dragging the user back to the panel. What
 * contains it is not the sender check but the worker's run authorisation — see
 * `authoriseRun` in `background/fill-service.ts`. The blast radius is "the keys
 * the user already approved filling on this form, while that run is live",
 * not "anything in the vault".
 */
export type FillRequest =
  | { type: 'fill:tab'; tabId: number }
  | { type: 'fill:undo:tab'; tabId: number }
  /**
   * `plan` is what walks the tab's run state machine to READY.
   *
   * It travels with the writes rather than being rebuilt on the page, because
   * only the worker knows `siteId` and `profileVersion`, and because drift
   * recovery compares against the selectors that were *planned* — a plan the
   * content script synthesised from its writes would have nothing to compare.
   *
   * Optional because a **refill** is not a new run: a postback that wiped the
   * form is recovered against the plan already attached to it, and sending a
   * fresh one there would quietly restart the very run being recovered.
   */
  | { type: 'fill:apply'; writes: WriteInstruction[]; plan?: FillPlan }
  | { type: 'fill:undo' }
  | { type: 'fill:refill'; refs: string[] }
  | { type: 'fill:submit'; token: ApprovalToken }
  /**
   * One document's approved upload: the guard presses that file box's own
   * Upload button, once. `ref` is the file box, so the page side knows which
   * document the approval covers.
   */
  | { type: 'fill:press-upload'; token: ApprovalToken; ref: string };

/**
 * Review and approval (§ Phase 7).
 *
 * Everything the panel initiates here is privileged. `review:collect`,
 * `field:focus` and `field:apply-edit` travel worker -> content script.
 *
 * Note what is *not* in this union: any way for the panel to obtain the
 * approval token. The token never leaves the worker — the panel asks for a
 * grant and later asks to submit, and the worker is the only holder. A UI
 * that never sees the token cannot leak one.
 */
export type ReviewRequest =
  | { type: 'review:build'; tabId: number }
  | { type: 'review:collect'; refs: string[] }
  | { type: 'field:focus'; ref: string }
  | { type: 'field:apply-edit'; ref: string; value: string }
  | { type: 'field:highlight'; tabId: number; ref: string }
  | {
      type: 'field:edit';
      tabId: number;
      ref: string;
      value: string;
      /** Also write the correction back to the vault under this key. */
      saveKey?: FieldKey;
    };

export type ApprovalRequest =
  | { type: 'approval:grant'; tabId: number }
  | { type: 'approval:submit'; tabId: number }
  | { type: 'approval:revoke'; tabId: number }
  | { type: 'approval:status'; tabId: number }
  /**
   * The user held to approve one document's upload; press its Upload button.
   * Names the file box only — which button that is, the worker reads from its
   * own harvest, never from the panel.
   */
  | { type: 'approval:upload'; tabId: number; ref: string }
  /**
   * One hold, every upload window on the form (Google Forms). `picks` names a
   * document only for a question the matcher could not place.
   */
  | { type: 'approval:upload-all'; tabId: number; picks?: Record<string, FieldKey> };

/**
 * The model settings (§ Phase 8). All privileged.
 *
 * Note there is no request that *reads* the API key. The panel can store one,
 * clear one, and ask whether one exists; it can never fetch it back. A UI that
 * cannot obtain a secret cannot leak it.
 */
export type LlmRequest =
  | { type: 'llm:status' }
  | { type: 'llm:set-key'; apiKey: string | null }
  | { type: 'llm:set-model'; model: string | null }
  | { type: 'llm:reset-usage' }
  | { type: 'llm:forget-learned' };

/**
 * Teach mode (§ Phase 9).
 *
 * `teach:pick-start` and `teach:pick-stop` travel worker -> content script;
 * `teach:picked` travels content -> worker and carries **selectors and a
 * label, never a value**. Everything else is panel-initiated and privileged.
 */
export type TeachRequest =
  | { type: 'teach:start'; tabId: number }
  | { type: 'teach:stop'; tabId: number }
  | { type: 'teach:cancel'; tabId: number }
  | { type: 'teach:pick-start' }
  | { type: 'teach:pick-stop' }
  | {
      type: 'teach:picked';
      ref: string | null;
      selectors: string[];
      label: string;
      tag: string;
      refused?: string;
    }
  | { type: 'teach:assign'; tabId: number; key: FieldKey; ref: string | null; selectors: string[]; label: string }
  | {
      type: 'teach:assign-document';
      tabId: number;
      key: FieldKey;
      ref: string | null;
      selectors: string[];
      label: string;
      constraint: DocConstraint;
    }
  | { type: 'teach:forget'; tabId: number; key: FieldKey }
  | { type: 'teach:save'; tabId: number }
  | { type: 'teach:session'; tabId: number }
  | { type: 'profile:health'; tabId: number }
  | { type: 'profile:versions'; fingerprint: string }
  | { type: 'profile:rollback'; fingerprint: string }
  | { type: 'profile:export' }
  | { type: 'profile:import'; text: string };

/**
 * The early guard (§ Phase B). All privileged — a content script must not be
 * able to ask for host permission on its own page.
 */
export type GuardRequest =
  | { type: 'guard:status'; tabId: number }
  | { type: 'guard:enable'; tabId: number }
  | { type: 'guard:disable'; origin: string }
  | { type: 'guard:origins' };

export type AuditRequest =
  | { type: 'audit:read'; limit?: number }
  | { type: 'audit:configure'; logValues: boolean }
  | { type: 'audit:settings' }
  | { type: 'audit:clear' };

export type ExtensionRequest =
  | VaultRequest
  | DocumentRequest
  | UploadRequest
  | HarvestRequest
  | FillRequest
  | ReviewRequest
  | ApprovalRequest
  | AuditRequest
  | LlmRequest
  | TeachRequest
  | GuardRequest
  | OcrRequest
  | ScanRequest
  | PdfRequest
  | RuntimeRequest;
export type RequestType = ExtensionRequest['type'];

/**
 * Requests the offscreen page answers, and the service worker leaves alone.
 *
 * Every extension context hears every `runtime.sendMessage`. The worker answers
 * in microseconds and the page in seconds, so a worker that answered these too
 * would answer first — "Rejected." — and the page's real answer would be lost.
 */
export const OFFSCREEN_TYPES: ReadonlySet<string> = new Set([
  'ocr:recognise',
  'ocr:scan',
  'pdf:lock',
  'pdf:text',
  'pdf:render',
]);

/** Request types that must never be honoured for a content script. */
export const PRIVILEGED_TYPES: ReadonlySet<string> = new Set<RequestType>([
  'vault:status',
  'vault:create',
  'vault:unlock',
  'vault:lock',
  'vault:list',
  'vault:set',
  'vault:delete',
  'vault:completeness',
  'vault:export-begin',
  'vault:export-chunk',
  'vault:import-chunk',
  'vault:import-commit',
  'vault:touch',
  'vault:reauth',
  'vault:path',
  'vault:set-path',
  'doc:list',
  'doc:put',
  'doc:delete',
  'doc:derive',
  'doc:preflight',
  'doc:extract',
  'doc:scan',
  // Carries a rendered page of somebody's document: extension contexts only.
  'ocr:recognise',
  'ocr:scan',
  // Carry somebody's PDF, and the password it opens with: extension contexts only.
  'pdf:lock',
  'pdf:text',
  'pdf:render',
  'doc:to-window',
  'harvest:tab',
  'fill:tab',
  'fill:undo:tab',
  'review:build',
  'field:highlight',
  'field:edit',
  'approval:grant',
  'approval:submit',
  'approval:revoke',
  'approval:status',
  'approval:upload',
  'approval:upload-all',
  'audit:read',
  'audit:configure',
  'audit:settings',
  'audit:clear',
  'llm:status',
  'llm:set-key',
  'llm:set-model',
  'llm:reset-usage',
  'llm:forget-learned',
  'teach:start',
  'teach:stop',
  'teach:cancel',
  'teach:assign',
  'teach:assign-document',
  'teach:forget',
  'teach:save',
  'teach:session',
  'profile:health',
  'profile:versions',
  'profile:rollback',
  'profile:export',
  'profile:import',
  'guard:status',
  'guard:enable',
  'guard:disable',
  'guard:origins',
]);

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface ResponseMap {
  'vault:status': VaultStatus;
  'vault:create': null;
  /** false means a wrong passphrase — an expected outcome, not an error. */
  'vault:unlock': boolean;
  'vault:lock': null;
  'vault:list': ProfileEntry[];
  'vault:set': null;
  'vault:delete': null;
  'vault:completeness': Completeness;
  /** How many pieces the finished file is in, and how big it is. */
  'vault:export-begin': { chunks: number; bytes: number; documents: number };
  'vault:export-chunk': string;
  /** How many pieces the worker is holding so far. */
  'vault:import-chunk': { received: number };
  /** null means a wrong passphrase for the backup file. */
  'vault:import-commit': ImportResult | null;
  'vault:touch': null;
  /** null when the questions have not been answered on this vault. */
  'vault:path': AcademicPath | null;
  'vault:set-path': null;
  /** false means a wrong passphrase — the gate stays shut. */
  'vault:reauth': boolean;
  'doc:list': DocumentSummary[];
  /**
   * The saved document — or, for a PDF that opens only with a password,
   * nothing saved yet and why: none was given, or the one given did not open it.
   */
  'doc:put': DocumentSummary | { notSaved: 'needs-password' | 'wrong-password' };
  'doc:delete': null;
  /** A derived file, or a readable explanation of why it could not be made. */
  'doc:derive': DerivedPayload | { failed: true; reason: string; code: string };
  'doc:preflight': { ok: boolean; warnings: string[]; reason?: string };
  'doc:extract': DocumentExtraction;
  'doc:scan': ScannedPage;
  'ocr:scan': { image: string; width: number; height: number; flattened: boolean; turns: 0 | 1 | 2 | 3 };
  /**
   * Every piece of text the page recognised, where it sits, and the page's
   * size — of the page stood upright, with the quarter turns clockwise that
   * stood it there.
   */
  'ocr:recognise': {
    items: OcrItem[];
    width: number;
    height: number;
    turns?: 0 | 1 | 2 | 3;
    /**
     * The page as it was read, as base64 JPEG, when it was a photo flattened
     * first: the boxes are this page's, not the photo's, and the pictures shown
     * beside each value are cut from it.
     */
    flattened?: string;
    /** The tables on the page, cell by cell (`documents/table.ts`), when it has any. */
    tables?: ReadTable[];
    /** The round seals on the page, read straightened (`documents/seal.ts`): where, and the words on each arc. */
    seals?: Array<{ box: { x0: number; y0: number; x1: number; y1: number }; text: string[] }>;
  };
  'pdf:lock': { lock: 'open' | 'needs-password' | 'wrong-password' };
  'pdf:text': { text: string };
  /** A PNG, base64, its size, and how many pages the PDF has. */
  'pdf:render': { image: string; width: number; height: number; pages: number };
  'doc:to-window': WindowPlacement;
  'harvest:tab': TabHarvest;
  'fill:tab': FillReport;
  'fill:undo:tab': { restored: number };
  'fill:apply': { records: FillReport['records']; aborted: boolean; blocked: number };
  'fill:undo': { restored: number };
  'fill:refill': FillReport;
  'fill:submit': { submitted: boolean };
  'fill:press-upload': { pressed: boolean };
  'review:build': ReviewPayload;
  'review:collect': Record<string, string>;
  'field:focus': null;
  'field:apply-edit': { ok: boolean; value: string };
  'field:highlight': null;
  'field:edit': { ok: boolean; value: string; savedToVault: boolean };
  /** No token — see the note on ReviewRequest. */
  'approval:grant': { expiresAt: number; target: string };
  'approval:submit': { submitted: boolean; why?: string };
  'approval:revoke': null;
  'approval:status': { active: boolean; remainingMs: number };
  /**
   * `why` is a sentence for the user when nothing was pressed. `reloading`
   * means the page posted back as it was pressed — scan again to continue.
   */
  'approval:upload': { pressed: boolean; why?: string; reloading?: boolean };
  'approval:upload-all': { items: BatchItem[] };
  'audit:read': AuditEntry[];
  'audit:configure': null;
  'audit:settings': AuditSettings;
  'audit:clear': null;
  'llm:status': LlmStatus;
  'llm:set-key': null;
  'llm:set-model': null;
  'llm:reset-usage': null;
  'llm:forget-learned': null;
  'teach:start': TeachSession;
  'teach:stop': null;
  'teach:cancel': null;
  'teach:pick-start': null;
  'teach:pick-stop': null;
  'teach:picked': null;
  'teach:assign': TeachSession;
  'teach:assign-document': TeachSession;
  'teach:forget': TeachSession;
  'teach:save': SavedProfile;
  'teach:session': TeachSession | null;
  'profile:health': ProfileHealth | null;
  'profile:versions': ProfileVersionSummary[];
  'profile:rollback': ProfileVersionSummary | null;
  'profile:export': string;
  'profile:import': { imported: number; rejected: string[] };
  'guard:status': EarlyGuardState;
  'guard:enable': EarlyGuardState;
  'guard:disable': null;
  'guard:origins': string[];
  ping: 'pong';
  'harvest:request': null;
  'harvest:ready': null;
  'run:hello': { tabId: number };
  'run:active': boolean;
  'run:release': null;
  'run:state': null;
  'run:save': null;
  'run:load': PersistedRun | null;
  'run:clear': null;
  'run:continue': null;
  'run:abort': null;
}

export type ResponseFor<T extends RequestType> = ResponseMap[T];

export type Result<T> =
  | { ok: true; data: T }
  /**
   * `code` is for the UI to branch on; `detail` carries the one piece of data
   * the remedy needs — currently the origin pattern to request when a page
   * could not be read for want of permission.
   */
  | { ok: false; error: string; code?: string; detail?: string };

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export interface MessageEnvelope<R extends ExtensionRequest = ExtensionRequest> {
  readonly __af: true;
  readonly at: number;
  readonly payload: R;
}

export function envelope<R extends ExtensionRequest>(payload: R): MessageEnvelope<R> {
  return { __af: true, at: Date.now(), payload };
}

export function isEnvelope(value: unknown): value is MessageEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { __af?: unknown; payload?: unknown };
  if (candidate.__af !== true) return false;
  const payload = candidate.payload as { type?: unknown } | undefined;
  return typeof payload === 'object' && payload !== null && typeof payload.type === 'string';
}

// ---------------------------------------------------------------------------
// Sender checks
// ---------------------------------------------------------------------------

export function isTrustedSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id;
}

/**
 * True only for extension pages. A content script always carries `sender.tab`;
 * the side panel and options page never do.
 */
export function isPrivilegedSender(sender: chrome.runtime.MessageSender): boolean {
  return isTrustedSender(sender) && sender.tab === undefined;
}

export function assertTrustedSender(sender: chrome.runtime.MessageSender): void {
  if (!isTrustedSender(sender)) {
    throw new Error(`Rejected message from untrusted sender: ${sender.id ?? 'unknown'}`);
  }
}

/** Throws if a content script asks for something only an extension page may do. */
export function assertSenderMayRequest(
  type: string,
  sender: chrome.runtime.MessageSender,
): void {
  assertTrustedSender(sender);
  if (PRIVILEGED_TYPES.has(type) && !isPrivilegedSender(sender)) {
    throw new Error(`Rejected privileged request "${type}" from a content script.`);
  }
}
