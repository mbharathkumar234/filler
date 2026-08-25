// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { harvest } from '@/content/harvester';
import { matchForm } from './deterministic';
import { mergeSuggestions, parseSuggestions } from './llm-matcher';
import { redactFields } from '@/background/redaction';
import { denyListFrom, guardPayload } from '@/background/value-guard';
import { askModel, DEFAULT_MODEL } from '@/background/llm-client';
import { FIELD_KEYS } from './taxonomy';
import { CONFIDENCE } from '@/shared/types';

/**
 * § Phase 8 Verify — the fourth portal.
 *
 *   "on a *fourth* portal with no profile, LLM + rules maps >=85% of fields
 *    correctly. Canary test green. Delete the API key → extension still works
 *    on profiled sites."
 *
 * `fixtures/fourth-portal/` is that portal: municipal-register English
 * ("Appellation", "Progenitor", "Natal Date", "Habitation") chosen to be
 * outside the wording in `synonyms.json`, so the rules cannot carry it alone.
 * Ground truth lives in `data-expect`, which the matcher never reads.
 *
 * ## Two halves, and only one of them can run unattended
 *
 * The rules-only baseline runs every time. It is expected to be *poor* — that
 * is the point of the fixture — and it is asserted as a range rather than a
 * floor, because a baseline that quietly climbed to 85% would mean the fixture
 * had stopped being a test of the LLM path.
 *
 * The full gate makes a **real API call** and is skipped unless
 * `ANTHROPIC_API_KEY` is set. There is no recorded-response version of it: a
 * fixture reply would test this file's plumbing and tell you nothing about
 * whether a model can read a municipal form. Run it with:
 *
 *     ANTHROPIC_API_KEY=sk-ant-... npx vitest run src/matching/eval-llm.test.ts
 */

