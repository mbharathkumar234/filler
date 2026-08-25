import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setAuditStorage, readAudit, type AuditStorage } from '@/runtime/audit';
import { APPROVAL_TOKEN_TTL_MS } from '@/shared/types';

/**
 * Approval and submission.
 *
 * This is the only path in the extension that can send a form, so the tests
 * that matter are the ones about refusing. Each of them describes a way a user
 * could end up submitting something they did not agree to, and asserts that we
 * do not.
 */

// --- the page, as the worker sees it ----------------------------------------

interface FakeHarvest {
  url: string;
  fingerprint: string;
  submit: { selector: string; label: string } | null;
  blockers: { type: string; reason: string; selector: string }[];
}

const page: FakeHarvest = {
  url: 'https://portal.example.gov.in/apply',
  fingerprint: 'fp-original',
  submit: { selector: '#btnFinalSubmit', label: 'Final Submit' },
  blockers: [],
};

let harvestFails = false;

vi.mock('./harvest-service', () => ({
  harvestTab: async () =>
    harvestFails
      ? { ok: false, error: 'could not read the page' }
      : {
          ok: true,
          data: {
            url: page.url,
            fingerprint: page.fingerprint,
            blockers: page.blockers,
            frames: [{ frameId: 0, submit: page.submit }],
          },
        },
}));

const endRun = vi.fn();
vi.mock('./fill-service', () => ({ endRun: (id: number) => endRun(id) }));

const forgetTabReview = vi.fn();
vi.mock('./review-service', () => ({
  forgetTabReview: (id: number) => forgetTabReview(id),
}));

// --- the content script -----------------------------------------------------

interface SentMessage {
  type: string;
  token?: { value: string; targetSelector: string; expiresAt: number };
}

const sent: SentMessage[] = [];
let pageSubmits = true;
let pageThrows = false;

(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: {
    sendMessage: (_tabId: number, message: { payload: SentMessage }) => {
      if (pageThrows) return Promise.reject(new Error('the tab went away'));
      sent.push(message.payload);
      return Promise.resolve({ ok: true, data: { submitted: pageSubmits } });
    },
  },
};

function fakeStorage(): AuditStorage {
  const items = new Map<string, unknown>();
  return {
    get: (keys) => {
      if (keys === null) return Promise.resolve(Object.fromEntries(items));
      const wanted = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of wanted) if (items.has(key)) out[key] = items.get(key);
      return Promise.resolve(out);
    },
    set: (entries) => {
      for (const [key, value] of Object.entries(entries)) items.set(key, value);
      return Promise.resolve();
    },
    remove: (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) items.delete(key);
      return Promise.resolve();
    },
  };
}

const { grantApproval, submitWithApproval, revokeApproval, approvalStatus, __resetApprovalsForTests } =
  await import('./approval-service');

const TAB = 7;

beforeEach(() => {
  __resetApprovalsForTests();
  setAuditStorage(fakeStorage());
  sent.length = 0;
  endRun.mockClear();
  forgetTabReview.mockClear();
  page.url = 'https://portal.example.gov.in/apply';
  page.fingerprint = 'fp-original';
  page.submit = { selector: '#btnFinalSubmit', label: 'Final Submit' };
  page.blockers = [];
  harvestFails = false;
  pageSubmits = true;
  pageThrows = false;
});

describe('granting an approval', () => {
  it('names the button the user is approving', async () => {
    const result = await grantApproval(TAB);

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.data.target).toBe('Final Submit');
  });

  it('starts a ninety-second clock', async () => {
    const before = Date.now();
    const result = await grantApproval(TAB);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.expiresAt).toBeGreaterThanOrEqual(before + APPROVAL_TOKEN_TTL_MS);
    expect(approvalStatus(TAB).active).toBe(true);
  });

  it('never hands the token to the caller', async () => {
    // The panel must not be able to leak or replay one. The only holder is
    // the worker, and the only recipient is the content script, once.
    const result = await grantApproval(TAB);
    expect(JSON.stringify(result)).not.toMatch(/[0-9a-f]{32}/);
  });

  it('refuses when the page has no submit button', async () => {
    page.submit = null;
    const result = await grantApproval(TAB);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('NO_SUBMIT');
  });

  it.each(['captcha', 'otp'] as const)('refuses while a %s is outstanding', async (type) => {
    // P4: approving *through* a security gate is the user asking us to do the
    // one thing we do not do. It is refused before a token exists.
    page.blockers = [{ type, reason: 'You must complete this yourself.', selector: '#c' }];

    const result = await grantApproval(TAB);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('BLOCKED');
    expect(approvalStatus(TAB).active).toBe(false);
  });

  it('records the approval in the audit log', async () => {
    await grantApproval(TAB);
    const log = await readAudit();

    expect(log.at(-1)?.event).toEqual({ t: 'submit.approved', target: '#btnFinalSubmit' });
    // The origin, not the full URL — see the audit log's own tests.
    expect(log.at(-1)?.site).toBe('https://portal.example.gov.in');
  });
});

