import { describe, expect, it } from 'vitest';

import {
  buildReview,
  FLAG_TEXT,
  maskValue,
  needsAttention,
  worstFlag,
  type ReviewInput,
  type ReviewRecord,
} from './review';
import type { FieldDescriptor, MatchResult } from '@/shared/types';
import type { FieldKey } from '@/matching/taxonomy';

/**
 * The review model.
 *
 * The plan sets this phase's bar as a user-testing pass: plant one wrong value
 * and see whether three people catch it. These tests cannot run that pass, but
 * they can hold the line underneath it — that the model *surfaces* the thing a
 * person would need to catch, rather than leaving it as row 34 of 40.
 */

function field(over: Partial<FieldDescriptor> & { ref: string }): FieldDescriptor {
  return {
    selectors: [`#${over.ref}`],
    tag: 'input',
    labelText: 'A field',
    nearbyText: 'Personal details',
    required: false,
    frameId: 0,
    visible: true,
    enabled: true,
    ...over,
  };
}

function match(ref: string, key: string, confidence = 0.95, source: MatchResult['source'] = 'rule'): MatchResult {
  return { fieldRef: ref, key: key as FieldKey, confidence, rationale: `matched ${key}`, source };
}

function record(ref: string, over: Partial<ReviewRecord> = {}): ReviewRecord {
  return { ref, ok: true, ...over };
}

function input(over: Partial<ReviewInput> = {}): ReviewInput {
  return {
    fields: [field({ ref: 'f1', labelText: 'Candidate Name' })],
    matches: [match('f1', 'identity.full_name')],
    records: [record('f1')],
    values: new Map([['f1', 'Ravi Kumar']]),
    ...over,
  };
}

describe('what the user is shown first', () => {
  it('leads with the portal’s own label, not our key', () => {
    const model = buildReview(input());
    const row = model.rows[0]!;

    expect(row.portalLabel).toBe('Candidate Name');
    expect(row.key).toBe('identity.full_name');
  });

  it('says so plainly when the page gave a field no label at all', () => {
    const model = buildReview(
      input({ fields: [field({ ref: 'f1', labelText: '   ' })] }),
    );
    expect(model.rows[0]?.portalLabel).toMatch(/no label/i);
  });

  it('shows the value that is actually in the field, not the one we sent', () => {
    // The page upper-cased it. The review must show what is really there —
    // showing our version would hide exactly the mismatch worth catching.
    const model = buildReview(input({ values: new Map([['f1', 'RAVI KUMAR']]) }));
    expect(model.rows[0]?.value).toBe('RAVI KUMAR');
  });

  it('leaves out hidden fields, which nobody can check', () => {
    const model = buildReview(
      input({
        fields: [field({ ref: 'f1' }), field({ ref: 'f2', visible: false })],
        matches: [match('f1', 'identity.full_name'), match('f2', 'contact.email')],
        records: [record('f1'), record('f2')],
        values: new Map([
          ['f1', 'Ravi Kumar'],
          ['f2', 'ravi@example.com'],
        ]),
      }),
    );
    expect(model.rows.map((r) => r.ref)).toEqual(['f1']);
  });

  it('leaves out fields it neither touched nor has an opinion about', () => {
    const model = buildReview(
      input({
        fields: [field({ ref: 'f1' }), field({ ref: 'f2', labelText: 'Remarks' })],
        matches: [match('f1', 'identity.full_name')],
        records: [record('f1')],
        values: new Map([['f1', 'Ravi Kumar']]),
      }),
    );
    expect(model.rows.map((r) => r.ref)).toEqual(['f1']);
  });

  it('keeps a required field it never filled, because the user must', () => {
    const model = buildReview(
      input({
        fields: [field({ ref: 'f1' }), field({ ref: 'f2', labelText: 'Remarks', required: true })],
        values: new Map([['f1', 'Ravi Kumar']]),
      }),
    );
    expect(model.rows.map((r) => r.ref)).toEqual(['f1', 'f2']);
    expect(model.rows[1]?.flags).toContain('required-empty');
  });
});

