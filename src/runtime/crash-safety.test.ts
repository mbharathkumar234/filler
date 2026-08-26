import { beforeEach, describe, expect, it } from 'vitest';

import { loadRun, saveRun, setRunStorage, type RunStorage } from './persistence';
import { RunStore } from './store';
import { mayWritePage, reduce } from './machine';
import { APPROVAL_TOKEN_TTL_MS, type FillPlan, type RunState } from '@/shared/types';
import type { FieldKey } from '@/matching/taxonomy';

/**
 * Crash safety (§ Phase 10 Must).
 *
 *   "Killing the browser mid-run leaves no half-filled state that resumes
 *    incorrectly."
 *
 * "Incorrectly" is the load-bearing word. A run that is *lost* is a nuisance;
 * a run that comes back believing something it should not is the failure that
 * matters — an approval that survives, a fill that resumes onto a page it never
 * verified, a state that says nine fields are filled when the page is empty.
 *
 * A browser kill is modelled by throwing the in-memory `RunStore` away and
 * building a new one over the same storage. That is exactly what happens: the
 * worker's memory is gone, `chrome.storage.session` is not.
 */

const NOW = 1_700_000_000_000;

function fakeStorage(): RunStorage & { items: Map<string, unknown> } {
  const items = new Map<string, unknown>();
  return {
    items,
    get: (keys) => {
      if (keys === null) return Promise.resolve(Object.fromEntries(items));
      const wanted = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of wanted) if (items.has(k)) out[k] = items.get(k);
      return Promise.resolve(out);
    },
    set: (entries) => {
      for (const [k, v] of Object.entries(entries)) items.set(k, v);
      return Promise.resolve();
    },
    remove: (keys) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) items.delete(k);
      return Promise.resolve();
    },
  };
}

function plan(): FillPlan {
  return {
    siteId: 'portal',
    profileVersion: null,
    formFingerprint: 'fp-abc',
    tabId: 7,
    fields: [
      { fieldRef: 'f1', key: 'identity.full_name' as FieldKey, selectors: ['#a'], confidence: 0.95, source: 'rule' },
      { fieldRef: 'f2', key: 'id.aadhaar' as FieldKey, selectors: ['#b'], confidence: 0.95, source: 'rule' },
    ],
    documents: [],
    submit: { selectors: ['#go'], label: 'Submit' },
    createdAt: NOW,
  };
}

let storage: ReturnType<typeof fakeStorage>;

beforeEach(() => {
  storage = fakeStorage();
  setRunStorage(storage);
});

/** Everything the worker held is gone; storage is not. */
function afterCrash(): RunStore {
  return new RunStore(7, 'fp-abc');
}

describe('a run killed part-way through filling', () => {
  async function crashMidFill(): Promise<void> {
    const store = new RunStore(7, 'fp-abc');
    await store.dispatch({ t: 'DETECT' }, NOW);
    await store.dispatch({ t: 'FIELDS_FOUND', fields: [] }, NOW);
    await store.dispatch({ t: 'PLAN_READY', plan: plan() }, NOW);
    await store.dispatch({ t: 'FILL_START' }, NOW);
    await store.dispatch({ t: 'FIELD_FILLED', fieldRef: 'f1', at: NOW }, NOW);
    // …and the browser dies here.
  }

  it('comes back, rather than losing the user’s place entirely', async () => {
    await crashMidFill();
    const revived = afterCrash();
    await revived.hydrate(NOW + 5_000);

    expect(revived.state.t).toBe('FILLING');
    expect(revived.plan?.fields).toHaveLength(2);
  });

  it('does not claim a field was filled that never was', async () => {
    await crashMidFill();
    const revived = afterCrash();
    await revived.hydrate(NOW + 5_000);

    const fields = revived.plan!.fields;
    expect(fields.find((f) => f.fieldRef === 'f1')?.filledAt).toBe(NOW);
    // f2 was never reached. Nothing may say otherwise.
    expect(fields.find((f) => f.fieldRef === 'f2')?.filledAt).toBeUndefined();
  });

  it('never resumes writing without re-verifying the page first', async () => {
    // The content script forces this on a fresh document (`reloaded: true`),
    // which is what a browser restart produces. Asserted at the reducer so it
    // holds regardless of how the run controller is wired.
    await crashMidFill();
    const revived = afterCrash();
    await revived.hydrate(NOW + 5_000);

    const next = await revived.dispatch({ t: 'DOM_CHURN', kind: 'navigation' }, NOW + 5_001);

    expect(next.t).toBe('REVERIFYING');
    expect(mayWritePage(next)).toBe(false);
  });
});

