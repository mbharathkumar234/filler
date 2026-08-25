/**
 * The page watcher (§ Phase 6).
 *
 *   "MutationObserver + `webNavigation` listeners force `REVERIFYING` on
 *    postback/navigation."
 *
 * ## Two signals, and one that is deliberately missing
 *
 *  - **Churn.** A mutation batch that disconnects more than 20% of the fields
 *    we are tracking is an UpdatePanel refresh, a wizard step, or a re-render.
 *    The threshold is measured against *our* fields rather than the whole
 *    document, because a page that lazy-loads a hundred menu items has not
 *    changed the form at all.
 *  - **Settling.** A quiet period after churn. This is what lets a blocked run
 *    notice the user finished, without polling and without a timer deciding on
 *    the user's behalf (§5 forbids the timer; see `machine.ts`).
 *
 * The missing one is `__doPostBack`. A content script runs in an isolated
 * world and cannot see the page's own functions, so hooking it is not
 * available to us — and reaching into the page world to do it would mean
 * injecting script into a hostile page, which is a bigger risk than the signal
 * is worth. A classic postback navigates, and an asynchronous one replaces
 * enough of the DOM to trip the churn threshold. Both are covered.
 */

import { DRIFT_MUTATION_THRESHOLD } from '@/shared/types';
import type { ChurnKind } from '@/runtime/machine';

/** Quiet period before a page is called settled. */
export const SETTLE_MS = 600;

export interface WatchOptions {
  /** The elements this run cares about. Re-read on every batch. */
  tracked(): Element[];
  /** Fired when the page changed enough to invalidate what we know. */
  onChurn(kind: ChurnKind, ratio: number): void;
  /** Fired once the page has been quiet for `settleMs` after churn. */
  onSettled?(): void;
  settleMs?: number;
  threshold?: number;
  /** Injectable for tests. */
  now?(): number;
}

export interface WatchHandle {
  stop(): void;
  /** Test seam: force an evaluation without waiting for the observer. */
  check(): void;
}

/**
 * Start watching. Returns a handle; call `stop()` when the run ends.
 *
 * The observer is `childList` + `subtree` only. Attribute mutations are the
 * noisiest thing on a live page — every focus ring, every validation class —
 * and none of them mean a field was replaced.
 */
export function watchPage(doc: Document, options: WatchOptions): WatchHandle {
  const settleMs = options.settleMs ?? SETTLE_MS;
  const threshold = options.threshold ?? DRIFT_MUTATION_THRESHOLD;

  // Snapshot what we are tracking now, so "disconnected" is measured against
  // the set that existed before this batch rather than after it.
  let watched = options.tracked();
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const scheduleSettle = (): void => {
    if (!options.onSettled) return;
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      if (!stopped) options.onSettled?.();
    }, settleMs);
  };

  const evaluate = (): void => {
    if (stopped) return;

    const total = watched.length;
    if (total === 0) {
      watched = options.tracked();
      return;
    }

    const gone = watched.filter((el) => !el.isConnected).length;
    const ratio = gone / total;

    if (ratio > threshold) {
      // Re-read: the replacements are the new tracked set, and the next batch
      // must be measured against them or every batch would report churn.
      watched = options.tracked();
      options.onChurn('mutation', ratio);
    }

    scheduleSettle();
  };

  const observer = new doc.defaultView!.MutationObserver(evaluate);
  observer.observe(doc.documentElement, { childList: true, subtree: true });

  /**
   * A real navigation. `pagehide` rather than `beforeunload`: it fires for
   * back/forward-cache navigations too, and it does not make Chrome show the
   * "leave site?" dialog.
   *
   * Nothing is written to storage here — an async write during unload is not
   * reliable, and the run state was already persisted at its last transition.
   * The reload is detected on the far side instead, when a fresh content
   * script hydrates a run that thinks it is mid-fill.
   */
  const onPageHide = (): void => {
    options.onChurn('navigation', 1);
  };
  doc.defaultView?.addEventListener('pagehide', onPageHide);

  return {
    stop() {
      stopped = true;
      observer.disconnect();
      if (settleTimer !== null) clearTimeout(settleTimer);
      doc.defaultView?.removeEventListener('pagehide', onPageHide);
    },
    check: evaluate,
  };
}

/**
 * Did this document just load, as opposed to being re-injected into?
 *
 * The content script is injected on every user gesture, so it must be able to
 * tell "the user pressed the button again" from "the page came back from a
 * postback". The marker lives on `window`, which a navigation destroys and a
 * re-injection does not.
 */
export function isFreshDocument(win: Window & { __autofillContentReady?: boolean }): boolean {
  return win.__autofillContentReady !== true;
}
