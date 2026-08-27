/**
 * The run controller (§ Phase 6).
 *
 * Everything about pausing, resuming, and drift recovery lives here rather
 * than in `content/index.ts`, for one reason: `index.ts` cannot run outside a
 * real extension — it needs `chrome.runtime` on the first line — and the plan
 * requires this behaviour to be tested against a fixture page twenty times
 * over without flaking. Ports in, no globals reached for, so the same code
 * that ships is the code Playwright drives.
 *
 * It owns four things and delegates the rest:
 *
 *  - the `RunStore` (reducer + persistence),
 *  - the `MutationObserver` that notices a postback,
 *  - the blocker check that hands control to the user,
 *  - the expectations map: what we last wrote, in memory only.
 */

import type { FillPlan, ReviewDiff, RunState } from '@/shared/types';
import { mayWritePage } from '@/runtime/machine';
import { RunStore, type RunPersistence } from '@/runtime/store';
import { blockerCleared, detectBlockers, primaryBlocker, type BlockerFinding } from './blockers';
import { readValue, reverify, type PlannedRef } from './reverify';
import { watchPage, type WatchHandle } from './watcher';
import type { OverlayStatus } from './overlay';

export interface RefillOutcome {
  ok: boolean;
  error?: string;
}

export interface ControllerPorts {
  tabId: number;
  doc: Document;
  /** Resolve a plan ref to a live element. */
  resolve(ref: string): Element | null;
  /** Ask the worker to re-send values for fields the page reset. */
  requestRefill(refs: string[]): Promise<RefillOutcome>;
  /** Announce a transition (to the panel). */
  onState?(state: RunState): void;
  /** Drive the in-page status pill. */
  onStatus?(status: OverlayStatus, detail?: string): void;
  /** A human-only step: show the pause panel with this exact instruction. */
  onPause?(finding: BlockerFinding): void;
  /** The pause is over. */
  onResume?(): void;
  /** Was this document freshly loaded, rather than re-injected into? */
  reloaded?: boolean;
  /**
   * Where the run is written down.
   *
   * Supplied by the caller because a content script cannot reach
   * `chrome.storage.session` — it is trusted-context only — and must ask the
   * worker instead. Tests and the worker pass nothing and get the direct
   * implementation.
   */
  persistence?: RunPersistence;
}

export class RunController {
  #store: RunStore | null = null;
  #watcher: WatchHandle | null = null;
  #blocker: BlockerFinding | null = null;
  /**
   * What we last wrote, per ref. In memory only and never persisted: it is
   * the sole place in a run that holds real values, and it dies with the
   * document by design.
   */
  #expectations = new Map<string, string>();

  constructor(private readonly ports: ControllerPorts) {}

  get state(): RunState {
    return this.#store?.state ?? { t: 'IDLE' };
  }

  get plan(): FillPlan | null {
    return this.#store?.plan ?? null;
  }

  get blocker(): BlockerFinding | null {
    return this.#blocker;
  }

  /**
   * Attach to this form's run, resuming one already under way.
   *
   * The `reloaded` flag is the postback detector. A run that was FILLING when
   * the document went away is a run whose page has been rebuilt, so it is
   * pushed into REVERIFYING rather than trusted — §5's "any document
   * navigation … forces → REVERIFYING", detected on the far side of the
   * navigation, because that is the only side that still exists.
   */
  async attach(formFingerprint: string): Promise<RunState> {
    if (this.#store?.formFingerprint === formFingerprint) return this.#store.state;

    this.#watcher?.stop();
    this.#store = new RunStore(
      this.ports.tabId,
      formFingerprint,
      undefined,
      this.ports.persistence,
    );
    this.#store.subscribe((state) => this.ports.onState?.(state));

    const restored = await this.#store.hydrate();
    if (restored.t !== 'IDLE' && this.ports.reloaded === true) {
      await this.#store.dispatch({ t: 'DOM_CHURN', kind: 'navigation' });
    }

    this.#startWatching();
    if (!(await this.checkBlockers()) && this.state.t === 'REVERIFYING') {
      await this.reverifyNow();
    }
    return this.state;
  }

