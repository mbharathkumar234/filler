import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MatchResult } from '@/shared/types';
import type { FieldKey } from '@/matching/taxonomy';
import { REAUTH_IDLE_MS } from '@/runtime/reauth';

/**
 * The worker's side of a fill.
 *
 * Two things are tested here and nowhere else, because this is the only place
 * they exist:
 *
 *  - **Which values leave the worker.** Filling a field means putting its value
 *    in the DOM; that is inherent. Shipping the whole vault into a hostile tab
 *    is not, and `buildWrites` is the line between them.
 *  - **What a refill request from inside the page can obtain.** § Phase 6 gave
 *    the content script a way to ask for values again after a postback. The
 *    containment on that is the run authorisation, and a boundary with no test
 *    is a boundary that will be widened by accident.
 */

const session = {
  unlocked: true,
  authenticatedAt: null as number | null,
};

vi.mock('@/vault/session', () => ({
  isUnlocked: () => session.unlocked,
  lastAuthenticatedAt: () => session.authenticatedAt,
  VaultLockedError: class VaultLockedError extends Error {
    constructor() {
      super('The vault is locked. Enter your passphrase to continue.');
    }
  },
  withKey: async (fn: (db: unknown, key: unknown) => Promise<unknown>) => fn({}, {}),
}));

const vaultValues = new Map<string, string>([
  ['identity.full_name', 'Ravi Kumar'],
  ['contact.email', 'ravi@example.com'],
  ['id.aadhaar', '234567890123'],
  ['bank.account_number', '00112233445566'],
]);

vi.mock('@/vault/profile-store', () => ({
  getAllFields: async () => [...vaultValues].map(([key, value]) => ({ key, value })),
}));

vi.mock('@/vault/db', () => ({ openVaultDb: async () => ({ count: async () => 1 }) }));

const sent: unknown[] = [];
let tabReply: unknown = { ok: true, data: { records: [], aborted: false, blocked: 0 } };

(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: {
    sendMessage: (_tabId: number, message: unknown) => {
      sent.push(message);
      return Promise.resolve(tabReply);
    },
  },
};

const {
  buildWrites,
  authoriseRun,
  authorisedRun,
  endRun,
  refillTab,
  RUN_AUTHORISATION_MS,
  __resetRunsForTests,
} = await import('./fill-service');

const NOW = 1_700_000_000_000;

function match(fieldRef: string, key: string, confidence = 0.95): MatchResult {
  return { fieldRef, key: key as FieldKey, confidence, rationale: 'test', source: 'rule' };
}

beforeEach(() => {
  __resetRunsForTests();
  sent.length = 0;
  session.unlocked = true;
  // The real clock: `refillTab` reads `Date.now()` internally, so a run
  // authorised at a fixed historical timestamp would already have expired.
  session.authenticatedAt = Date.now();
  tabReply = { ok: true, data: { records: [], aborted: false, blocked: 0 } };
});

describe('buildWrites — what leaves the worker', () => {
  const selectors = new Map([
    ['f1', ['#name']],
    ['f2', ['#email']],
  ]);

  it('sends one value per matched field, and nothing else from the vault', () => {
    const { writes } = buildWrites(
      [match('f1', 'identity.full_name')],
      vaultValues,
      new Set(),
      selectors,
    );

    expect(writes).toEqual([{ ref: 'f1', key: 'identity.full_name', value: 'Ravi Kumar' }]);
    // The Aadhaar sat in the same map and was not asked for. It stays put.
    expect(JSON.stringify(writes)).not.toContain('234567890123');
  });

  it('leaves a low-confidence match blank rather than guessing', () => {
    const { writes, skipped } = buildWrites(
      [match('f1', 'identity.full_name', 0.4)],
      vaultValues,
      new Set(),
      selectors,
    );

    expect(writes).toEqual([]);
    expect(skipped).toEqual([{ key: 'identity.full_name', confidence: 0.4 }]);
  });

  it('skips a field the matcher could not identify', () => {
    const { writes } = buildWrites([match('f1', 'unknown')], vaultValues, new Set(), selectors);
    expect(writes).toEqual([]);
  });

  it('skips a key the vault has no value for', () => {
    const { writes } = buildWrites(
      [match('f1', 'identity.middle_name')],
      vaultValues,
      new Set(),
      selectors,
    );
    expect(writes).toEqual([]);
  });

  it('flags a dependent select, so the fill engine waits for its options', () => {
    const { writes } = buildWrites(
      [match('f2', 'contact.email')],
      vaultValues,
      new Set(['email']),
      new Map([['f2', ['#email']]]),
    );
    expect(writes[0]?.dependent).toBe(true);
  });

  it('routes a document key to the attachment path, not the value path', () => {
    const { writes, missingDocs } = buildWrites(
      [match('f1', 'doc.photo')],
      vaultValues,
      new Set(),
      selectors,
    );
    expect(writes).toEqual([]);
    expect(missingDocs).toEqual(['doc.photo']);
  });
});

