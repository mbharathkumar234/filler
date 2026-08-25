/**
 * Typed client for talking to the background service worker from extension UI.
 *
 * Passphrases cross this boundary. That is acceptable — both ends are extension
 * contexts and the message never enters a page — but it is the reason the UI
 * must never hold a passphrase in state longer than the submit that uses it.
 */

import {
  envelope,
  type ExtensionRequest,
  type RequestType,
  type ResponseFor,
  type Result,
} from '@/shared/messages';

export class RequestFailed extends Error {
  override readonly name = 'RequestFailed';
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Send a request and unwrap the result, throwing on failure. */
export async function send<R extends ExtensionRequest>(
  request: R,
): Promise<ResponseFor<R['type']>> {
  const result = (await chrome.runtime.sendMessage(envelope(request))) as
    | Result<ResponseFor<R['type']>>
    | undefined;

  if (!result) {
    throw new RequestFailed('No response from the extension background worker.');
  }
  if (!result.ok) {
    throw new RequestFailed(result.error, result.code);
  }
  return result.data;
}

/** True when a thrown error means "the vault locked while you were working". */
export function isLockedError(error: unknown): boolean {
  return error instanceof RequestFailed && error.code === 'VAULT_LOCKED';
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

export type { RequestType };
