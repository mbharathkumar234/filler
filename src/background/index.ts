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
  OFFSCREEN_TYPES,
  assertSenderMayRequest,
  envelope,
  isEnvelope,
  type ExtensionRequest,
  type Result,
} from '@/shared/messages';
import { handleVaultRequest, isVaultRequest } from './vault-service';
import { handleDocumentRequest, setOcrEngine } from './document-service';
import { createOcrHost } from './ocr-host';
import { forgetHarvest, harvestTab } from './harvest-service';
import { putInUploadWindow } from './upload-window-service';
import {
  authorisedRun,
  endRun,
  fillTab,
  liveRunTabs,
  onRunEnded,
  refillTab,
  undoFillOnTab,
} from './fill-service';
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
  uploadAllWithApproval,
  uploadWithApproval,
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
import {
  cancelTeaching,
  exportLearned,
  forgetPick,
  importLearned,
  healthFor,
  recordDocumentPick,
  recordPick,
  rollback,
  saveTeaching,
  startTeaching,
  stopTeaching,
  teachSession,
  versionsFor,
} from './teach-service';
import { beginRun, endRunLimit, mayStartRun } from './limits';
import { validateRequest } from '@/shared/validate';
import {
  grantedOrigins,
  originPattern,
  requestPermission,
  revokePermission,
  statusFor,
  syncFor,
  unregister,
  unregisterAll,
} from './early-guard';
import { clearRun, clearTab, loadRun, pruneRuns, saveRun } from '@/runtime/persistence';
import type { RunState } from '@/shared/types';
import { lockVault } from '@/vault/session';

/**
 * Applied on every worker start, not only on install.
 *
 * The setting persists across restarts, so an extension already carrying the
 * old `true` would keep swallowing action clicks until it was reinstalled —
 * which is exactly the state a user hitting this bug is already in.
 */
function setPanelBehaviour(): Promise<void> {
  return chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
}

void setPanelBehaviour();

/*
 * The document reader, installed once.
 *
 * Until now `setOcrEngine` had no caller and every photograph came back with
 * "reading text from photographs is not available in this build". The engine
 * runs in an offscreen document and loads only files from this package.
 */
setOcrEngine(createOcrHost());

chrome.runtime.onInstalled.addListener(() => {
  /*
   * Open the panel ourselves rather than letting Chrome do it.
   *
   * This looks like a step backwards and is the opposite. With
   * `openPanelOnActionClick: true` Chrome opens the panel *instead of*
   * dispatching the click, so `chrome.action.onClicked` never fires — and a
   * click that never reaches the extension never counts as invoking it. That
   * is precisely the event that grants `activeTab`.
   *
   * The consequence was that this extension could not obtain `activeTab` at
   * all: pressing Scan on any ordinary web page failed with "Cannot access
   * contents of the page", and clicking the icon — the advice the panel itself
   * gave — did nothing to change that, because the click was being swallowed.
   *
   * Handling the click ourselves grants `activeTab` and opens the panel, which
   * is what the user expected the icon to do all along. P1 is unaffected: the
   * panel still opens only on a deliberate click.
   */
  void setPanelBehaviour();
  // § Phase B: start from a known state. An early-guard registration that
  // survived an update would be a content script the user never re-authorised.
  void unregisterAll().catch(() => {});
});

/**
 * The toolbar click: grant `activeTab`, then show the panel.
 *
 * `chrome.sidePanel.open()` must be called inside the gesture, so it is the
 * first thing here — anything awaited before it loses the gesture and the panel
 * silently fails to open.
 *
 * Merely *receiving* this event is what grants `activeTab` for the tab, which
 * is why the listener matters even though its body is one line.
 */
