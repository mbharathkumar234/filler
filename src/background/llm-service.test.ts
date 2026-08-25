import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLearnedStorage, loadLearned, type LearnedStorage } from '@/matching/learned-profiles';
import { CONFIDENCE, type FieldDescriptor, type MatchResult } from '@/shared/types';
import type { FieldKey } from '@/matching/taxonomy';

/**
 * The orchestration, and mostly the ways it declines to call.
 *
 * Every branch that returns without sending is a privacy control, and each one
 * has a test that would fail if it were removed. The single test that *does*
 * send exists to prove the others are not passing vacuously.
 */

vi.mock('@/vault/session', () => ({
  isUnlocked: () => true,
  withKey: async () => {
    throw new Error('the vault should not be reached in these tests');
  },
}));

vi.mock('@/vault/profile-store', () => ({ getAllFields: async () => [] }));
vi.mock('@/vault/db', () => ({ openVaultDb: async () => ({}) }));
vi.mock('@/vault/settings-store', () => ({
  API_KEY_SETTING: 'llm.apiKey',
  MODEL_SETTING: 'llm.model',
  getSetting: async () => null,
  putSetting: async () => {},
  deleteSetting: async () => {},
  hasSetting: async () => false,
}));

const { enrichWithLlm, readUsage, recordUsage, resetUsage, setUsageStorage } = await import(
  './llm-service'
);

// ---------------------------------------------------------------------------

function memoryArea(): LearnedStorage & { items: Map<string, unknown> } {
  const items = new Map<string, unknown>();
  return {
    items,
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

function field(ref: string, label: string): FieldDescriptor {
  return {
    ref,
    selectors: [`#${ref}`, `input[name="${ref}"]`],
    tag: 'input',
    labelText: label,
    nearbyText: 'Personal Details',
    required: false,
    frameId: 0,
    visible: true,
    enabled: true,
  };
}

function unknownMatch(ref: string): MatchResult {
  return { fieldRef: ref, key: 'unknown', confidence: 0, rationale: 'no rule', source: 'rule' };
}

function ruleMatch(ref: string, key: string): MatchResult {
  return { fieldRef: ref, key: key as FieldKey, confidence: 0.95, rationale: 'rule', source: 'rule' };
}

const FIELDS = [field('f1', 'Guardian Relationship'), field('f2', 'Ward Number')];
const RULES = [unknownMatch('f1'), unknownMatch('f2')];

/** The body a transport was called with, typed for the assertions below. */
function sentBody(transport: { mock: { calls: unknown[][] } }, index = 0): string {
  const init = transport.mock.calls[index]?.[1] as RequestInit | undefined;
  return String(init?.body ?? '');
}

function replyWith(entries: unknown, usage = { input_tokens: 100, output_tokens: 20 }) {
  return () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: JSON.stringify(entries) }],
          usage,
        }),
        { status: 200 },
      ),
    );
}

const OPTIONS = {
  url: 'https://portal.example.gov.in/apply',
  fingerprint: 'fp-new-form',
  overrides: { apiKey: 'sk-ant-test', denyList: [], unlocked: true, learned: null },
};

let storage: ReturnType<typeof memoryArea>;

beforeEach(() => {
  storage = memoryArea();
  setLearnedStorage(storage);
  setUsageStorage(storage);
});

