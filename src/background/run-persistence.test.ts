import { readFile } from 'node:fs/promises';

import { beforeEach, describe, expect, it } from 'vitest';

import { RunStore, directPersistence, type RunPersistence } from '@/runtime/store';
import { setRunStorage, loadRun, saveRun } from '@/runtime/persistence';
import type { FillPlan, RunState } from '@/shared/types';

/**
 * Persisting a run from a content script (§ found in use).
 *
 * ## The bug
 *
 * `RunStore` reached `chrome.storage.session` directly, and `RunStore` runs in
 * the content script. `storage.session` defaults to **trusted contexts** — the
 * worker and extension pages — and a content script is not one. Every call
 * threw "Access to storage is not allowed from this context", which took down
 * the whole harvest and, once the earlier masking was removed, was finally
 * visible.
 *
 * `persistence.ts` said the opposite in a comment: *"a content script can reach
 * it but a portal cannot"*. Half right, and the wrong half was load-bearing.
 *
 * ## Why the one-line fix was refused
 *
 * `chrome.storage.session.setAccessLevel({ accessLevel:
 * 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })` fixes it in one line and opens a P2
 * hole. A persisted `ARMED` state carries a live `approvalToken`, so making
 * session storage readable from content scripts hands that token to a script
 * running inside whatever page the user is on — and the approval token is the
 * single thing standing between this extension and submitting a form by itself.
 *
 * So the worker does the storing, and strips the token on the way back. The
 * content script never needed it: the token reaches the guard through
 * `fill:submit` from the panel.
 */

const PLAN: FillPlan = {
  siteId: 'portal',
  profileVersion: null,
  formFingerprint: 'fp-1',
  tabId: 7,
  fields: [],
  documents: [],
  submit: { selectors: ['#go'], label: 'Submit' },
  createdAt: 1_700_000_000_000,
};

const ARMED: RunState = {
  t: 'ARMED',
  plan: PLAN,
  approvalToken: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  expiresAt: 1_700_000_090_000,
};

/** An in-memory stand-in for `chrome.storage.session`. */
function memoryArea() {
  const data = new Map<string, unknown>();
  return {
    async get(keys: string | string[] | null) {
      const wanted = keys === null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(wanted.filter((k) => data.has(k)).map((k) => [k, data.get(k)]));
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) data.set(k, v);
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
}

beforeEach(() => {
  setRunStorage(memoryArea());
});

describe('the store no longer assumes it can reach storage itself', () => {
  it('uses the port it was given', async () => {
    const calls: string[] = [];
    const port: RunPersistence = {
      async save() {
        calls.push('save');
      },
      async load() {
        calls.push('load');
        return null;
      },
      async clear() {
        calls.push('clear');
      },
    };

    const store = new RunStore(7, 'fp-1', undefined, port);
    await store.dispatch({ t: 'DETECT' });
    await store.hydrate();
    await store.reset();

    expect(calls).toEqual(['save', 'load', 'clear']);
  });

  it('still works with the direct implementation, for the worker and tests', async () => {
    const store = new RunStore(7, 'fp-1', undefined, directPersistence);
    await store.dispatch({ t: 'DETECT' });

    const record = await loadRun(7, 'fp-1');
    expect(record?.state.t).toBe('DETECTING');
  });

  it('defaults to the direct implementation when none is given', async () => {
    const store = new RunStore(7, 'fp-2');
    await store.dispatch({ t: 'DETECT' });
    expect((await loadRun(7, 'fp-2'))?.state.t).toBe('DETECTING');
  });
});

describe('the approval token never travels to a content script', () => {
  /**
   * The worker's redaction, expressed against the same shape it returns.
   *
   * Kept as a test of the *rule* rather than of the handler, because the rule
   * is what matters and the handler is three lines of `chrome.*` that no unit
   * test can call.
   */
  const redactForUntrusted = (state: RunState): RunState =>
    state.t === 'ARMED' ? { ...state, approvalToken: '' } : state;

  it('strips the token from an ARMED state', () => {
    const sent = redactForUntrusted(ARMED);
    expect(sent.t).toBe('ARMED');
    expect(JSON.stringify(sent)).not.toContain('a1b2c3d4e5f60718293a4b5c6d7e8f90');
  });

  it('keeps everything else, so a restore still works', () => {
    const sent = redactForUntrusted(ARMED);
    expect(sent.t === 'ARMED' && sent.plan.submit?.label).toBe('Submit');
    expect(sent.t === 'ARMED' && sent.expiresAt).toBe(ARMED.t === 'ARMED' ? ARMED.expiresAt : 0);
  });

  it('leaves states that carry no token alone', () => {
    const filling: RunState = { t: 'FILLING', plan: PLAN, cursor: 0 };
    expect(redactForUntrusted(filling)).toEqual(filling);
  });

  it('is the only state that carries one', async () => {
    // If a future state gains a token, this fails and the redaction has to
    // learn about it — which is the moment somebody should be thinking about
    // it, rather than after it has shipped.
    await saveRun(7, 'fp-3', ARMED, Date.now());
    const stored = JSON.stringify((await loadRun(7, 'fp-3'))?.state);
    expect(stored).toContain('approvalToken');

    const tokenBearing = ['ARMED'];
    const states: RunState[] = [
      { t: 'IDLE' },
      { t: 'DETECTING' },
      { t: 'FILLING', plan: PLAN, cursor: 0 },
      { t: 'REVIEW', plan: PLAN, diff: { lowConfidence: [], truncated: [], fuzzySelect: [], fillFailed: [], requiredButEmpty: [] } },
      ARMED,
    ];

    for (const state of states) {
      const carries = JSON.stringify(state).includes('approvalToken');
      expect(carries, `${state.t} carries a token`).toBe(tokenBearing.includes(state.t));
    }
  });
});

describe('the content script supplies the port', () => {
  /**
   * The regression that would bring the bug back.
   *
   * `RunStore` still defaults to the direct implementation, because the worker
   * and a dozen tests rely on that. So the content script forgetting to pass
   * its own port would silently fall back to `chrome.storage.session` and fail
   * exactly as before — and only on a real page, where no test looks.
   *
   * The dead code is still bundled into the content script. That is weight,
   * not a hole: Chrome refuses the access itself, so an accidental call throws
   * rather than reading anything. What must not regress is the wiring.
   */
  it('passes a persistence port to the controller', async () => {
    const source = await readFile('src/content/index.ts', 'utf8');
    expect(source).toMatch(/persistence:\s*workerPersistence/);
  });

  it('implements that port with messages, not with storage', async () => {
    const source = await readFile('src/content/index.ts', 'utf8');
    const start = source.indexOf('const workerPersistence');
    const port = (start < 0 ? '' : source.slice(start, source.indexOf('\n};', start)))
      // Comments only, as everywhere else here: the port's own comment explains
      // why it does not touch session storage, and a check that forbids saying
      // so makes the reasoning unwritable.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/[^\n]*/g, '$1');

    expect(port, 'the worker-backed port was not found').toContain('run:load');
    expect(port).toContain('run:save');
    expect(port).toContain('run:clear');
    expect(port, 'a content script cannot reach session storage').not.toContain('storage.session');
  });
});
