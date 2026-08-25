/**
 * Typed message bus.
 *
 * Phase 0 defines the envelope and the sender check only. Phase 10 hardens this
 * further (schema-validate every message, reject anything from page context) —
 * the `assertTrustedSender` guard below is the seed of that work, and it is here
 * from the start so no phase accidentally ships an unguarded listener.
 */

import type { FieldDescriptor, RunState } from './types';

export type ExtensionMessage =
  // content -> background
  | { type: 'harvest:result'; fields: FieldDescriptor[] }
  | { type: 'run:state'; state: RunState }
  // background -> content
  | { type: 'harvest:request' }
  | { type: 'run:abort'; why: string }
  // ui -> background
  | { type: 'panel:opened'; tabId: number }
  | { type: 'ping' };

export type MessageType = ExtensionMessage['type'];

export interface MessageEnvelope<M extends ExtensionMessage = ExtensionMessage> {
  /** Guards against page-context messages that happen to match our shape. */
  readonly __af: true;
  readonly at: number;
  readonly payload: M;
}

export function envelope<M extends ExtensionMessage>(payload: M): MessageEnvelope<M> {
  return { __af: true, at: Date.now(), payload };
}

export function isEnvelope(value: unknown): value is MessageEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __af?: unknown }).__af === true &&
    typeof (value as { payload?: unknown }).payload === 'object'
  );
}

/**
 * A message is trusted only if it originates from this extension. Page scripts
 * cannot set `sender.id`, so this rejects the hostile-portal case (§ Phase 10:
 * "treat every portal page as hostile").
 */
export function isTrustedSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id;
}

export function assertTrustedSender(sender: chrome.runtime.MessageSender): void {
  if (!isTrustedSender(sender)) {
    throw new Error(`Rejected message from untrusted sender: ${sender.id ?? 'unknown'}`);
  }
}