chrome.action?.onClicked?.addListener((tab) => {
  const options = tab.id === undefined ? { windowId: tab.windowId } : { tabId: tab.id };
  void chrome.sidePanel.open(options).catch(() => {
    // Opening can fail if the gesture has expired or the tab has gone. There is
    // nothing useful to do about it, and throwing here would leave an unhandled
    // rejection in the worker for a click the user can simply repeat.
  });
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
/*
 * When a run ends, give the page back.
 *
 * The guard on the page disengages, and the per-origin document_start script
 * is unregistered — unless another tab is mid-run on the same site. Before
 * this the script stayed registered for the rest of the browser session, and
 * because an origin pattern covers every port of a host, one fill on a local
 * test portal locked the login of a different local project, on a page the
 * extension had never been opened on.
 */
onRunEnded((tabId) => {
  void releaseRun(tabId).catch(() => {});
});

async function releaseRun(tabId: number): Promise<void> {
  await chrome.tabs
    .sendMessage(tabId, envelope({ type: 'run:release' }), { frameId: 0 })
    .catch(() => {
      // The tab is gone or never had our script. Nothing to hand back.
    });

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const pattern = originPattern(tab?.url ?? '');
  if (!pattern) return;

  for (const other of liveRunTabs()) {
    if (other === tabId) continue;
    const otherTab = await chrome.tabs.get(other).catch(() => null);
    if (originPattern(otherTab?.url ?? '') === pattern) return;
  }
  await unregister(pattern);
}

chrome.tabs?.onRemoved.addListener((tabId) => {
  endRun(tabId);
  endRunLimit(tabId);
  cancelTeaching(tabId);
  // An approval is for one form in one tab. The tab is gone, so is the form.
  revokeApproval(tabId);
  forgetTabReview(tabId);
  forgetHarvest(tabId);
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

  // Reaches into a tab, so it is not the document store's to handle.
  if (request.type === 'doc:to-window') {
    return putInUploadWindow(request.tabId, request.slotRef, request.mode ?? 'box', request.key);
  }

  if (request.type.startsWith('doc:')) {
    return handleDocumentRequest(request as Parameters<typeof handleDocumentRequest>[0]);
  }

  switch (request.type) {
    case 'harvest:tab':
      return harvestTab(request.tabId);
    case 'fill:tab': {
      // § Phase 10 — P1/P6. Checked before any value leaves the worker, so a
      // refusal costs nothing and reveals nothing.
      const allowed = mayStartRun(request.tabId);
      if (!allowed.allowed) {
        return {
          ok: false,
          error: allowed.message ?? 'Refused.',
          ...(allowed.why === undefined ? {} : { code: allowed.why }),
        };
      }
      beginRun(request.tabId);
      try {
        // § Phase B: if the user has granted this origin, make sure the
        // document_start guard is registered before we put values in the page.
        // The window this closes is the *next* load, which is exactly when a
        // postback would return the page carrying what we filled.
        const tab = await chrome.tabs.get(request.tabId).catch(() => null);
        if (tab?.url) await syncFor(tab.url).catch(() => undefined);

        return await fillTab(request.tabId);
      } finally {
        endRunLimit(request.tabId);
      }
    }
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

    /*
     * Run persistence, on behalf of a content script.
     *
     * `chrome.storage.session` is trusted-context only. A content script asking
     * for it directly gets "Access to storage is not allowed from this
     * context", which is what stopped every scan on a real page. The worker is
     * a trusted context, so it does the storing.
     *
     * `tabId` comes from `sender`, never from the message. A content script
     * therefore cannot read or overwrite another tab's run by asking nicely.
     */
    case 'run:save':
      if (tabId === null) return { ok: false, error: 'Not in a tab.' };
      await saveRun(tabId, request.fingerprint, request.state as RunState, Date.now());
      return { ok: true, data: null };

    case 'run:load': {
      if (tabId === null) return { ok: false, error: 'Not in a tab.' };
      const record = await loadRun(tabId, request.fingerprint, Date.now());
      if (record === null) return { ok: true, data: null };

      /*
       * Strip the approval token.
       *
       * A persisted `ARMED` state carries a live token, and this reply goes to
       * a content script — which runs inside whatever page the user is on. The
       * content script has no use for it either: the token reaches the guard
       * through `fill:submit` from the panel, never from storage. Handing it
       * back here would turn a convenience into a P2 bypass.
       */
      return {
        ok: true,
        data: {
          ...record,
          state:
            record.state.t === 'ARMED' ? { ...record.state, approvalToken: '' } : record.state,
        },
      };
    }

    case 'run:clear':
      if (tabId === null) return { ok: false, error: 'Not in a tab.' };
      await clearRun(tabId, request.fingerprint);
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
    case 'approval:upload':
      return uploadWithApproval(request.tabId, request.ref);
    case 'approval:upload-all':
      return uploadAllWithApproval(request.tabId, request.picks ?? {});

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

    // § Phase 9 — teach mode.
    case 'teach:start':
      return startTeaching(request.tabId);
    case 'teach:stop':
      return stopTeaching(request.tabId);
    case 'teach:cancel':
      cancelTeaching(request.tabId);
      void stopTeaching(request.tabId);
      return { ok: true, data: null };
    case 'teach:session':
      return { ok: true, data: teachSession(request.tabId) };
    case 'teach:picked':
      // Broadcast from the content script; the panel is the real listener.
      // Acknowledged here so it does not fall through to "unhandled".
      return { ok: true, data: null };
    case 'teach:assign':
      return recordPick(request.tabId, {
        ref: request.ref,
        key: request.key,
        selectors: request.selectors,
        label: request.label,
      });
    case 'teach:assign-document':
      return recordDocumentPick(request.tabId, {
        ref: request.ref,
        key: request.key,
        selectors: request.selectors,
        label: request.label,
        constraint: request.constraint,
      });
    case 'teach:forget':
      return forgetPick(request.tabId, request.key);
    case 'teach:save':
      return saveTeaching(request.tabId);
    case 'profile:health':
      return healthFor(request.tabId);
    case 'profile:versions':
      return { ok: true, data: await versionsFor(request.fingerprint) };
    case 'profile:rollback':
      return rollback(request.fingerprint);
    case 'profile:export':
      return { ok: true, data: await exportLearned() };
    case 'profile:import':
      return importLearned(request.text);

    // § Phase B — the document_start guard, per origin, opt-in.
    case 'guard:status': {
      const tab = await chrome.tabs.get(request.tabId).catch(() => null);
      return { ok: true, data: await statusFor(tab?.url ?? '') };
    }
    case 'guard:enable': {
      const tab = await chrome.tabs.get(request.tabId).catch(() => null);
      const pattern = originPattern(tab?.url ?? '');
      if (!pattern) {
        return { ok: false, error: 'This page cannot be protected — it is not an ordinary web page.' };
      }
      // Requires a user gesture; the panel calls this from a click.
      await requestPermission(pattern);
      return { ok: true, data: await syncFor(tab?.url ?? '') };
    }
    case 'guard:disable':
      await revokePermission(request.origin);
      return { ok: true, data: null };
    case 'guard:origins':
      return { ok: true, data: await grantedOrigins() };

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
    // The document_start guard asking about its own tab, and only its own.
    case 'run:active':
      return { ok: true, data: tabId !== null && authorisedRun(tabId) !== null };
    case 'ping':
      return { ok: true, data: 'pong' };
    default:
      return { ok: false, error: `Unhandled request: ${request.type}` };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isEnvelope(message)) return false;

  /*
   * Not every extension message is for the worker.
   *
   * `ocr:recognise` and the `pdf:*` requests are addressed to the offscreen
   * page (`OFFSCREEN_TYPES`), and every extension context hears every
   * `runtime.sendMessage`. Answering it here would be
   * answering on the reader's behalf — and because the worker replies in
   * microseconds while reading a page takes seconds, the worker's answer is
   * the one the sender gets. That is what it did: "Rejected.", every time,
   * while the reader was still working and about to succeed.
   */
  if (OFFSCREEN_TYPES.has(message.payload.type)) return false;

  try {
    assertSenderMayRequest(message.payload.type, sender);
  } catch (error) {
    console.warn('[autofill] rejected message', error);
    sendResponse({ ok: false, error: 'Rejected.' } satisfies Result<never>);
    return true;
  }

  // § Phase 10 — schema validation, after the sender checks and before any
  // handler. The realistic attacker is a compromised content script: it is a
  // legitimate sender, so the sender check says yes to everything it sends.
  const shape = validateRequest(message.payload);
  if (!shape.ok) {
    console.warn('[autofill] malformed message:', shape.reason);
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
