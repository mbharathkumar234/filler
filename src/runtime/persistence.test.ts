import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearRun,
  clearTab,
  listRuns,
  loadRun,
  pruneRuns,
  RUN_MAX_AGE_MS,
  RUN_SCHEMA_VERSION,
  saveRun,
  setRunStorage,
  type RunStorage,
} from './persistence';
import { RunStore } from './store';
import { initial } from './machine';
import { runStateKey, type FillPlan, type RunState } from '@/shared/types';

/**
 * §5's persistence rule, tested against a fake storage area.
 *
 * The fake is deliberately dumb — a Map with the `chrome.storage` shape — so
 * these tests assert our behaviour rather than Chrome's.
 */

const NOW = 1_700_000_000_000;

function fakeStorage(): RunStorage & { items: Map<string, unknown>; writes: number } {
  const items = new Map<string, unknown>();
  const store = {
    items,
    writes: 0,
    get(keys: string | string[] | null) {
      if (keys === null) return Promise.resolve(Object.fromEntries(items));
      const wanted = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of wanted) if (items.has(key)) out[key] = items.get(key);
      return Promise.resolve(out);
    },
    set(entries: Record<string, unknown>) {
      store.writes += 1;
      for (const [key, value] of Object.entries(entries)) items.set(key, value);
      return Promise.resolve();
    },
    remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) items.delete(key);
      return Promise.resolve();
    },
  };
  return store;
}

function plan(): FillPlan {
  return {
    siteId: 'fixture-portal',
    profileVersion: 3,
    formFingerprint: 'fp-abc',
    tabId: 7,
    fields: [
      { fieldRef: 'f1', key: 'id.aadhaar', selectors: ['#uid'], confidence: 0.95, source: 'profile' },
    ],
    documents: [],
    submit: { selectors: ['#btnSubmit'], label: 'Final Submit' },
    createdAt: NOW,
  };
}

const FILLING: RunState = { t: 'FILLING', plan: plan(), cursor: 1 };

let storage: ReturnType<typeof fakeStorage>;

beforeEach(() => {
  storage = fakeStorage();
  setRunStorage(storage);
});

describe('the storage key', () => {
  it('is the documented `run:${tabId}:${formFingerprint}`', () => {
    expect(runStateKey(7, 'fp-abc')).toBe('run:7:fp-abc');
  });

  it('keeps two forms in the same tab apart', async () => {
    await saveRun(7, 'fp-one', FILLING, NOW);
    await saveRun(7, 'fp-two', { t: 'REVIEW', plan: plan(), diff: emptyDiff() }, NOW);

    expect((await loadRun(7, 'fp-one', NOW))?.state.t).toBe('FILLING');
    expect((await loadRun(7, 'fp-two', NOW))?.state.t).toBe('REVIEW');
  });

  it('keeps the same form in two tabs apart', async () => {
    await saveRun(7, 'fp-abc', FILLING, NOW);
    await saveRun(9, 'fp-abc', { t: 'BLOCKED', reason: 'captcha', plan: plan() }, NOW);

    expect((await loadRun(9, 'fp-abc', NOW))?.state.t).toBe('BLOCKED');
  });
});