describe('submitting', () => {
  it('sends exactly one submission, naming the approved element', async () => {
    await grantApproval(TAB);
    const result = await submitWithApproval(TAB);

    expect(result.ok === true && result.data.submitted).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe('fill:submit');
    expect(sent[0]?.token?.targetSelector).toBe('#btnFinalSubmit');
  });

  it('refuses when nothing was approved', async () => {
    const result = await submitWithApproval(TAB);

    expect(result.ok === true && result.data.submitted).toBe(false);
    expect(sent).toEqual([]);
  });

  it('refuses a second submission — the token is single-use', async () => {
    await grantApproval(TAB);
    await submitWithApproval(TAB);
    const second = await submitWithApproval(TAB);

    expect(second.ok === true && second.data.submitted).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it('refuses once the page has changed under the approval', async () => {
    // The user approved a page; a postback replaced it. What they agreed to
    // is not what would be sent.
    await grantApproval(TAB);
    page.fingerprint = 'fp-after-a-postback';

    const result = await submitWithApproval(TAB);

    expect(result.ok === true && result.data.submitted).toBe(false);
    expect(result.ok === true && result.data.why).toMatch(/changed/i);
    expect(sent).toEqual([]);
  });

  it('refuses once the submit button is not the one approved', async () => {
    await grantApproval(TAB);
    page.submit = { selector: '#btnPayAndSubmit', label: 'Pay and Submit' };

    const result = await submitWithApproval(TAB);

    expect(result.ok === true && result.data.submitted).toBe(false);
    expect(sent).toEqual([]);
  });

  it('burns the token even when the page refuses to submit', async () => {
    // A token that survives a failed submission is a token available for a
    // second attempt nobody approved.
    await grantApproval(TAB);
    pageSubmits = false;

    const first = await submitWithApproval(TAB);
    expect(first.ok === true && first.data.submitted).toBe(false);

    pageSubmits = true;
    const second = await submitWithApproval(TAB);
    expect(second.ok === true && second.data.submitted).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it('burns the token even when talking to the page throws', async () => {
    await grantApproval(TAB);
    pageThrows = true;

    await expect(submitWithApproval(TAB)).rejects.toThrow();

    pageThrows = false;
    const after = await submitWithApproval(TAB);
    expect(after.ok === true && after.data.submitted).toBe(false);
    expect(sent).toEqual([]);
  });

  it('ends the run, so the page cannot refill itself afterwards', async () => {
    await grantApproval(TAB);
    await submitWithApproval(TAB);

    expect(endRun).toHaveBeenCalledWith(TAB);
    expect(forgetTabReview).toHaveBeenCalledWith(TAB);
  });

  it('records the outcome either way', async () => {
    await grantApproval(TAB);
    await submitWithApproval(TAB);
    expect((await readAudit()).at(-1)?.event).toEqual({ t: 'submit.done' });

    await grantApproval(TAB);
    pageSubmits = false;
    await submitWithApproval(TAB);
    expect((await readAudit()).at(-1)?.event.t).toBe('submit.refused');
  });

  it('surfaces a page it could not read rather than submitting blind', async () => {
    await grantApproval(TAB);
    harvestFails = true;

    const result = await submitWithApproval(TAB);

    expect(result.ok).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe('revoking', () => {
  it('drops the approval on request', async () => {
    await grantApproval(TAB);
    revokeApproval(TAB);

    expect(approvalStatus(TAB).active).toBe(false);
    const result = await submitWithApproval(TAB);
    expect(result.ok === true && result.data.submitted).toBe(false);
  });

  it('keeps another tab’s approval intact', async () => {
    await grantApproval(TAB);
    await grantApproval(9);

    revokeApproval(TAB);

    expect(approvalStatus(9).active).toBe(true);
  });
});