const PAGES = import.meta.glob('../../fixtures/fourth-portal/*.html', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

interface Scored {
  ref: string;
  label: string;
  expected: string;
  actual: string;
  confidence: number;
}

function loadPage(html: string) {
  document.head.innerHTML = '';
  document.documentElement.innerHTML = html;
  return harvest(document);
}

const HTML = Object.values(PAGES)[0] ?? '';

function score(actualByRef: Map<string, { key: string; confidence: number }>): Scored[] {
  const result = loadPage(HTML);
  return result.fields.map((field) => {
    const element = result.elements.get(field.ref);
    const actual = actualByRef.get(field.ref);
    return {
      ref: field.ref,
      label: field.labelText,
      expected: element?.getAttribute('data-expect') ?? 'unannotated',
      actual: actual?.key ?? 'unknown',
      confidence: actual?.confidence ?? 0,
    };
  });
}

function rulesOnly() {
  const result = loadPage(HTML);
  const matches = matchForm(result.fields);
  return {
    fields: result.fields,
    matches,
    scored: score(new Map(matches.map((m) => [m.fieldRef, { key: m.key, confidence: m.confidence }]))),
  };
}

function rate(scored: readonly Scored[]): { correct: number; mappable: number; percent: number } {
  const mappable = scored.filter((s) => s.expected !== 'unknown' && s.expected !== 'unannotated');
  const correct = mappable.filter((s) => s.actual === s.expected);
  return {
    correct: correct.length,
    mappable: mappable.length,
    percent: mappable.length === 0 ? 0 : (correct.length / mappable.length) * 100,
  };
}

describe('the fourth portal', () => {
  it('exists and is fully annotated', () => {
    expect(HTML.length).toBeGreaterThan(1_000);
    const { scored } = rulesOnly();
    expect(scored.filter((s) => s.expected === 'unannotated')).toEqual([]);
    expect(scored.length).toBeGreaterThanOrEqual(25);
  });

  it('has trap fields the rules must not claim', () => {
    // "Name" on a 4-digit numeric trade-category box, plus two office-use
    // fields. A matcher that maps these is guessing.
    const { scored } = rulesOnly();
    const traps = scored.filter((s) => s.expected === 'unknown');

    expect(traps.length).toBeGreaterThanOrEqual(3);
    for (const trap of traps) {
      expect(
        trap.confidence < CONFIDENCE.AUTO_FILL,
        `"${trap.label}" was auto-filled as ${trap.actual}`,
      ).toBe(true);
    }
  });
});

describe('rules-only baseline (always runs)', () => {
  it('is genuinely hard for the rules — that is what makes it a test of the LLM path', () => {
    const { scored } = rulesOnly();
    const { correct, mappable, percent } = rate(scored);

    const missed = scored
      .filter((s) => s.expected !== 'unknown' && s.actual !== s.expected)
      .map((s) => `  "${s.label}" → ${s.actual} (want ${s.expected})`);

    // Reported, not silently swallowed: this number is the thing the LLM has
    // to improve on, and it belongs in the test output.
    console.info(
      `[phase 8] rules-only on the fourth portal: ${correct}/${mappable} = ${percent.toFixed(1)}%\n${missed.join('\n')}`,
    );

    // An upper bound, deliberately. If the rules ever reach 85% here on their
    // own, this fixture has stopped being a fourth portal and a new one is
    // needed — do not "fix" this by raising the bound.
    expect(percent).toBeLessThan(85);
  });

  it('still refuses to auto-fill anything wrong (P0 holds without the model)', () => {
    const { scored } = rulesOnly();
    const wrong = scored.filter(
      (s) =>
        s.confidence >= CONFIDENCE.AUTO_FILL && s.actual !== 'unknown' && s.actual !== s.expected,
    );
    expect(wrong.map((s) => `${s.label} → ${s.actual}`)).toEqual([]);
  });
});

/**
 * The live gate. Real network, real model, real money.
 *
 * `it.skipIf` rather than a mock: this is the only assertion in the suite that
 * can actually answer "can a model read a form like this", and answering it
 * with a canned reply would be theatre.
 */
// Read without naming the `process` global: this file is compiled under the
// browser tsconfig, which has no Node types, and the extension itself must
// never gain them.
const apiKey =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.ANTHROPIC_API_KEY ?? '';

describe.skipIf(apiKey === '')('rules + LLM against the live model', () => {
  it('maps at least 85% of the mappable fields', { timeout: 120_000 }, async () => {
    const { fields, matches } = rulesOnly();

    const unmapped = matches.filter((m) => m.key === 'unknown').map((m) => m.fieldRef);
    const targets = fields.filter((f) => unmapped.includes(f.ref));

    // The same path the extension uses: redact, then guard, then send.
    const redacted = redactFields(targets);
    const guard = guardPayload(redacted.fields, denyListFrom([]));
    expect(guard.payload).not.toBeNull();

    const call = await askModel(guard.payload!, FIELD_KEYS, { apiKey, model: DEFAULT_MODEL });
    const suggestions = parseSuggestions(call.text, new Set(targets.map((f) => f.ref)));
    const merged = mergeSuggestions(matches, suggestions);

    const scored = score(
      new Map(merged.map((m) => [m.fieldRef, { key: m.key, confidence: m.confidence }])),
    );
    const { correct, mappable, percent } = rate(scored);

    const missed = scored
      .filter((s) => s.expected !== 'unknown' && s.actual !== s.expected)
      .map((s) => `  "${s.label}" → ${s.actual} (want ${s.expected})`);

    console.info(
      `[phase 8] rules + ${call.model}: ${correct}/${mappable} = ${percent.toFixed(1)}%` +
        ` (${call.usage.inputTokens} in / ${call.usage.outputTokens} out)\n${missed.join('\n')}`,
    );

    expect(percent, `${correct}/${mappable}\nmissed:\n${missed.join('\n')}`).toBeGreaterThanOrEqual(
      85,
    );
  });

  it('does not let the model auto-fill anything', { timeout: 120_000 }, async () => {
    // Every LLM answer is capped below AUTO_FILL, so nothing it suggests can
    // be written without appearing on the review screen first.
    const { fields, matches } = rulesOnly();
    const unmapped = matches.filter((m) => m.key === 'unknown').map((m) => m.fieldRef);
    const targets = fields.filter((f) => unmapped.includes(f.ref));

    const guard = guardPayload(redactFields(targets).fields, []);
    const call = await askModel(guard.payload!, FIELD_KEYS, { apiKey, model: DEFAULT_MODEL });
    const merged = mergeSuggestions(
      matches,
      parseSuggestions(call.text, new Set(targets.map((f) => f.ref))),
    );

    for (const result of merged.filter((m) => m.source === 'llm')) {
      expect(result.confidence).toBeLessThan(CONFIDENCE.AUTO_FILL);
    }
  });
});

describe('deleting the API key', () => {
  it('leaves the deterministic matcher working', () => {
    // The third clause of the Verify. No key is the default state of every
    // test in this file except the two above, and the rules still run.
    const { matches } = rulesOnly();
    expect(matches.some((m) => m.key !== 'unknown')).toBe(true);
  });
});
