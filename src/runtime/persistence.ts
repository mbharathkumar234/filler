/**
 * Run persistence (§ Phase 6, §5 "Persistence").
 *
 *   "the entire RunState + FillPlan is serialised to chrome.storage.session
 *    under key `run:${tabId}:${formFingerprint}` after every transition.
 *    Content script re-hydrates on load. This is what makes pause/resume
 *    survive a postback."
 *
 * Three things about the choice of `chrome.storage.session`:
 *
 *  - It survives what needs surviving — a page navigation, an ASP.NET
 *    postback, and an MV3 service worker being suspended mid-run.
 *  - It does **not** survive the browser closing, which is the right lifetime
 *    for a half-finished application form. A run resumed a week later would be
 *    filling a page that no longer exists.
 *  - It is not readable by the page. `storage.session` defaults to a trusted
 *    access level — the worker and extension pages, and **not** content
 *    scripts, which is stricter than this comment used to claim. A content
 *    script reaching for it gets "Access to storage is not allowed from this
 *    context", and that wrong sentence is why one did, and why every scan on a
 *    real page failed. Content scripts go through `run:save`/`run:load`
 *    instead, and the worker strips the approval token on the way back.
 *
 * What is stored is the plan — keys, selectors, confidences — and never a
 * value. A stolen `storage.session` yields a list of which *kinds* of thing
 * were filled, not the user's Aadhaar. `persistence.test.ts` asserts that.
 */

import type { RunState } from '@/shared/types';
import { runStateKey } from '@/shared/types';

/** Bumped when the persisted shape changes; older records are dropped. */
export const RUN_SCHEMA_VERSION = 1;

/** Runs older than this are pruned. A form left overnight is not resumable. */
export const RUN_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface PersistedRun {
  v: number;
  state: RunState;
  updatedAt: number;
  tabId: number;
  formFingerprint: string;
}

/**
 * The slice of `chrome.storage.StorageArea` this module uses.
 *
 * Declared structurally so tests can pass a plain object. Depending on the
 * real `chrome` global here would make the whole state machine untestable
 * outside a browser, which is exactly what the plan says to avoid.
 */
export interface RunStorage {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

let storage: RunStorage | null = null;

/** Test seam, and the injection point for a non-`chrome` host. */
export function setRunStorage(area: RunStorage | null): void {
  storage = area;
}

function area(): RunStorage {
  if (storage) return storage;
  const session = (globalThis as { chrome?: { storage?: { session?: RunStorage } } }).chrome?.storage
    ?.session;
  if (!session) {
    throw new Error('chrome.storage.session is unavailable; call setRunStorage() first.');
  }
  storage = session;
  return session;
}

// ---------------------------------------------------------------------------
// Reading and writing one run
// ---------------------------------------------------------------------------

export async function saveRun(
  tabId: number,
  formFingerprint: string,
  state: RunState,
  now: number = Date.now(),
): Promise<void> {
  const record: PersistedRun = {
    v: RUN_SCHEMA_VERSION,
    state,
    updatedAt: now,
    tabId,
    formFingerprint,
  };
  await area().set({ [runStateKey(tabId, formFingerprint)]: record });
}

/**
 * Read a run back.
 *
 * Returns null for anything we should not trust: a missing record, one written
 * by an older schema, or one old enough that the portal session behind it is
 * probably gone. Resuming against a stale plan is worse than starting again,
 * because the user would believe fields were filled that were not.
 */
export async function loadRun(
  tabId: number,
  formFingerprint: string,
  now: number = Date.now(),
): Promise<PersistedRun | null> {
  const key = runStateKey(tabId, formFingerprint);
  const found = (await area().get(key))[key];
  const record = asRun(found);
  if (!record) return null;
  if (now - record.updatedAt > RUN_MAX_AGE_MS) {
    await clearRun(tabId, formFingerprint);
    return null;
  }
  return record;
}

export async function clearRun(tabId: number, formFingerprint: string): Promise<void> {
  await area().remove(runStateKey(tabId, formFingerprint));
}

/** Drop every run for a tab — it was closed, or navigated somewhere else. */
export async function clearTab(tabId: number): Promise<void> {
  const all = await area().get(null);
  const doomed = Object.keys(all).filter((key) => key.startsWith(`run:${tabId}:`));
  if (doomed.length > 0) await area().remove(doomed);
}

export async function listRuns(now: number = Date.now()): Promise<PersistedRun[]> {
  const all = await area().get(null);
  const runs: PersistedRun[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith('run:')) continue;
    const record = asRun(value);
    if (record && now - record.updatedAt <= RUN_MAX_AGE_MS) runs.push(record);
  }
  return runs;
}

export async function pruneRuns(now: number = Date.now()): Promise<number> {
  const all = await area().get(null);
  const doomed: string[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith('run:')) continue;
    const record = asRun(value);
    if (!record || now - record.updatedAt > RUN_MAX_AGE_MS) doomed.push(key);
  }
  if (doomed.length > 0) await area().remove(doomed);
  return doomed.length;
}

/**
 * Validate a record read back from storage.
 *
 * Storage is not a trusted input just because we wrote it: an older build, a
 * partial write, or a future migration can all put something unexpected there.
 * A run whose shape we do not recognise is discarded rather than resumed.
 */
function asRun(value: unknown): PersistedRun | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Partial<PersistedRun>;
  if (record.v !== RUN_SCHEMA_VERSION) return null;
  if (typeof record.updatedAt !== 'number') return null;
  if (typeof record.tabId !== 'number' || typeof record.formFingerprint !== 'string') return null;
  const state = record.state as { t?: unknown } | undefined;
  if (typeof state !== 'object' || state === null || typeof state.t !== 'string') return null;
  return record as PersistedRun;
}
