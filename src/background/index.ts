/**
 * Background service worker.
 *
 * Owns the unlocked vault key (§ Phase 1) and, from Phase 6, run orchestration.
 * It is the single LLM egress point from Phase 8.
 *
 * Every inbound message passes `assertSenderMayRequest`, which rejects both
 * foreign senders and content scripts asking for vault operations.
 */

import {
  assertSenderMayRequest,
  isEnvelope,
  type ExtensionRequest,
  type Result,
} from '@/shared/messages';
import { handleVaultRequest, isVaultRequest } from './vault-service';
import { handleDocumentRequest } from './document-service';
import { harvestTab } from './harvest-service';
import { fillTab, undoFillOnTab } from './fill-service';
import { lockVault } from '@/vault/session';

chrome.runtime.onInstalled.addListener(() => {
  // The panel opens on an explicit user gesture (P1), never on its own.
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

/**
 * Belt-and-braces auto-lock. The worker being suspended already drops the key,
 * but saying so explicitly means the intent survives a future refactor.
 */
chrome.runtime.onSuspend?.addListener(() => {
  lockVault();
});

async function route(request: ExtensionRequest): Promise<Result<unknown>> {
  if (isVaultRequest(request.type)) {
    return handleVaultRequest(request as Parameters<typeof handleVaultRequest>[0]);
  }

  if (request.type.startsWith('doc:')) {
    return handleDocumentRequest(request as Parameters<typeof handleDocumentRequest>[0]);
  }

  switch (request.type) {
    case 'harvest:tab':
      return harvestTab(request.tabId);
    case 'fill:tab':
      return fillTab(request.tabId);
    case 'fill:undo:tab':
      return undoFillOnTab(request.tabId);
    case 'harvest:ready':
      return { ok: true, data: null };
    case 'ping':
      return { ok: true, data: 'pong' };
    default:
      return { ok: false, error: `Unhandled request: ${request.type}` };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isEnvelope(message)) return false;

  try {
    assertSenderMayRequest(message.payload.type, sender);
  } catch (error) {
    console.warn('[autofill] rejected message', error);
    sendResponse({ ok: false, error: 'Rejected.' } satisfies Result<never>);
    return true;
  }

  route(message.payload).then(sendResponse, (error: unknown) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : 'Unexpected error.',
    } satisfies Result<never>);
  });

  // Keep the message channel open for the async response.
  return true;
});