describe('round-tripping a run', () => {
  it('restores the state and the plan exactly', async () => {
    await saveRun(7, 'fp-abc', FILLING, NOW);
    const back = await loadRun(7, 'fp-abc', NOW);

    expect(back?.state).toEqual(FILLING);
    expect(back?.v).toBe(RUN_SCHEMA_VERSION);
  });

  it('stores keys and selectors, never a filled value', async () => {
    // The whole vault is worth more than this record. Losing storage.session
    // must tell an attacker what *kind* of field was filled, not what went in
    // it. Asserted structurally rather than by scanning the JSON text, because
    // the text is full of legitimate digits — the timestamp alone is thirteen
    // of them, which is enough to look like an Aadhaar to a lazy regex.
    await saveRun(7, 'fp-abc', FILLING, NOW);
    const record = storage.items.get(runStateKey(7, 'fp-abc'));

    const names = propertyNames(record);
    expect(names).toContain('key');
    expect(names).toContain('selectors');
    for (const name of names) {
      expect(name, `persisted run must not carry a "${name}"`).not.toMatch(
        /^(value|values|text|bytes|filename|content|passphrase|secret)$/i,
      );
    }

    // And no string anywhere in the record looks like the identifiers we hold.
    for (const leaf of stringLeaves(record)) {
      expect(leaf, `"${leaf}" looks like an identity number`).not.toMatch(
        /^\d{12}$|^[A-Z]{5}\d{4}[A-Z]$/,
      );
    }
  });

  it('drops a record written by an older schema', async () => {
    storage.items.set(runStateKey(7, 'fp-abc'), { v: 0, state: FILLING, updatedAt: NOW, tabId: 7, formFingerprint: 'fp-abc' });
    expect(await loadRun(7, 'fp-abc', NOW)).toBeNull();
  });

  it.each([
    ['not an object', 'nonsense'],
    ['null', null],
    ['missing state', { v: RUN_SCHEMA_VERSION, updatedAt: NOW, tabId: 7, formFingerprint: 'x' }],
    ['a state with no tag', { v: RUN_SCHEMA_VERSION, state: {}, updatedAt: NOW, tabId: 7, formFingerprint: 'x' }],
  ])('refuses to resume %s', async (_name, value) => {
    storage.items.set(runStateKey(7, 'fp-abc'), value);
    expect(await loadRun(7, 'fp-abc', NOW)).toBeNull();
  });
});

describe('lifetime', () => {
  it('forgets a run that is older than the maximum age', async () => {
    await saveRun(7, 'fp-abc', FILLING, NOW);
    expect(await loadRun(7, 'fp-abc', NOW + RUN_MAX_AGE_MS + 1)).toBeNull();
    // …and cleans it up rather than leaving it to rot.
    expect(storage.items.size).toBe(0);
  });

  it('still resumes one that is just inside it', async () => {
    await saveRun(7, 'fp-abc', FILLING, NOW);
    expect(await loadRun(7, 'fp-abc', NOW + RUN_MAX_AGE_MS - 1)).not.toBeNull();
  });

  it('clears every run for a closed tab, and only that tab', async () => {
    await saveRun(7, 'fp-one', FILLING, NOW);
    await saveRun(7, 'fp-two', FILLING, NOW);
    await saveRun(9, 'fp-one', FILLING, NOW);
    storage.items.set('unrelated:thing', { keep: true });

    await clearTab(7);

    expect(await loadRun(7, 'fp-one', NOW)).toBeNull();
    expect(await loadRun(9, 'fp-one', NOW)).not.toBeNull();
    expect(storage.items.has('unrelated:thing')).toBe(true);
  });

  it('prunes stale runs and leaves fresh ones', async () => {
    await saveRun(7, 'old', FILLING, NOW - RUN_MAX_AGE_MS - 1);
    await saveRun(7, 'new', FILLING, NOW);

    expect(await pruneRuns(NOW)).toBe(1);
    expect(await listRuns(NOW)).toHaveLength(1);
  });

  it('clears a single run on request', async () => {
    await saveRun(7, 'fp-abc', FILLING, NOW);
    await clearRun(7, 'fp-abc');
    expect(await loadRun(7, 'fp-abc', NOW)).toBeNull();
  });
});

