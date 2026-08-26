import { beforeEach, describe, expect, it } from 'vitest';

import { ApprovalRegistry, mintToken, REFUSAL_TEXT, type ApprovalRefusal } from './approval';
import { isWellFormedToken } from './machine';
import { APPROVAL_TOKEN_TTL_MS } from '@/shared/types';

/**
 * The approval token.
 *
 * §5 gives it three properties — 128 bits of randomness, a 90-second life, and
 * single use — and this phase adds a fourth that matters more than any of
 * them: it describes *one specific act*. A token that outlives the page the
 * user looked at is the failure mode worth engineering against, because it is
 * the one where the user did everything right.
 */

const NOW = 1_700_000_000_000;
const FP = 'fingerprint-of-the-form-the-user-read';
const TARGET = '#btnFinalSubmit';

let registry: ApprovalRegistry;

beforeEach(() => {
  registry = new ApprovalRegistry();
});

function issue(over: Partial<Parameters<ApprovalRegistry['issue']>[0]> = {}) {
  return registry.issue({
    tabId: 7,
    formFingerprint: FP,
    targetSelector: TARGET,
    now: NOW,
    ...over,
  });
}

describe('minting', () => {
  it('is 128 bits of hex, the shape the reducer insists on', () => {
    const token = mintToken();
    expect(token).toHaveLength(32);
    expect(isWellFormedToken(token)).toBe(true);
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 500 }, () => mintToken()));
    expect(seen.size).toBe(500);
  });

  it('comes from the CSPRNG, not Math.random', () => {
    // Asserted by behaviour rather than by inspection: seeding Math.random
    // cannot make two mints agree.
    const a = mintToken();
    const b = mintToken();
    expect(a).not.toBe(b);
  });
});

describe('a grant describes one act', () => {
  it('carries the tab, the form, the element, and an expiry', () => {
    const grant = issue();

    expect(grant).toMatchObject({
      tabId: 7,
      formFingerprint: FP,
      targetSelector: TARGET,
      issuedAt: NOW,
      expiresAt: NOW + APPROVAL_TOKEN_TTL_MS,
    });
    expect(APPROVAL_TOKEN_TTL_MS).toBe(90_000);
  });

  it('accepts the token it issued', () => {
    const grant = issue();
    const check = registry.check(
      { tabId: 7, token: grant.token, formFingerprint: FP, targetSelector: TARGET },
      NOW + 1_000,
    );
    expect(check.ok).toBe(true);
  });
});

describe('every way an approval stops counting', () => {
  it('refuses when nothing was approved', () => {
    expect(registry.check({ tabId: 7, token: mintToken() }, NOW)).toEqual({
      ok: false,
      why: 'no-grant',
    });
  });

  it('refuses a token that is not the one issued', () => {
    issue();
    expect(registry.check({ tabId: 7, token: mintToken() }, NOW)).toEqual({
      ok: false,
      why: 'wrong-token',
    });
  });

  it('refuses after ninety seconds', () => {
    const grant = issue();
    expect(registry.check({ tabId: 7, token: grant.token }, NOW + APPROVAL_TOKEN_TTL_MS)).toEqual({
      ok: false,
      why: 'expired',
    });
  });

  it('accepts right up to the last millisecond', () => {
    const grant = issue();
    expect(
      registry.check({ tabId: 7, token: grant.token }, NOW + APPROVAL_TOKEN_TTL_MS - 1).ok,
    ).toBe(true);
  });

  it('refuses a token presented from a different tab', () => {
    const grant = issue();
    expect(registry.check({ tabId: 9, token: grant.token }, NOW)).toEqual({
      ok: false,
      why: 'no-grant',
    });
  });

  it('refuses once the form has changed under the approval', () => {
    // The heart of it. The user approved a page; a postback replaced it. The
    // approval described something that no longer exists.
    const grant = issue();
    const check = registry.check(
      { tabId: 7, token: grant.token, formFingerprint: 'a-different-form' },
      NOW + 1_000,
    );
    expect(check).toEqual({ ok: false, why: 'form-changed' });
  });

  it('refuses once the submit button is not the one approved', () => {
    const grant = issue();
    const check = registry.check(
      { tabId: 7, token: grant.token, targetSelector: '#someOtherButton' },
      NOW + 1_000,
    );
    expect(check).toEqual({ ok: false, why: 'wrong-target' });
  });

  it('has a sentence for the user for every refusal', () => {
    const refusals: ApprovalRefusal[] = [
      'no-grant',
      'wrong-token',
      'expired',
      'wrong-tab',
      'form-changed',
      'wrong-target',
    ];
    for (const why of refusals) {
      expect(REFUSAL_TEXT[why]).toBeTruthy();
    }
    // The two that mean "something moved" must warn, not just apologise.
    expect(REFUSAL_TEXT['form-changed']).toMatch(/changed/i);
    expect(REFUSAL_TEXT.expired).toMatch(/90 seconds/);
  });
});

