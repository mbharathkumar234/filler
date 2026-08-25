import { describe, expect, it } from 'vitest';

import {
  clamp,
  HIGH_SENSITIVITY_LLM_CEILING,
  LlmResponseInvalid,
  mergeSuggestions,
  parseSuggestions,
  unmappedRefs,
  type LlmSuggestion,
} from './llm-matcher';
import { CONFIDENCE, type MatchResult } from '@/shared/types';
import type { FieldKey } from './taxonomy';

/**
 * What we do when the model is wrong.
 *
 * Every test here assumes the reply is adversarial rather than merely
 * imperfect — invented keys, invented refs, confidences of 12, prose instead
 * of JSON. The model has no authority; this file is where that is true.
 */

const REFS = new Set(['f1', 'f2', 'f3']);

function reply(entries: unknown): string {
  return JSON.stringify(entries);
}

function rule(ref: string, key: string, confidence = 0.9): MatchResult {
  return {
    fieldRef: ref,
    key: key as FieldKey,
    confidence,
    rationale: 'matched by rule',
    source: 'rule',
  };
}

function unknown(ref: string): MatchResult {
  return {
    fieldRef: ref,
    key: 'unknown',
    confidence: 0,
    rationale: 'No rule matched this field.',
    source: 'rule',
  };
}

describe('parsing a well-behaved reply', () => {
  it('reads the contract the prompt asked for', () => {
    const out = parseSuggestions(
      reply([{ ref: 'f1', key: 'family.father_name', confidence: 0.72, why: 'label says father' }]),
      REFS,
    );

    expect(out).toEqual([
      { ref: 'f1', key: 'family.father_name', confidence: 0.72, why: 'label says father' },
    ]);
  });

  it('accepts an honest "unknown"', () => {
    const out = parseSuggestions(reply([{ ref: 'f1', key: 'unknown', confidence: 0, why: 'no fit' }]), REFS);
    expect(out[0]?.key).toBe('unknown');
  });

  it('tolerates a markdown fence', () => {
    const out = parseSuggestions(
      '```json\n[{"ref":"f1","key":"contact.email","confidence":0.8,"why":"email field"}]\n```',
      REFS,
    );
    expect(out).toHaveLength(1);
  });

  it('tolerates a sentence before the array', () => {
    const out = parseSuggestions(
      'Here are the mappings:\n[{"ref":"f1","key":"contact.email","confidence":0.8,"why":"x"}]',
      REFS,
    );
    expect(out).toHaveLength(1);
  });
});

describe('a model that does not follow the contract', () => {
  it('throws on prose, so the caller can spend its one retry', () => {
    expect(() => parseSuggestions('I am unable to help with that.', REFS)).toThrow();
  });

  it('throws on JSON that is not an array', () => {
    expect(() => parseSuggestions('{"ref":"f1"}', REFS)).toThrow(LlmResponseInvalid);
  });

  it('discards a key outside the taxonomy rather than adopting it', () => {
    // The closed vocabulary is enforced here, not merely requested in the
    // prompt. A model cannot widen the taxonomy by being confident.
    const out = parseSuggestions(
      reply([
        { ref: 'f1', key: 'identity.favourite_colour', confidence: 0.9, why: 'invented' },
        { ref: 'f2', key: 'contact.email', confidence: 0.8, why: 'real' },
      ]),
      REFS,
    );

    expect(out.map((s) => s.ref)).toEqual(['f2']);
  });

  it('discards a ref it invented', () => {
    const out = parseSuggestions(
      reply([{ ref: 'f99', key: 'contact.email', confidence: 0.8, why: 'x' }]),
      REFS,
    );
    expect(out).toEqual([]);
  });

  it('drops one malformed entry without losing the good ones', () => {
    const out = parseSuggestions(
      reply([
        null,
        'nonsense',
        { ref: 'f1', key: 'contact.email', confidence: 0.8, why: 'good' },
        { nothing: true },
      ]),
      REFS,
    );
    expect(out).toHaveLength(1);
  });

  it('keeps the first answer when it contradicts itself', () => {
    const out = parseSuggestions(
      reply([
        { ref: 'f1', key: 'contact.email', confidence: 0.8, why: 'first' },
        { ref: 'f1', key: 'contact.mobile', confidence: 0.9, why: 'second' },
      ]),
      REFS,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.key).toBe('contact.email');
  });

  it('supplies a rationale when the model omits one', () => {
    const out = parseSuggestions(reply([{ ref: 'f1', key: 'contact.email', confidence: 0.5 }]), REFS);
    expect(out[0]?.why).toBeTruthy();
  });

  it('trims a rationale that ran long — the review screen shows it', () => {
    const out = parseSuggestions(
      reply([{ ref: 'f1', key: 'contact.email', confidence: 0.5, why: 'w '.repeat(80) }]),
      REFS,
    );
    expect(out[0]!.why.split(/\s+/)).toHaveLength(12);
  });
});

