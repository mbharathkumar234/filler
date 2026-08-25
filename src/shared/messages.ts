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
import type { FieldDescriptor, RunState } from './types';
import type { ProfileEntry } from '@/vault/profile-store';
import type { Completeness } from '@/vault/profile-store';
import type { VaultStatus } from '@/vault/session';
import type { ImportResult } from '@/vault/backup-format';

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
  | { type: 'vault:touch' };

export type RuntimeRequest =
  | { type: 'ping' }
  | { type: 'harvest:result'; fields: FieldDescriptor[] }
  | { type: 'harvest:request' }
  | { type: 'run:state'; state: RunState }
  | { type: 'run:abort'; why: string };

export type ExtensionRequest = VaultRequest | RuntimeRequest;
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
  ping: 'pong';
  'harvest:result': null;
  'harvest:request': null;
  'run:state': null;
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
