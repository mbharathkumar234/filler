/**
 * The run store (§ Phase 6): the reducer, the storage, and the listeners,
 * joined in the one place that is allowed to know about all three.
 *
 * `machine.ts` stays pure and `persistence.ts` stays dumb; this is the thin
 * seam that says *when* a transition is written down. The rule is the plan's:
 * after every transition, without exception — because the transition that does
 * not get written is the one the postback eats.
 */

import type { FillPlan, RunState } from '@/shared/types';
import { initial, planOf, reduce, type RunEvent } from './machine';
import { loadRun, saveRun, clearRun } from './persistence';

export type RunListener = (state: RunState, event: RunEvent | null) => void;

export class RunStore {
  #state: RunState;
  #listeners = new Set<RunListener>();

  constructor(
    readonly tabId: number,
    readonly formFingerprint: string,
    start: RunState = initial(),
  ) {
    this.#state = start;
  }

  get state(): RunState {
    return this.#state;
  }

  get plan(): FillPlan | null {
    return planOf(this.#state);
  }

  /**
   * Apply an event, persist the result, tell everyone.
   *
   * An event the machine refused is not a transition: the reducer returns the
   * same object by identity, and nothing is written or announced. That keeps
   * `chrome.storage.session` from being rewritten on every mutation a busy
   * page emits.
   */
  async dispatch(event: RunEvent, now: number = Date.now()): Promise<RunState> {
    const next = reduce(this.#state, event, now);
    if (next === this.#state) return next;

    this.#state = next;
    await saveRun(this.tabId, this.formFingerprint, next, now);
    this.#emit(event);
    return next;
  }

  /**
   * Restore this tab's run after a navigation, a postback, or a worker
   * suspension.
   *
   * The stored state is normalised through the reducer on the way in, with a
   * `TIMER_TICK` — an event that is inert everywhere except that it forces the
   * approval TTL to be re-checked. A run that was ARMED when the page unloaded
   * must not come back armed ninety seconds later.
   */
  async hydrate(now: number = Date.now()): Promise<RunState> {
    const record = await loadRun(this.tabId, this.formFingerprint, now);
    if (!record) return this.#state;

    const restored = reduce(record.state, { t: 'TIMER_TICK' }, now);
    this.#state = restored;
    if (restored !== record.state) {
      await saveRun(this.tabId, this.formFingerprint, restored, now);
    }
    this.#emit(null);
    return restored;
  }

  /** Forget this run entirely — the user aborted, or the tab moved on. */
  async reset(now: number = Date.now()): Promise<void> {
    this.#state = initial();
    await clearRun(this.tabId, this.formFingerprint);
    void now;
    this.#emit(null);
  }

  subscribe(listener: RunListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: RunEvent | null): void {
    for (const listener of this.#listeners) {
      // One bad listener must not strand the run in an unannounced state.
      try {
        listener(this.#state, event);
      } catch (error) {
        console.warn('[autofill] run listener threw', error);
      }
    }
  }
}