describe('the run authorisation that contains a refill', () => {
  it('expires, so a tab left open all afternoon cannot refill itself', () => {
    authoriseRun(7, [{ ref: 'f1', key: 'identity.full_name', value: 'Ravi Kumar' }], NOW);

    expect(authorisedRun(7, NOW + RUN_AUTHORISATION_MS - 1)).not.toBeNull();
    expect(authorisedRun(7, NOW + RUN_AUTHORISATION_MS + 1)).toBeNull();
  });

  it('ends when the run does', () => {
    authoriseRun(7, [{ ref: 'f1', key: 'identity.full_name', value: 'x' }], NOW);
    endRun(7);
    expect(authorisedRun(7, NOW)).toBeNull();
  });

  it('is per tab', () => {
    authoriseRun(7, [{ ref: 'f1', key: 'identity.full_name', value: 'x' }], NOW);
    expect(authorisedRun(9, NOW)).toBeNull();
  });
});

describe('refillTab — a request that comes from inside the page', () => {
  it('refuses outright when no run is in progress', async () => {
    const result = await refillTab(7, ['f1']);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('NO_ACTIVE_RUN');
    expect(sent).toEqual([]);
  });

  it('refuses when the vault is locked', async () => {
    authoriseRun(7, [{ ref: 'f1', key: 'identity.full_name', value: 'x' }]);
    session.unlocked = false;

    const result = await refillTab(7, ['f1']);
    expect(result.ok === false && result.code).toBe('VAULT_LOCKED');
  });

  it('re-sends the values for fields the user already approved', async () => {
    authoriseRun(7, [
      { ref: 'f1', key: 'identity.full_name', value: 'Ravi Kumar' },
      { ref: 'f2', key: 'contact.email', value: 'ravi@example.com' },
    ]);

    const result = await refillTab(7, ['f1', 'f2']);

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).toContain('Ravi Kumar');
  });

  it('ignores refs that were never part of the run', async () => {
    // The containment that matters: a compromised content script asking for a
    // field the user never agreed to fill gets nothing, not a value.
    authoriseRun(7, [{ ref: 'f1', key: 'identity.full_name', value: 'Ravi Kumar' }]);

    const result = await refillTab(7, ['f1', 'f-aadhaar', 'f-bank']);

    expect(result.ok).toBe(true);
    const payload = JSON.stringify(sent);
    expect(payload).toContain('Ravi Kumar');
    expect(payload).not.toContain('234567890123');
    expect(payload).not.toContain('00112233445566');
  });

  it('sends nothing at all when no requested ref is in the plan', async () => {
    authoriseRun(7, [{ ref: 'f1', key: 'identity.full_name', value: 'x' }]);

    const result = await refillTab(7, ['f-aadhaar']);

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.data.attempted).toBe(0);
    expect(sent).toEqual([]);
  });

  it('applies the re-auth gate again — time has passed since the gesture', async () => {
    authoriseRun(7, [{ ref: 'f1', key: 'id.aadhaar', value: '234567890123' }]);
    session.authenticatedAt = Date.now() - REAUTH_IDLE_MS - 1;

    const result = await refillTab(7, ['f1']);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('REAUTH_REQUIRED');
    expect(sent).toEqual([]);
  });

  it('lets an ordinary field through under the same idle clock', async () => {
    authoriseRun(7, [{ ref: 'f1', key: 'identity.full_name', value: 'Ravi Kumar' }]);
    session.authenticatedAt = Date.now() - REAUTH_IDLE_MS - 1;

    const result = await refillTab(7, ['f1']);
    expect(result.ok).toBe(true);
  });

  it('reports a page that did not answer, rather than claiming success', async () => {
    authoriseRun(7, [{ ref: 'f1', key: 'identity.full_name', value: 'x' }]);
    tabReply = undefined;

    const result = await refillTab(7, ['f1']);
    expect(result.ok).toBe(false);
  });
});
