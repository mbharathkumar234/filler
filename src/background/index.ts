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
import { endRun, fillTab, refillTab, undoFillOnTab } from './fill-service';
import {
  buildReviewForTab,
  editFieldOnTab,
  forgetTabReview,
  highlightFieldOnTab,
} from './review-service';
import {
  approvalStatus,
  grantApproval,
  revokeApproval,
  submitWithApproval,
} from './approval-service';
import {
  appendAudit,
  clearAuditLog,
  getAuditSettings,
  readAudit,
  setAuditSettings,
} from '@/runtime/audit';
import { llmStatus, resetUsage, setApiKey, setModel } from './llm-service';
import { forgetLearned } from '@/matching/learned-profiles';
import { clearTab, pruneRuns } from '@/runtime/persistence';
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

/**
 * Tab lifecycle (§ Phase 6).
 *
 * A closed tab's run is over: its state is dropped and its refill
 * authorisation revoked. §5's "any state → ABORTED on … tab close" is this,
 * plus the reducer's own ABORT — the state cannot be transitioned once the
 * document holding it is gone, so the record is removed instead.
 *
 * `chrome.tabs.onRemoved` rather than `chrome.webNavigation`: the plan names
 * webNavigation, but its events are filtered by host permissions and this
 * extension deliberately declares none (`host_permissions: []`, injection on
 * an explicit gesture via `activeTab`). Asking for webNavigation would widen
 * the manifest to buy a signal `tabs.onRemoved` and the content script's own
 * `pagehide` already give us.
 */
chrome.tabs?.onRemoved.addListener((tabId) => {
  endRun(tabId);
  // An approval is for one form in one tab. The tab is gone, so is the form.
  revokeApproval(tabId);
  forgetTabReview(tabId);
  void clearTab(tabId).catch(() => {
    // The tab is gone; a failed cleanup is not worth surfacing.
  });
});

chrome.runtime.onStartup?.addListener(() => {
  void pruneRuns().catch(() => {});
});

async function route(request: ExtensionRequest, tabId: number | null): Promise<Result<unknown>> {
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
    case 'fill:refill':
      // Content-script originated; `refillTab` is where it is contained.
      return tabId === null
        ? { ok: false, error: 'A refill can only come from a tab.' }
        : refillTab(tabId, request.refs);
    case 'run:hello':
      return tabId === null
        ? { ok: false, error: 'Not in a tab.' }
        : { ok: true, data: { tabId } };
    case 'run:state':
      // The panel subscribes to these; the worker only relays.
      return { ok: true, data: null };
    case 'review:build':
      return buildReviewForTab(request.tabId);
    case 'field:highlight':
      return highlightFieldOnTab(request.tabId, request.ref);
    case 'field:edit':
      return editFieldOnTab({
        tabId: request.tabId,
        ref: request.ref,
        value: request.value,
        ...(request.saveKey === undefined ? {} : { saveKey: request.saveKey }),
      });

    case 'approval:grant':
      return grantApproval(request.tabId);
    case 'approval:submit':
      return submitWithApproval(request.tabId);
    case 'approval:revoke':
      revokeApproval(request.tabId);
      return { ok: true, data: null };
    case 'approval:status':
      return { ok: true, data: approvalStatus(request.tabId) };

    case 'audit:read':
      return { ok: true, data: await readAudit(request.limit) };
    case 'audit:settings':
      return { ok: true, data: await getAuditSettings() };
    case 'audit:configure':
      await setAuditSettings({ logValues: request.logValues });
      return { ok: true, data: null };
    case 'audit:clear':
      await clearAuditLog();
      return { ok: true, data: null };

    case 'llm:status':
      return { ok: true, data: await llmStatus() };
    case 'llm:set-key':
      await setApiKey(request.apiKey);
      return { ok: true, data: null };
    case 'llm:set-model':
      await setModel(request.model);
      return { ok: true, data: null };
    case 'llm:reset-usage':
      await resetUsage();
      return { ok: true, data: null };
    case 'llm:forget-learned':
      await forgetLearned();
      return { ok: true, data: null };

    case 'run:abort':
      if (tabId !== null) {
        endRun(tabId);
        revokeApproval(tabId);
        forgetTabReview(tabId);
        void clearTab(tabId).catch(() => {});
        void appendAudit({
          site: '',
          formFingerprint: '',
          event: { t: 'run.aborted', why: request.why },
        }).catch(() => {});
      }
      return { ok: true, data: null };
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

  // The tab a content script is speaking from. Chrome sets this; a page
  // cannot forge it, which is what makes it usable as a run identity.
  const tabId = sender.tab?.id ?? null;

  route(message.payload, tabId).then(sendResponse, (error: unknown) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : 'Unexpected error.',
    } satisfies Result<never>);
  });

  // Keep the message channel open for the async response.
  return true;
});