describe('a run killed while it held an approval', () => {
  async function crashWhileArmed(at: number): Promise<void> {
    const armed: RunState = {
      t: 'ARMED',
      plan: plan(),
      approvalToken: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      expiresAt: at + APPROVAL_TOKEN_TTL_MS,
    };
    await saveRun(7, 'fp-abc', armed, at);
  }

  it('does not come back armed once the ninety seconds are up', async () => {
    // A browser restarted an hour later must not be one click from submitting.
    await crashWhileArmed(NOW);
    const revived = afterCrash();
    await revived.hydrate(NOW + APPROVAL_TOKEN_TTL_MS + 1);

    expect(revived.state.t).toBe('REVERIFYING');
  });

  it('and cannot be submitted even if something asks', async () => {
    await crashWhileArmed(NOW);
    const revived = afterCrash();
    await revived.hydrate(NOW + APPROVAL_TOKEN_TTL_MS + 1);

    const next = await revived.dispatch({ t: 'SUBMIT_DONE', at: NOW }, NOW + APPROVAL_TOKEN_TTL_MS + 2);
    expect(next.t).not.toBe('SUBMITTED');
  });

  it('the worker-side approval does not survive a restart at all', async () => {
    // The registry is in-memory by design, so a restarted worker has no grant
    // regardless of what the persisted run state says. Two independent
    // controls, and the weaker one is the one that is written down.
    const { ApprovalRegistry } = await import('./approval');
    const registry = new ApprovalRegistry();
    registry.issue({ tabId: 7, formFingerprint: 'fp-abc', targetSelector: '#go', now: NOW });

    const afterRestart = new ApprovalRegistry();
    expect(afterRestart.active(7, NOW + 1_000)).toBeNull();
  });
});

describe('a partially written state', () => {
  it('is discarded rather than half-resumed', async () => {
    // A kill during the storage write can leave a truncated record. It must
    // read as "no run", not as a run with missing pieces.
    storage.items.set('run:7:fp-abc', { v: 1, state: { t: 'FILLING' }, updatedAt: NOW });

    const revived = afterCrash();
    await revived.hydrate(NOW);

    expect(revived.state.t).toBe('IDLE');
  });

  it('a record with no state at all reads as no run', async () => {
    storage.items.set('run:7:fp-abc', { v: 1, updatedAt: NOW, tabId: 7, formFingerprint: 'fp-abc' });
    expect(await loadRun(7, 'fp-abc', NOW)).toBeNull();
  });
});

describe('what a resumed run is allowed to do', () => {
  it.each([
    ['BLOCKED', { t: 'BLOCKED', reason: 'captcha', plan: plan() } as RunState],
    ['REVERIFYING', { t: 'REVERIFYING', plan: plan() } as RunState],
    ['DRIFTED', { t: 'DRIFTED', plan: plan(), lost: ['f2'] } as RunState],
    ['REVIEW', { t: 'REVIEW', plan: plan(), diff: emptyDiff() } as RunState],
  ])('cannot write to the page after coming back as %s', async (_name, state) => {
    await saveRun(7, 'fp-abc', state, NOW);
    const revived = afterCrash();
    await revived.hydrate(NOW + 1_000);

    expect(mayWritePage(revived.state)).toBe(false);
  });

  it('a submitted run stays submitted — there is no re-submitting on restart', async () => {
    await saveRun(7, 'fp-abc', { t: 'SUBMITTED', at: NOW }, NOW);
    const revived = afterCrash();
    await revived.hydrate(NOW + 1_000);

    expect(revived.state.t).toBe('SUBMITTED');
    expect(reduce(revived.state, { t: 'FILL_START' }, NOW).t).toBe('SUBMITTED');
  });
});

function emptyDiff() {
  return {
    lowConfidence: [],
    truncated: [],
    fuzzySelect: [],
    fillFailed: [],
    requiredButEmpty: [],
  };
}
