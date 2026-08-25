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

import type { FieldKey } from '@/matching/taxonomy';
import type { RunState } from './types';
import type { ProfileEntry } from '@/vault/profile-store';
import type { Completeness } from '@/vault/profile-store';
import type { VaultStatus } from '@/vault/session';
import type { ImportResult } from '@/vault/backup-format';
import type { DocConstraint } from './types';
import type { DocumentSummary } from '@/vault/document-store';
import type { DerivedPayload } from '@/background/document-service';
import type { TabHarvest } from '@/background/harvest-service';
import type { FillReport, WriteInstruction } from '@/background/fill-service';
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
  | { type: 'vault:set'; key: FieldKey; value: string }
  | { type: 'vault:delete'; key: FieldKey }
  | { type: 'vault:completeness' }
  | { type: 'vault:export' }
  | { type: 'vault:import'; text: string; passphrase: string }
  | { type: 'vault:touch' }
  /** § Phase 6 re-auth gate: prove it is still the same person at the desk. */
  | { type: 'vault:reauth'; passphrase: string };

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
    }
  | { type: 'doc:delete'; id: string }
  | { type: 'doc:derive'; key: FieldKey; constraint: DocConstraint }
  | { type: 'doc:preflight'; key: FieldKey; constraint: DocConstraint };

export type RuntimeRequest =
  | { type: 'ping' }
  | { type: 'harvest:request' }
  | { type: 'harvest:ready' }
  /** Content script asking the worker which tab it is in (§ Phase 6 run keys). */
  | { type: 'run:hello' }
  | { type: 'run:state'; state: RunState }
  /** The user pressed "I have completed this" — in the panel or the overlay. */
  | { type: 'run:continue' }
  | { type: 'run:abort'; why: string };

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
  | { type: 'fill:apply'; writes: WriteInstruction[] }
  | { type: 'fill:undo' }
  | { type: 'fill:refill'; refs: string[] }
  | { type: 'fill:submit'; token: ApprovalToken };

export type ExtensionRequest =
  | VaultRequest
  | DocumentRequest
  | HarvestRequest
  | FillRequest
  | RuntimeRequest;
export type RequestType = ExtensionRequest['type'];

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
  'vault:export',
  'vault:import',
  'vault:touch',
  'vault:reauth',
  'doc:list',
  'doc:put',
  'doc:delete',
  'doc:derive',
  'doc:preflight',
  'harvest:tab',
  'fill:tab',
  'fill:undo:tab',
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
  'vault:export': string;
  /** null means a wrong passphrase for the backup file. */
  'vault:import': ImportResult | null;
  'vault:touch': null;
  /** false means a wrong passphrase — the gate stays shut. */
  'vault:reauth': boolean;
  'doc:list': DocumentSummary[];
  'doc:put': DocumentSummary;
  'doc:delete': null;
  /** A derived file, or a readable explanation of why it could not be made. */
  'doc:derive': DerivedPayload | { failed: true; reason: string; code: string };
  'doc:preflight': { ok: boolean; warnings: string[]; reason?: string };
  'harvest:tab': TabHarvest;
  'fill:tab': FillReport;
  'fill:undo:tab': { restored: number };
  'fill:apply': { records: FillReport['records']; aborted: boolean; blocked: number };
  'fill:undo': { restored: number };
  'fill:refill': FillReport;
  'fill:submit': { submitted: boolean };
  ping: 'pong';
  'harvest:request': null;
  'harvest:ready': null;
  'run:hello': { tabId: number };
  'run:state': null;
  'run:continue': null;
  'run:abort': null;
}

export type ResponseFor<T extends RequestType> = ResponseMap[T];

export type Result<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };

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