describe('flagging what deserves a second look', () => {
  it.each([
    ['a value the page rejected', { fillFailed: true }, 'fill-failed'],
    ['a dropdown matched approximately', { fuzzy: true }, 'fuzzy-select'],
    ['a value shortened to fit', { truncated: true }, 'truncated'],
  ] as const)('flags %s', (_name, over, flag) => {
    const model = buildReview(input({ records: [record('f1', over)] }));
    expect(model.rows[0]?.flags).toContain(flag);
  });

  it('flags a match we were not confident about', () => {
    const model = buildReview(input({ matches: [match('f1', 'identity.full_name', 0.62)] }));
    expect(model.rows[0]?.flags).toContain('low-confidence');
  });

  it('does not flag a confident match', () => {
    const model = buildReview(input());
    expect(needsAttention(model.rows[0]!)).toBe(false);
  });

  it('flags a field recognised but deliberately left blank', () => {
    const model = buildReview(
      input({ matches: [match('f1', 'identity.full_name', 0.3)], records: [], values: new Map() }),
    );
    expect(model.rows[0]?.flags).toContain('skipped-low-confidence');
  });

  it('flags an LLM match — never trusted the way a rule is', () => {
    const model = buildReview(
      input({ matches: [match('f1', 'identity.full_name', 0.8, 'llm')] }),
    );
    expect(model.rows[0]?.flags).toContain('llm-matched');
  });

  it('flags a required field left empty', () => {
    const model = buildReview(
      input({
        fields: [field({ ref: 'f1', required: true })],
        values: new Map([['f1', '   ']]),
      }),
    );
    expect(model.rows[0]?.flags).toContain('required-empty');
  });

  it('marks a high-sensitivity key so the screen can mask it', () => {
    const model = buildReview(
      input({
        matches: [match('f1', 'id.aadhaar')],
        values: new Map([['f1', '234567890123']]),
      }),
    );
    expect(model.rows[0]?.flags).toContain('high-sensitivity');
    expect(model.rows[0]?.sensitivity).toBe('high');
  });

  it('marks what the user corrected themselves', () => {
    const model = buildReview(input({ edits: new Set(['f1']) }));
    expect(model.rows[0]?.flags).toContain('user-edited');
  });

  it('has human wording for every flag it can produce', () => {
    // A flag with no sentence behind it renders as a coloured dot that means
    // nothing to the person it was raised for.
    const model = buildReview(
      input({
        fields: [field({ ref: 'f1', required: true })],
        matches: [match('f1', 'id.aadhaar', 0.6, 'llm')],
        records: [record('f1', { truncated: true, fuzzy: true, fillFailed: true })],
        values: new Map([['f1', '']]),
        edits: new Set(['f1']),
      }),
    );

    expect(model.rows[0]!.flags.length).toBeGreaterThan(5);
    for (const flag of model.rows[0]!.flags) {
      expect(FLAG_TEXT[flag]).toBeTruthy();
    }
  });
});