  /** Walk a fresh plan to READY. */
  async setPlan(plan: FillPlan): Promise<RunState> {
    const store = this.#require();
    if (store.state.t === 'IDLE') {
      await store.dispatch({ t: 'DETECT' });
      await store.dispatch({ t: 'FIELDS_FOUND', fields: [] });
    }
    return store.dispatch({ t: 'PLAN_READY', plan });
  }

  /**
   * May we start writing?
   *
   * Returns false when the run is blocked, drifted, or waiting on a review —
   * one predicate (`mayWritePage`), asked in one place, so "the extension
   * stops touching the page" is a fact about the code rather than a habit.
   */
  async beginFill(): Promise<boolean> {
    const store = this.#store;
    if (!store) return true; // No run attached: Phase 5 behaviour, unchanged.

    if (await this.checkBlockers()) return false;
    if (!mayWritePage(store.state)) await store.dispatch({ t: 'FILL_START' });
    return mayWritePage(store.state);
  }

  /** True once a blocker has stopped the run — the fill loop checks this. */
  get halted(): boolean {
    return this.state.t === 'BLOCKED';
  }

  /**
   * Record what actually landed in each field.
   *
   * Read back from the DOM rather than taken from what we sent: the page may
   * have trimmed, upper-cased or truncated it, and comparing against the sent
   * value later would decide the page had reset a field it merely tidied.
   */
  remember(refs: readonly string[]): void {
    for (const ref of refs) {
      const el = this.ports.resolve(ref);
      if (el) this.#expectations.set(ref, readValue(el));
    }
  }

  forget(): void {
    this.#expectations.clear();
  }

  /**
   * Look for a human-only step and stop if there is one.
   *
   * P4, mechanically: notice, explain, wait. Nothing here reads the challenge
   * — `blockers.ts` is not capable of it, and its test asserts that against
   * the file's own source.
   */
  async checkBlockers(): Promise<boolean> {
    const store = this.#store;
    if (!store) return false;

    const finding = primaryBlocker(detectBlockers(this.ports.doc));
    if (!finding) return false;

    this.#blocker = finding;
    const next = await store.dispatch({ t: 'BLOCKER_SEEN', reason: finding.type });
    if (next.t === 'BLOCKED') this.ports.onPause?.(finding);
    return next.t === 'BLOCKED';
  }

  /**
   * The user says they have done their part.
   *
   * Note what this does *not* do: take their word for it and carry on filling.
   * It moves to re-verification, which walks the page as it now stands — and
   * if the CAPTCHA is still there, blocks again immediately.
   */
  async userContinue(): Promise<RunState> {
    const store = this.#require();
    this.#blocker = null;
    this.ports.onResume?.();
    const next = await store.dispatch({ t: 'USER_CONTINUE' });
    if (next.t === 'REVERIFYING') await this.reverifyNow();
    return this.state;
  }

  /**
   * Walk every planned field against the live DOM.
   *
   * Three outcomes, exactly §5's: a lost selector escalates to DRIFTED, a
   * reset value goes back to FILLING via a refill, an intact form to REVIEW.
   */
  async reverifyNow(): Promise<RunState> {
    const store = this.#require();
    const plan = store.plan;
    if (!plan) return store.state;

    // A blocker takes precedence: re-verifying a page that is still waiting on
    // a CAPTCHA only re-verifies a page that has not changed yet.
    if (await this.checkBlockers()) return store.state;

    // Enter re-verification first. The reducer only accepts `REVERIFIED` from
    // `REVERIFYING`, so calling this straight out of `FILLING` — which is what
    // "check the page now" means from anywhere else — would do the work, act
    // on the answer, and have the transition quietly refused, leaving the run
    // claiming to be mid-fill forever. A direct call *is* an assertion that
    // the page may have changed underneath us, so it is announced as churn.
    if (store.state.t !== 'REVERIFYING') {
      const entered = await store.dispatch({ t: 'DOM_CHURN', kind: 'postback' });
      if (entered.t !== 'REVERIFYING') return entered;
    }

    this.ports.onStatus?.('checking', 'Checking what survived.');

    const refs: PlannedRef[] = plan.fields.map((field) => {
      const expected = this.#expectations.get(field.fieldRef);
      return {
        ref: field.fieldRef,
        selectors: field.selectors,
        ...(expected === undefined ? {} : { expected }),
      };
    });

    const result = reverify(refs, this.ports.doc);

    if (result.lost.length > 0) {
      await store.dispatch({ t: 'DRIFT', lost: result.lost });
      this.ports.onStatus?.(
        'paused',
        `${result.lost.length} field(s) could not be found on the page.`,
      );
      return store.state;
    }

    await store.dispatch({
      t: 'REVERIFIED',
      plan,
      needsRefill: result.needsRefill,
      diff: diffFrom(plan, result.requiredButEmpty),
    });

    if (result.needsRefill.length > 0) {
      this.ports.onStatus?.(
        'filling',
        `Restoring ${result.needsRefill.length} field(s) the page reset.`,
      );
      const outcome = await this.ports.requestRefill(result.needsRefill);
      if (!outcome.ok) {
        this.ports.onStatus?.('paused', outcome.error ?? 'The refill could not be completed.');
      }
    } else {
      this.ports.onStatus?.('review', 'Everything survived — review in the side panel.');
    }

    return store.state;
  }

