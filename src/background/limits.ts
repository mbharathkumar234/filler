/**
 * Rate and scope limits (§ Phase 10) — P1 and P6, enforced rather than assumed.
 *
 *   "Rate/scope limits enforcing P1 and P6: one active run per tab, hard cap on
 *    runs per hour, no headless entry point."
 *
 * ## What these are and are not for
 *
 * Not abuse prevention — the user is the only person here, and they are not
 * attacking themselves. These exist so that **the product cannot become the
 * thing it promised not to be**, by accident or by a future contributor's
 * enthusiasm. P1 says a human is present at the keyboard; P6 says one account,
 * one user. A caps-off build with a scripted driver would satisfy every other
 * test in this repository while being exactly the unattended bulk-submission
 * bot the plan forbids.
 *
 * So the limits are set where a real person will never touch them and a script
 * will hit them immediately. Twenty runs an hour is more forms than anybody
 * fills by hand in a day; it is a rounding error to a loop.
 */

/** P1: a person filling forms by hand does not exceed this. A script does. */
export const MAX_RUNS_PER_HOUR = 20;

/** The window the cap is measured over. */
export const RUN_WINDOW_MS = 60 * 60 * 1000;

/**
 * P1: how long a single run may sit "active" before we stop believing in it.
 *
 * A run is released when it finishes; this only matters when a worker was
 * suspended mid-run and nothing ever released it.
 */
export const RUN_LEASE_MS = 30 * 60 * 1000;

export type LimitRefusal = 'run-in-progress' | 'hourly-cap';

export interface LimitDecision {
  allowed: boolean;
  why?: LimitRefusal;
  message?: string;
  /** When the hourly cap will next admit a run. */
  retryAt?: number;
}

export const REFUSAL_TEXT: Readonly<Record<LimitRefusal, string>> = Object.freeze({
  'run-in-progress':
    'A fill is already running in this tab. Wait for it to finish, or press Abort on the page.',
  'hourly-cap':
    'That is more form-fills in an hour than this extension will do. It assists one person filling their own forms; it is not a bulk submission tool.',
});

interface ActiveRun {
  tabId: number;
  startedAt: number;
}

const active = new Map<number, ActiveRun>();
/** Timestamps of recently started runs, oldest first. */
let starts: number[] = [];

/**
 * May a run start in this tab right now?
 *
 * Checked before any value leaves the worker, so a refusal costs nothing and
 * reveals nothing.
 */
export function mayStartRun(tabId: number, now: number = Date.now()): LimitDecision {
  releaseExpired(now);
  prune(now);

  if (active.has(tabId)) {
    return {
      allowed: false,
      why: 'run-in-progress',
      message: REFUSAL_TEXT['run-in-progress'],
    };
  }

  if (starts.length >= MAX_RUNS_PER_HOUR) {
    const oldest = starts[0] ?? now;
    return {
      allowed: false,
      why: 'hourly-cap',
      message: REFUSAL_TEXT['hourly-cap'],
      retryAt: oldest + RUN_WINDOW_MS,
    };
  }

  return { allowed: true };
}

/** Record that a run has begun. Call only after `mayStartRun` allowed it. */
export function beginRun(tabId: number, now: number = Date.now()): void {
  active.set(tabId, { tabId, startedAt: now });
  starts = [...starts, now];
}

/** Release the tab. Safe to call for a tab with no run. */
export function endRunLimit(tabId: number): void {
  active.delete(tabId);
}

export function activeRunCount(now: number = Date.now()): number {
  releaseExpired(now);
  return active.size;
}

export function runsInWindow(now: number = Date.now()): number {
  prune(now);
  return starts.length;
}

/**
 * A run whose worker was suspended mid-flight never called `endRunLimit`.
 *
 * Without this, one interrupted run would lock its tab out permanently — a
 * limit that punishes the user for the platform's behaviour is worse than no
 * limit.
 */
function releaseExpired(now: number): void {
  for (const [tabId, run] of active) {
    if (now - run.startedAt > RUN_LEASE_MS) active.delete(tabId);
  }
}

function prune(now: number): void {
  starts = starts.filter((at) => now - at < RUN_WINDOW_MS);
}

/** Test seam. */
export function __resetLimitsForTests(): void {
  active.clear();
  starts = [];
}