describe('when the model is not called at all', () => {
  it('does not call when the rules mapped everything', async () => {
    const transport = vi.fn();
    const outcome = await enrichWithLlm(
      FIELDS,
      [ruleMatch('f1', 'contact.email'), ruleMatch('f2', 'contact.mobile')],
      { ...OPTIONS, transport },
    );

    expect(outcome.called).toBe(false);
    expect(transport).not.toHaveBeenCalled();
  });

  it('does not call when this form was already learned — once per form, ever', async () => {
    const transport = vi.fn();
    const outcome = await enrichWithLlm(FIELDS, RULES, {
      ...OPTIONS,
      transport,
      overrides: {
        ...OPTIONS.overrides,
        learned: {
          siteId: 'learned:portal',
          version: 1,
          matchUrl: 'https://portal.example.gov.in',
          formFingerprint: 'fp-new-form',
          createdAt: '',
          lastVerifiedAt: '',
          fields: [],
          documents: [],
          submit: { selectors: [], label: '' },
          blockers: [],
        },
      },
    });

    expect(outcome.called).toBe(false);
    expect(outcome.notice).toMatch(/learned earlier/i);
    expect(transport).not.toHaveBeenCalled();
  });

  it('does not call when the vault is locked — no denylist, no send', async () => {
    // The denylist is what stops the page echoing the user's own name at the
    // model. Without it there is no check, so there is no call. Fail closed.
    const transport = vi.fn();
    const outcome = await enrichWithLlm(FIELDS, RULES, {
      ...OPTIONS,
      transport,
      overrides: { ...OPTIONS.overrides, unlocked: false },
    });

    expect(outcome.called).toBe(false);
    expect(outcome.notice).toMatch(/unlock/i);
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([null, '', '   '])('does not call with an API key of %j', async (apiKey) => {
    const transport = vi.fn();
    const outcome = await enrichWithLlm(FIELDS, RULES, {
      ...OPTIONS,
      transport,
      overrides: { ...OPTIONS.overrides, apiKey },
    });

    expect(outcome.called).toBe(false);
    expect(outcome.notice).toMatch(/no api key/i);
    expect(transport).not.toHaveBeenCalled();
  });

  it('does not call when the guard refuses the payload', async () => {
    const transport = vi.fn();
    // Contrived on purpose: a needle that scrubs to itself survives its own
    // removal, so the guard's post-check fires. What matters is that a refusal
    // stops the send — not how this particular one was provoked.
    const outcome = await enrichWithLlm(
      [field('f1', 'Guardian [redacted] Relationship')],
      [unknownMatch('f1')],
      { ...OPTIONS, transport, overrides: { ...OPTIONS.overrides, denyList: ['[redacted]'] } },
    );

    expect(outcome.called).toBe(false);
    expect(outcome.notice).toMatch(/survived redaction|refused/i);
    expect(transport).not.toHaveBeenCalled();
  });

  it('leaves the deterministic results untouched every time it declines', async () => {
    const outcome = await enrichWithLlm(FIELDS, RULES, {
      ...OPTIONS,
      overrides: { ...OPTIONS.overrides, apiKey: null },
    });
    expect(outcome.results).toEqual(RULES);
  });
});

describe('when it does call', () => {
  it('maps the fields the rules could not place', async () => {
    const transport = vi.fn(
      replyWith([
        { ref: 'f1', key: 'family.guardian_name', confidence: 0.75, why: 'guardian label' },
        { ref: 'f2', key: 'unknown', confidence: 0, why: 'no fit' },
      ]),
    );

    const outcome = await enrichWithLlm(FIELDS, RULES, { ...OPTIONS, transport });

    expect(outcome.called).toBe(true);
    expect(outcome.results[0]).toMatchObject({ key: 'family.guardian_name', source: 'llm' });
    expect(outcome.results[1]?.key).toBe('unknown');
  });

  it('sends only the fields the rules could not place', async () => {
    const transport = vi.fn(replyWith([]));
    await enrichWithLlm(FIELDS, [ruleMatch('f1', 'contact.email'), unknownMatch('f2')], {
      ...OPTIONS,
      transport,
    });

    const body = JSON.parse(sentBody(transport)) as { messages: { content: string }[] };
    const prompt = body.messages[0]!.content;

    expect(prompt).toContain('Ward Number');
    expect(prompt).not.toContain('Guardian Relationship');
  });

  it('never puts the page URL in the prompt', async () => {
    const transport = vi.fn(replyWith([]));
    await enrichWithLlm(FIELDS, RULES, { ...OPTIONS, transport });

    expect(sentBody(transport)).not.toContain('portal.example.gov.in');
  });

  it('sends the closed vocabulary, so the model has a list to choose from', async () => {
    const transport = vi.fn(replyWith([]));
    await enrichWithLlm(FIELDS, RULES, { ...OPTIONS, transport });

    const prompt = sentBody(transport);
    expect(prompt).toContain('ALLOWED KEYS');
    expect(prompt).toContain('family.father_name');
    expect(prompt).toContain('Never invent keys');
  });

  it('caps what the model claims', async () => {
    const transport = vi.fn(
      replyWith([{ ref: 'f1', key: 'family.guardian_name', confidence: 0.99, why: 'sure' }]),
    );

    const outcome = await enrichWithLlm(FIELDS, RULES, { ...OPTIONS, transport });
    expect(outcome.results[0]?.confidence).toBe(CONFIDENCE.LLM_CEILING);
  });

  it('writes a profile, so the same form never needs the model again', async () => {
    const transport = vi.fn(
      replyWith([{ ref: 'f1', key: 'family.guardian_name', confidence: 0.7, why: 'x' }]),
    );

    const outcome = await enrichWithLlm(FIELDS, RULES, { ...OPTIONS, transport });

    expect(outcome.learned).toBeTruthy();
    const learned = await loadLearned();
    expect(learned).toHaveLength(1);
    expect(learned[0]?.formFingerprint).toBe('fp-new-form');
    expect(learned[0]?.fields[0]).toMatchObject({ key: 'family.guardian_name', source: 'llm' });
    // The selectors come with it, which is what makes the profile reusable.
    expect(learned[0]?.fields[0]?.selectors).toContain('#f1');
  });

  it('writes no profile when the model placed nothing', async () => {
    const transport = vi.fn(replyWith([{ ref: 'f1', key: 'unknown', confidence: 0, why: 'no' }]));
    const outcome = await enrichWithLlm(FIELDS, RULES, { ...OPTIONS, transport });

    expect(outcome.learned).toBeUndefined();
    expect(await loadLearned()).toEqual([]);
  });
});

describe('when the call goes wrong', () => {
  it('retries exactly once on a malformed reply', async () => {
    const transport = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(JSON.stringify({ content: [{ type: 'text', text: 'I cannot help' }] }), {
            status: 200,
          }),
        ),
      )
      .mockImplementationOnce(
        replyWith([{ ref: 'f1', key: 'family.guardian_name', confidence: 0.7, why: 'x' }]),
      );

    const outcome = await enrichWithLlm(FIELDS, RULES, { ...OPTIONS, transport });

    expect(transport).toHaveBeenCalledTimes(2);
    expect(outcome.results[0]?.source).toBe('llm');
  });

  it('gives up after the second malformed reply rather than burning calls', async () => {
    const transport = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ content: [{ type: 'text', text: 'still prose' }] }), {
          status: 200,
        }),
      ),
    );

    const outcome = await enrichWithLlm(FIELDS, RULES, { ...OPTIONS, transport });

    expect(transport).toHaveBeenCalledTimes(2);
    expect(outcome.results).toEqual(RULES);
    expect(outcome.notice).toMatch(/expected format/i);
  });

  it.each([
    [401, /rejected/i],
    [429, /rate-limited/i],
    [500, /error/i],
  ])('degrades on HTTP %i with a notice', async (status, expected) => {
    const transport = vi.fn(() => Promise.resolve(new Response('{}', { status })));
    const outcome = await enrichWithLlm(FIELDS, RULES, { ...OPTIONS, transport });

    expect(outcome.results).toEqual(RULES);
    expect(outcome.notice).toMatch(expected);
  });

  it('degrades when the network is unreachable', async () => {
    const transport = vi.fn(() => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED')));
    const outcome = await enrichWithLlm(FIELDS, RULES, { ...OPTIONS, transport });

    expect(outcome.results).toEqual(RULES);
    expect(outcome.notice).toMatch(/could not reach/i);
  });

  it('never throws, whatever the transport does', async () => {
    const transport = vi.fn(() => {
      throw new TypeError('something very unexpected');
    });
    await expect(enrichWithLlm(FIELDS, RULES, { ...OPTIONS, transport })).resolves.toBeTruthy();
  });
});

describe('the usage meter', () => {
  it('starts at zero', async () => {
    expect(await readUsage()).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0 });
  });

  it('accumulates, so the cost is visible before a bill is', async () => {
    await recordUsage({ inputTokens: 100, outputTokens: 20 });
    await recordUsage({ inputTokens: 50, outputTokens: 10 });

    expect(await readUsage()).toEqual({ calls: 2, inputTokens: 150, outputTokens: 30 });
  });

  it('resets on request', async () => {
    await recordUsage({ inputTokens: 100, outputTokens: 20 });
    await resetUsage();
    expect((await readUsage()).calls).toBe(0);
  });

  it('records counts and nothing else', async () => {
    await recordUsage({ inputTokens: 100, outputTokens: 20 });
    const raw = JSON.stringify([...storage.items.values()]);
    expect(raw).not.toMatch(/[a-z]{4,}@/);
  });
});