describe('the attention list — the part that has to work', () => {
  it('hoists the flagged rows out of a long form', () => {
    // Forty clean fields and one bad one. Buried at row 34, a flag is
    // decoration; this is the test that says it must not be.
    const fields = Array.from({ length: 40 }, (_, i) =>
      field({ ref: `f${i}`, labelText: `Field ${i}` }),
    );
    const matches = fields.map((f) => match(f.ref, 'identity.full_name'));
    const records = fields.map((f) => record(f.ref, f.ref === 'f33' ? { fuzzy: true } : {}));
    const values = new Map(fields.map((f) => [f.ref, 'something']));

    const model = buildReview({ fields, matches, records, values });

    expect(model.attention.map((r) => r.ref)).toEqual(['f33']);
    expect(model.counts.total).toBe(40);
    expect(model.counts.flagged).toBe(1);
  });

  it('orders by what it costs the user to miss it', () => {
    const fields = [
      field({ ref: 'low' }),
      field({ ref: 'trunc' }),
      field({ ref: 'failed' }),
      field({ ref: 'fuzzy' }),
    ];
    const model = buildReview({
      fields,
      matches: [
        match('low', 'identity.full_name', 0.6),
        match('trunc', 'identity.full_name'),
        match('failed', 'identity.full_name'),
        match('fuzzy', 'identity.full_name'),
      ],
      records: [
        record('low'),
        record('trunc', { truncated: true }),
        record('failed', { fillFailed: true }),
        record('fuzzy', { fuzzy: true }),
      ],
      values: new Map(fields.map((f) => [f.ref, 'x'])),
    });

    expect(model.attention.map((r) => r.ref)).toEqual(['failed', 'fuzzy', 'trunc', 'low']);
  });

  it('does not treat sensitivity or an edit as a problem', () => {
    // Both are context, not defects. Putting them in the attention list would
    // dilute it with rows that are working exactly as intended.
    const model = buildReview(
      input({
        matches: [match('f1', 'id.aadhaar')],
        values: new Map([['f1', '234567890123']]),
        edits: new Set(['f1']),
      }),
    );

    expect(model.attention).toEqual([]);
    expect(worstFlag(model.rows[0]!)).toBeNull();
  });

  it('reports the worst flag on a row, not the first one added', () => {
    const model = buildReview(
      input({
        fields: [field({ ref: 'f1', required: true })],
        matches: [match('f1', 'identity.full_name', 0.6)],
        records: [record('f1', { truncated: true, fillFailed: true })],
        values: new Map([['f1', '']]),
      }),
    );
    expect(worstFlag(model.rows[0]!)).toBe('fill-failed');
  });
});

describe('grouping the way the page does', () => {
  it('keeps the portal’s own sections, in document order', () => {
    const fields = [
      field({ ref: 'f1', nearbyText: 'Personal details' }),
      field({ ref: 'f2', nearbyText: 'Personal details' }),
      field({ ref: 'f3', nearbyText: 'Address' }),
    ];
    const model = buildReview({
      fields,
      matches: fields.map((f) => match(f.ref, 'identity.full_name')),
      records: fields.map((f) => record(f.ref)),
      values: new Map(fields.map((f) => [f.ref, 'x'])),
    });

    expect(model.sections.map((s) => s.title)).toEqual(['Personal details', 'Address']);
    expect(model.sections[0]?.refs).toEqual(['f1', 'f2']);
  });

  it('has somewhere to put a field the page did not group', () => {
    const model = buildReview(input({ fields: [field({ ref: 'f1', nearbyText: '' })] }));
    expect(model.sections[0]?.title).toBe('Other fields');
  });

  it('truncates a section heading rather than letting it run away', () => {
    const long = 'A'.repeat(200);
    const model = buildReview(input({ fields: [field({ ref: 'f1', nearbyText: long })] }));
    expect(model.sections[0]!.title.length).toBeLessThanOrEqual(60);
    expect(model.sections[0]!.title.endsWith('…')).toBe(true);
  });
});

describe('the counts on the summary line', () => {
  it('counts filled, blank, flagged and required-blank separately', () => {
    const fields = [
      field({ ref: 'a' }),
      field({ ref: 'b', required: true }),
      field({ ref: 'c' }),
    ];
    const model = buildReview({
      fields,
      matches: fields.map((f) => match(f.ref, 'identity.full_name')),
      records: [record('a'), record('c', { fuzzy: true })],
      values: new Map([
        ['a', 'Ravi'],
        ['b', ''],
        ['c', 'Karnataka'],
      ]),
    });

    expect(model.counts).toEqual({
      total: 3,
      filled: 2,
      flagged: 2,
      blank: 1,
      requiredBlank: 1,
    });
  });

  it('knows when nothing was actually written', () => {
    const model = buildReview(input({ records: [], values: new Map([['f1', '']]) }));
    expect(model.empty).toBe(true);
  });
});