describe('confidence is clamped, never believed', () => {
  it('caps an ordinary key at the LLM ceiling', () => {
    expect(clamp(0.99, 'contact.email')).toBe(CONFIDENCE.LLM_CEILING);
    expect(CONFIDENCE.LLM_CEILING).toBe(0.8);
  });

  it('an LLM match therefore never reaches the auto-fill band', () => {
    expect(CONFIDENCE.LLM_CEILING).toBeLessThan(CONFIDENCE.AUTO_FILL);
  });

  it.each([
    ['a number above one', 12, CONFIDENCE.LLM_CEILING],
    ['a negative', -5, 0],
    ['a string', '0.9', 0],
    ['NaN', Number.NaN, 0],
    ['missing', undefined, 0],
  ])('handles %s', (_name, value, expected) => {
    expect(clamp(value, 'contact.email')).toBe(expected);
  });

  it.each(['id.aadhaar', 'id.pan', 'bank.account_number'] as FieldKey[])(
    'caps %s below the fill threshold, so it is suggested and not written',
    (key) => {
      const capped = clamp(0.8, key);

      expect(capped).toBe(HIGH_SENSITIVITY_LLM_CEILING);
      // Below FILL_AND_FLAG means `buildWrites` leaves it blank: the value is
      // never put on the page on a model's say-so. Fill-and-flag would write
      // it first and ask afterwards, which is not what "without user
      // confirmation" can mean for an Aadhaar.
      expect(capped).toBeLessThan(CONFIDENCE.FILL_AND_FLAG);
    },
  );

  it('leaves a low-sensitivity key in the fill-and-flag band', () => {
    expect(clamp(0.7, 'identity.full_name')).toBeGreaterThanOrEqual(CONFIDENCE.FILL_AND_FLAG);
  });
});

describe('merging under the rules', () => {
  const suggestions: LlmSuggestion[] = [
    { ref: 'f1', key: 'contact.email', confidence: 0.8, why: 'model says email' },
    { ref: 'f2', key: 'contact.mobile', confidence: 0.7, why: 'model says mobile' },
  ];

  it('fills only what the rules left unknown', () => {
    const merged = mergeSuggestions([unknown('f1'), rule('f2', 'identity.full_name')], suggestions);

    expect(merged[0]).toMatchObject({ key: 'contact.email', source: 'llm' });
    // The rule wins outright — no confidence comparison, no tie-break.
    expect(merged[1]).toMatchObject({ key: 'identity.full_name', source: 'rule' });
  });

  it('rules win even when the rule was the less confident one', () => {
    const merged = mergeSuggestions([rule('f1', 'identity.full_name', 0.55)], suggestions);
    expect(merged[0]?.source).toBe('rule');
  });

  it('leaves a field unknown when the model also says unknown', () => {
    const merged = mergeSuggestions(
      [unknown('f1')],
      [{ ref: 'f1', key: 'unknown', confidence: 0, why: 'no fit' }],
    );
    expect(merged[0]?.key).toBe('unknown');
  });

  it('leaves a field unknown when the suggestion was clamped to nothing', () => {
    const merged = mergeSuggestions(
      [unknown('f1')],
      [{ ref: 'f1', key: 'contact.email', confidence: 0, why: 'x' }],
    );
    expect(merged[0]?.key).toBe('unknown');
  });

  it('marks its source, so the review screen can flag it', () => {
    const merged = mergeSuggestions([unknown('f1')], suggestions);
    expect(merged[0]?.source).toBe('llm');
    expect(merged[0]?.rationale).toBe('model says email');
  });

  it('changes nothing when there are no suggestions', () => {
    const before = [unknown('f1'), rule('f2', 'contact.email')];
    expect(mergeSuggestions(before, [])).toEqual(before);
  });
});

describe('unmappedRefs', () => {
  it('names exactly what the rules could not place', () => {
    expect(unmappedRefs([unknown('f1'), rule('f2', 'contact.email'), unknown('f3')])).toEqual([
      'f1',
      'f3',
    ]);
  });
});