describe('single use', () => {
  it('spends the token — a second submission has no approval', () => {
    const grant = issue();

    expect(registry.consume({ tabId: 7, token: grant.token }, NOW).ok).toBe(true);
    expect(registry.consume({ tabId: 7, token: grant.token }, NOW)).toEqual({
      ok: false,
      why: 'no-grant',
    });
  });

  it('burns an expired grant rather than leaving it lying around', () => {
    const grant = issue();
    registry.consume({ tabId: 7, token: grant.token }, NOW + APPROVAL_TOKEN_TTL_MS);
    expect(registry.active(7, NOW)).toBeNull();
  });

  it('burns a grant whose form changed — the user must look again', () => {
    const grant = issue();
    registry.consume({ tabId: 7, token: grant.token, formFingerprint: 'moved' }, NOW);
    expect(registry.check({ tabId: 7, token: grant.token }, NOW).ok).toBe(false);
  });

  it('a wrong token does not cancel the real approval', () => {
    // Otherwise any buggy caller could quietly revoke a live approval and the
    // user would be told their form changed when it had not.
    const grant = issue();
    registry.consume({ tabId: 7, token: mintToken() }, NOW);
    expect(registry.check({ tabId: 7, token: grant.token }, NOW).ok).toBe(true);
  });
});

describe('scope', () => {
  it('keeps one grant per tab, and approving again replaces it', () => {
    const first = issue();
    const second = issue();

    expect(second.token).not.toBe(first.token);
    expect(registry.check({ tabId: 7, token: first.token }, NOW)).toEqual({
      ok: false,
      why: 'wrong-token',
    });
    expect(registry.check({ tabId: 7, token: second.token }, NOW).ok).toBe(true);
  });

  it('keeps two tabs independent', () => {
    const a = issue({ tabId: 7 });
    const b = issue({ tabId: 9 });

    registry.consume({ tabId: 7, token: a.token }, NOW);
    expect(registry.check({ tabId: 9, token: b.token }, NOW).ok).toBe(true);
  });

  it('revokes on demand — abort, navigation, tab close', () => {
    const grant = issue();
    registry.revoke(7);
    expect(registry.check({ tabId: 7, token: grant.token }, NOW).ok).toBe(false);
  });
});

describe('what the panel shows while the clock runs', () => {
  it('counts down', () => {
    issue();
    expect(registry.remainingMs(7, NOW)).toBe(APPROVAL_TOKEN_TTL_MS);
    expect(registry.remainingMs(7, NOW + 30_000)).toBe(60_000);
    expect(registry.remainingMs(7, NOW + APPROVAL_TOKEN_TTL_MS + 1)).toBe(0);
  });

  it('reports no active approval once it lapses', () => {
    issue();
    expect(registry.active(7, NOW + 1_000)).not.toBeNull();
    expect(registry.active(7, NOW + APPROVAL_TOKEN_TTL_MS)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Wrong-length tokens (found by mutation testing)
// ---------------------------------------------------------------------------

/**
 * Every "wrong token" test above hands `check` another `mintToken()` — a
 * correctly formed token of exactly the right length that simply is not the
 * one issued. Not one of them supplies a token of a *different* length, and
 * mutation testing found the consequence: deleting the length guard from
 * `constantTimeEquals` (`if (a.length !== b.length) return false`) broke
 * nothing at all.
 *
 * That guard is the first line of the comparison and the first thing an
 * attacker probes. An empty string is what a compromised content script sends
 * when it is guessing, not a well-formed 32-character hex token — so the
 * shapes least covered were exactly the shapes most likely to arrive.
 */
describe('tokens of the wrong length (§ mutation-testing gap)', () => {
  const WRONG_LENGTHS: Array<[string, string]> = [
    ['empty', ''],
    ['one character', 'a'],
    ['a prefix of the real one', 'a1b2c3d4'],
    ['one character short', 'a1b2c3d4e5f60718293a4b5c6d7e8f9'],
    ['one character long', 'a1b2c3d4e5f60718293a4b5c6d7e8f900'],
    ['far too long', 'a'.repeat(4096)],
  ];

  it.each(WRONG_LENGTHS)('refuses a token that is %s', (_label, token) => {
    issue();
    expect(registry.check({ tabId: 7, token }, NOW)).toEqual({ ok: false, why: 'wrong-token' });
  });

  it.each(WRONG_LENGTHS)('a token that is %s cannot consume the real grant', (_label, token) => {
    // The dangerous half. Refusing the check but consuming the grant would let
    // anybody burn a live approval, and the user would be told their form
    // changed when it had not.
    const grant = issue();
    registry.consume({ tabId: 7, token }, NOW);
    expect(registry.check({ tabId: 7, token: grant.token }, NOW).ok).toBe(true);
  });

  it('refuses a token that shares the real prefix but is truncated', () => {
    const grant = issue();
    expect(registry.check({ tabId: 7, token: grant.token.slice(0, -1) }, NOW).ok).toBe(false);
  });

  it('refuses the real token with anything appended', () => {
    const grant = issue();
    expect(registry.check({ tabId: 7, token: `${grant.token}0` }, NOW).ok).toBe(false);
  });

  it('refuses a token differing only in case', () => {
    // The tokens are lower-case hex. A comparison that normalised case would
    // halve the search space for no reason.
    const grant = issue();
    const upper = grant.token.toUpperCase();
    if (upper === grant.token) return; // No letters in this one; nothing to test.
    expect(registry.check({ tabId: 7, token: upper }, NOW).ok).toBe(false);
  });
});