describe('the §5 diff the state machine consumes', () => {
  it('matches the flags, so the two views cannot disagree', () => {
    const fields = [
      field({ ref: 'a' }),
      field({ ref: 'b' }),
      field({ ref: 'c' }),
      field({ ref: 'd', required: true }),
    ];
    const model = buildReview({
      fields,
      matches: [
        match('a', 'identity.full_name', 0.6),
        match('b', 'identity.full_name'),
        match('c', 'identity.full_name'),
        match('d', 'identity.full_name'),
      ],
      records: [
        record('a'),
        record('b', { truncated: true }),
        record('c', { fuzzy: true, fillFailed: true }),
      ],
      values: new Map([
        ['a', 'x'],
        ['b', 'y'],
        ['c', 'z'],
        ['d', ''],
      ]),
    });

    expect(model.diff).toEqual({
      lowConfidence: ['a'],
      truncated: ['b'],
      fuzzySelect: ['c'],
      fillFailed: ['c'],
      requiredButEmpty: ['d'],
    });
  });
});

describe('masking a sensitive value', () => {
  it('keeps the last four, so the user can still tell which one it is', () => {
    expect(maskValue('234567890123')).toBe('••••••••0123');
  });

  it('hides a short value entirely', () => {
    expect(maskValue('123')).toBe('•••');
  });

  it('does not grow without bound for a long value', () => {
    expect(maskValue('A'.repeat(200)).length).toBeLessThanOrEqual(16);
  });

  it('never leaks the leading digits of an Aadhaar', () => {
    const masked = maskValue('234567890123');
    expect(masked).not.toContain('2345');
    expect(masked).not.toContain('6789');
  });
});

// ---------------------------------------------------------------------------
// Flags and masking, at their boundaries (§ mutation-testing gap)
// ---------------------------------------------------------------------------

describe('masking, at the length where it changes shape', () => {
  /**
   * `maskValue` shows the last four characters and dots the rest — except for
   * a value of four characters or fewer, which is dotted entirely, because
   * "show the last four" of a four-character value shows all of it.
   *
   * Mutation testing loosened `trimmed.length <= 4` to `< 4` and nothing
   * failed. Under that mutation a four-character value renders **in clear** on
   * the review screen. Four characters is not an unusual length for the things
   * this masks.
   */
  it('dots a four-character value completely', () => {
    expect(maskValue('1234')).toBe('••••');
    expect(maskValue('abcd')).toBe('••••');
  });

  it('shows only the last four of a five-character value', () => {
    const masked = maskValue('12345');
    expect(masked).toBe('•2345');
    expect(masked).not.toBe('12345');
  });

  it.each([0, 1, 2, 3, 4])('reveals nothing at all from a value of length %i', (length) => {
    const value = 'x'.repeat(length);
    expect(maskValue(value)).toBe('•'.repeat(length));
  });

  it('never returns the original for anything longer than four', () => {
    for (let length = 5; length <= 40; length += 1) {
      const value = 'abcdefghij0123456789ABCDEFGHIJ0123456789'.slice(0, length);
      const masked = maskValue(value);
      expect(masked, `length ${length}`).not.toBe(value);
      expect(masked.startsWith('•'), `length ${length}`).toBe(true);
    }
  });

  it('caps the dots, so a long value does not reveal its length', () => {
    const short = maskValue('x'.repeat(20));
    const long = maskValue('x'.repeat(2000));
    expect(long.length).toBe(short.length);
  });

  it('masks by the trimmed value, not the padded one', () => {
    expect(maskValue('  1234  ')).toBe('••••');
  });
});