  /** Everything the run wrote is now under review. */
  async toReview(): Promise<RunState> {
    const store = this.#require();
    const plan = store.plan;
    if (!plan) return store.state;
    return store.dispatch({ t: 'REVIEW_READY', diff: diffFrom(plan, []) });
  }

  async abort(why: string): Promise<void> {
    this.#watcher?.stop();
    this.#watcher = null;
    await this.#store?.dispatch({ t: 'ABORT', why });
  }

  detach(): void {
    this.#watcher?.stop();
    this.#watcher = null;
  }

  /** Test seam: evaluate the watcher now rather than waiting for a batch. */
  checkPageNow(): void {
    this.#watcher?.check();
  }

  // -------------------------------------------------------------------------

  #startWatching(): void {
    this.#watcher?.stop();
    this.#watcher = watchPage(this.ports.doc, {
      tracked: () => this.#trackedElements(),
      onChurn: (kind, ratio) => {
        void this.#onChurn(kind, ratio);
      },
      onSettled: () => {
        void this.#onSettled();
      },
    });
  }

  #trackedElements(): Element[] {
    const refs = this.plan?.fields.map((field) => field.fieldRef) ?? [];
    return refs
      .map((ref) => this.ports.resolve(ref))
      .filter((el): el is Element => el !== null);
  }

  async #onChurn(kind: 'navigation' | 'postback' | 'mutation', ratio: number): Promise<void> {
    const store = this.#store;
    if (!store) return;
    const next = await store.dispatch({ t: 'DOM_CHURN', kind, ratio });
    if (next.t === 'REVERIFYING') await this.reverifyNow();
  }

  /**
   * The page has gone quiet.
   *
   * Only interesting while BLOCKED: it is how a paused run notices the user
   * finished without making them press anything. `blockerCleared` is what
   * stops it firing while they are still working — a CAPTCHA widget mutates
   * constantly, and §5 forbids resuming on a timer.
   */
  async #onSettled(): Promise<void> {
    const store = this.#store;
    const state = store?.state;
    if (!store || state?.t !== 'BLOCKED') return;

    const gone = blockerCleared(state.reason, this.ports.doc);
    const next = await store.dispatch({ t: 'DOM_SETTLED', blockerGone: gone });
    if (next.t === 'REVERIFYING') {
      this.#blocker = null;
      this.ports.onResume?.();
      await this.reverifyNow();
    }
  }

  #require(): RunStore {
    if (!this.#store) throw new Error('No run attached. Call attach() first.');
    return this.#store;
  }
}

function diffFrom(plan: FillPlan, requiredButEmpty: string[]): ReviewDiff {
  return {
    lowConfidence: plan.fields.filter((f) => f.confidence < 0.85).map((f) => f.fieldRef),
    truncated: plan.fields.filter((f) => f.truncated === true).map((f) => f.fieldRef),
    fuzzySelect: [],
    fillFailed: plan.fields.filter((f) => f.fillFailed === true).map((f) => f.fieldRef),
    requiredButEmpty,
  };
}
