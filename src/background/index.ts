/**
 * Background service worker.
 *
 * Phase 0 scope: open the side panel on the action click and answer a ping.
 * Run orchestration lands in Phase 6; the single LLM egress point in Phase 8.
 */

import { assertTrustedSender, envelope, isEnvelope } from '@/shared/messages';

chrome.runtime.onInstalled.addListener(() => {
  // The panel is opened by an explicit user gesture (P1), never automatically.
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    assertTrustedSender(sender);
  } catch (err) {
    console.warn('[autofill] dropped message', err);
    return false;
  }

  if (!isEnvelope(message)) return false;

  switch (message.payload.type) {
    case 'ping':
      sendResponse(envelope({ type: 'ping' }));
      return true;
    default:
      return false;
  }
});