describe('flags fire for their own reason and no other', () => {
  /**
   * Each of these was a surviving mutant: flipping the `&&` in a flag
   * condition to `||` broke nothing, because every test asserted a flag was
   * *present* when it should be and none asserted it was *absent* when it
   * should not be. A review screen that flags everything trains people to tick
   * past flags, which is the same failure as flagging nothing.
   */
  function flagsFor(over: {
    field?: Partial<FieldDescriptor>;
    match?: Partial<MatchResult> | null;
    record?: { ref: string; ok: boolean; fuzzy?: boolean; truncated?: boolean; fillFailed?: boolean };
    value?: string;
  }) {
    const field: FieldDescriptor = {
      ref: 'f1',
      selectors: ['#f1'],
      tag: 'input',
      labelText: 'A field',
      nearbyText: '',
      required: false,
      frameId: 0,
      visible: true,
      enabled: true,
      ...over.field,
    };
    const match =
      over.match === null
        ? undefined
        : ({
            fieldRef: 'f1',
            key: 'identity.full_name',
            confidence: 0.95,
            rationale: 'rule',
            source: 'rule',
            ...over.match,
          } as MatchResult);

    const model = buildReview({
      fields: [field],
      matches: match ? [match] : [],
      records: over.record ? [over.record] : [{ ref: 'f1', ok: true }],
      values: new Map([['f1', over.value ?? 'Ravi Kumar']]),
    });
    return model.rows[0]?.flags ?? [];
  }

  it('does not flag required-empty on a field that is not required', () => {
    expect(flagsFor({ field: { required: false }, value: '' })).not.toContain('required-empty');
  });

  it('does not flag required-empty on a required field that was filled', () => {
    expect(flagsFor({ field: { required: true }, value: 'Ravi Kumar' })).not.toContain('required-empty');
  });

  it('does flag required-empty when both halves are true', () => {
    expect(flagsFor({ field: { required: true }, value: '   ' })).toContain('required-empty');
  });

  it('does not flag high-sensitivity on an ordinary key', () => {
    // Under the mutation every matched field is flagged high-sensitivity, so
    // every value on the screen is masked and the distinction stops meaning
    // anything.
    expect(flagsFor({ match: { key: 'identity.full_name' } })).not.toContain('high-sensitivity');
  });

  it('does flag high-sensitivity on a key that is one', () => {
    expect(flagsFor({ match: { key: 'id.aadhaar' } })).toContain('high-sensitivity');
  });

  it('raises no confidence flag when there is no match at all', () => {
    const flags = flagsFor({ match: null });
    expect(flags).not.toContain('low-confidence');
    expect(flags).not.toContain('llm-matched');
    expect(flags).not.toContain('high-sensitivity');
  });

  it('raises no confidence flag for a match whose key is not a real one', () => {
    // `key` is null when the match came back `unknown`. The mutation makes the
    // confidence block run anyway, and it then reads sensitivity for a key
    // that is not in the taxonomy. Distinct from the no-match case above: here
    // there *is* a match object.
    const flags = flagsFor({ match: { key: 'unknown' as never, confidence: 0.4 } });
    expect(flags).not.toContain('low-confidence');
    expect(flags).not.toContain('skipped-low-confidence');
    expect(flags).not.toContain('high-sensitivity');
  });

  it('carries maxLength only when the field has one', () => {
    // A row that reports `maxLength: undefined` reads, everywhere downstream,
    // as a field with a length limit nobody can name.
    const withLimit = buildReview({
      fields: [{ ref: 'f1', selectors: ['#f1'], tag: 'input', labelText: 'L', nearbyText: '', required: false, frameId: 0, visible: true, enabled: true, maxLength: 10 }],
      matches: [],
      records: [{ ref: 'f1', ok: true }],
      values: new Map([['f1', 'v']]),
    });
    const without = buildReview({
      fields: [{ ref: 'f1', selectors: ['#f1'], tag: 'input', labelText: 'L', nearbyText: '', required: false, frameId: 0, visible: true, enabled: true }],
      matches: [],
      records: [{ ref: 'f1', ok: true }],
      values: new Map([['f1', 'v']]),
    });

    expect(withLimit.rows[0]).toMatchObject({ maxLength: 10 });
    expect('maxLength' in (without.rows[0] as object)).toBe(false);
  });

  it('does not flag fuzzy-select or truncated on a clean record', () => {
    const flags = flagsFor({ record: { ref: 'f1', ok: true } });
    expect(flags).not.toContain('fuzzy-select');
    expect(flags).not.toContain('truncated');
    expect(flags).not.toContain('fill-failed');
  });
});