describe('RunStore — persisted after every transition', () => {
  it('writes on each accepted transition', async () => {
    const store = new RunStore(7, 'fp-abc');
    await store.dispatch({ t: 'DETECT' }, NOW);
    await store.dispatch({ t: 'FIELDS_FOUND', fields: [] }, NOW);
    await store.dispatch({ t: 'PLAN_READY', plan: plan() }, NOW);

    expect(storage.writes).toBe(3);
    expect((await loadRun(7, 'fp-abc', NOW))?.state.t).toBe('READY');
  });

  it('does not write when the machine refused the event', async () => {
    const store = new RunStore(7, 'fp-abc');
    await store.dispatch({ t: 'DETECT' }, NOW);
    const writesAfterOne = storage.writes;

    // A busy page emits these constantly; each one refused must be free.
    await store.dispatch({ t: 'SUBMIT_DONE', at: NOW }, NOW);
    await store.dispatch({ t: 'USER_CONTINUE' }, NOW);
    await store.dispatch({ t: 'TIMER_TICK' }, NOW);

    expect(storage.writes).toBe(writesAfterOne);
  });

  it('rehydrates a paused run in a fresh store — the postback survival case', async () => {
    const before = new RunStore(7, 'fp-abc');
    await before.dispatch({ t: 'DETECT' }, NOW);
    await before.dispatch({ t: 'FIELDS_FOUND', fields: [] }, NOW);
    await before.dispatch({ t: 'PLAN_READY', plan: plan() }, NOW);
    await before.dispatch({ t: 'FILL_START' }, NOW);
    await before.dispatch({ t: 'BLOCKER_SEEN', reason: 'captcha' }, NOW);

    // The page navigates. Everything in memory is gone.
    const after = new RunStore(7, 'fp-abc');
    expect(after.state.t).toBe('IDLE');

    await after.hydrate(NOW + 5_000);

    expect(after.state).toMatchObject({ t: 'BLOCKED', reason: 'captcha' });
    expect(after.plan?.fields[0]?.key).toBe('id.aadhaar');
  });

  it('does not come back armed after the approval has expired', async () => {
    const armed: RunState = {
      t: 'ARMED',
      plan: plan(),
      approvalToken: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      expiresAt: NOW + 90_000,
    };
    await saveRun(7, 'fp-abc', armed, NOW);

    const store = new RunStore(7, 'fp-abc');
    await store.hydrate(NOW + 90_001);

    // A tab restored two minutes later must not be one click from submitting.
    expect(store.state.t).toBe('REVERIFYING');
  });

  it('comes back armed when there is still time on the clock', async () => {
    const armed: RunState = {
      t: 'ARMED',
      plan: plan(),
      approvalToken: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      expiresAt: NOW + 90_000,
    };
    await saveRun(7, 'fp-abc', armed, NOW);

    const store = new RunStore(7, 'fp-abc');
    await store.hydrate(NOW + 10_000);
    expect(store.state.t).toBe('ARMED');
  });

  it('hydrating an unknown run leaves the store alone', async () => {
    const store = new RunStore(7, 'never-seen');
    expect((await store.hydrate(NOW)).t).toBe('IDLE');
  });

  it('tells subscribers about each transition, and unsubscribes cleanly', async () => {
    const store = new RunStore(7, 'fp-abc');
    const seen: string[] = [];
    const off = store.subscribe((state) => seen.push(state.t));

    await store.dispatch({ t: 'DETECT' }, NOW);
    off();
    await store.dispatch({ t: 'FIELDS_FOUND', fields: [] }, NOW);

    expect(seen).toEqual(['DETECTING']);
  });

  it('a subscriber that throws does not strand the run', async () => {
    const store = new RunStore(7, 'fp-abc');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.subscribe(() => {
      throw new Error('panel exploded');
    });
    const quiet: string[] = [];
    store.subscribe((state) => quiet.push(state.t));

    await store.dispatch({ t: 'DETECT' }, NOW);

    expect(store.state.t).toBe('DETECTING');
    expect(quiet).toEqual(['DETECTING']);
    warn.mockRestore();
  });

  it('reset forgets the run and returns to IDLE', async () => {
    const store = new RunStore(7, 'fp-abc');
    await store.dispatch({ t: 'DETECT' }, NOW);
    await store.reset(NOW);

    expect(store.state).toEqual(initial());
    expect(await loadRun(7, 'fp-abc', NOW)).toBeNull();
  });
});

describe('without a storage area', () => {
  it('says so plainly rather than silently dropping the run', async () => {
    setRunStorage(null);
    const original = (globalThis as { chrome?: unknown }).chrome;
    delete (globalThis as { chrome?: unknown }).chrome;

    await expect(saveRun(7, 'fp-abc', FILLING, NOW)).rejects.toThrow(/storage\.session/);

    if (original !== undefined) (globalThis as { chrome?: unknown }).chrome = original;
  });
});

/** Every property name in an object graph, however deeply nested. */
function propertyNames(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) propertyNames(item, found);
  } else if (typeof value === 'object' && value !== null) {
    for (const [name, child] of Object.entries(value)) {
      found.add(name);
      propertyNames(child, found);
    }
  }
  return found;
}

/** Every string leaf in an object graph. */
function stringLeaves(value: unknown, found: string[] = []): string[] {
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) for (const item of value) stringLeaves(item, found);
  else if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) stringLeaves(child, found);
  }
  return found;
}

function emptyDiff() {
  return {
    lowConfidence: [],
    truncated: [],
    fuzzySelect: [],
    fillFailed: [],
    requiredButEmpty: [],
  };
}
