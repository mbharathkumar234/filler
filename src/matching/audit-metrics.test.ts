// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { harvest } from '@/content/harvester';
import { matchForm } from './deterministic';
import { CONFIDENCE } from '@/shared/types';

/**
 * The Phase A audit's measurement artifact (§ COMPLETION_PLAN A.2).
 *
 * The completion plan asks for four numbers that "can't be guessed", and is
 * explicit that a row is only green with a citable artifact. This file is that
 * artifact for numbers 1 and 2. Numbers 3 (pause/resume stability) and 4 (leak
 * status) are measured by suites that already exist and are cited in STATUS.md.
 *
 * ## The honest limit of number 1
 *
 * "Across all fixture forms" is not achievable as stated: only three of the
 * eight fixture pages carry `data-expect` ground truth. The other five exist to
 * exercise the *filler*, the *submit guard* and the *resume* path, and were
 * never annotated for matching. A mismatch rate can only be computed where
 * there is a right answer to compare against, so this reports the three that
 * have one and names the five that do not, rather than quietly computing a
 * number over a subset and calling it "all fixtures".
 */

const ANNOTATED = import.meta.glob('../../fixtures/*/page-1.html', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

interface Scored {
  label: string;
  expected: string;
  actual: string;
  confidence: number;
}

function evaluate(html: string): Scored[] {
  document.head.innerHTML = '';
  document.documentElement.innerHTML = html;
  const result = harvest(document);
  const matches = matchForm(result.fields);

  return result.fields.map((field, index) => {
    const element = result.elements.get(field.ref);
    const match = matches[index]!;
    return {
      label: field.labelText,
      expected: element?.getAttribute('data-expect') ?? 'unannotated',
      actual: match.key,
      confidence: match.confidence,
    };
  });
}

interface Report {
  fixture: string;
  fields: number;
  mappable: number;
  correctAtAnyConfidence: number;
  autoFilledCorrectly: number;
  /** The P0 number. Anything above zero is a release blocker. */
  highConfidenceMisMatches: number;
}

function report(name: string, scored: Scored[]): Report {
  const mappable = scored.filter((s) => s.expected !== 'unknown' && s.expected !== 'unannotated');
  return {
    fixture: name,
    fields: scored.length,
    mappable: mappable.length,
    correctAtAnyConfidence: mappable.filter((s) => s.actual === s.expected).length,
    autoFilledCorrectly: mappable.filter(
      (s) => s.actual === s.expected && s.confidence >= CONFIDENCE.AUTO_FILL,
    ).length,
    // Counted across *every* scored field, including the traps whose right
    // answer is "unknown": claiming a key for an office-use box at high
    // confidence is the same defect as claiming the wrong key.
    highConfidenceMisMatches: scored.filter(
      (s) =>
        s.expected !== 'unannotated' &&
        s.confidence >= CONFIDENCE.AUTO_FILL &&
        s.actual !== 'unknown' &&
        s.actual !== s.expected,
    ).length,
  };
}

const REPORTS: Report[] = Object.entries(ANNOTATED)
  .map(([path, html]) => ({ name: path.split('/').slice(-2, -1)[0]!, html }))
  .filter(({ html }) => html.includes('data-expect'))
  .sort((a, b) => a.name.localeCompare(b.name))
  .map(({ name, html }) => report(name, evaluate(html)));

const UNANNOTATED = Object.entries(ANNOTATED)
  .filter(([, html]) => !html.includes('data-expect'))
  .map(([path]) => path.split('/').slice(-2, -1)[0]!)
  .sort();

describe('A.2.1 — mismatch rate (deterministic matcher, no LLM)', () => {
  it('has ground truth on the fixtures it claims to measure', () => {
    expect(REPORTS.length).toBeGreaterThanOrEqual(3);
  });

  it('reports per-fixture numbers, for the record', () => {
    expect(REPORTS).toMatchSnapshot();
  });

  it('reports the totals, for the record', () => {
    const total = REPORTS.reduce(
      (acc, r) => ({
        fields: acc.fields + r.fields,
        mappable: acc.mappable + r.mappable,
        correctAtAnyConfidence: acc.correctAtAnyConfidence + r.correctAtAnyConfidence,
        autoFilledCorrectly: acc.autoFilledCorrectly + r.autoFilledCorrectly,
        highConfidenceMisMatches: acc.highConfidenceMisMatches + r.highConfidenceMisMatches,
      }),
      { fields: 0, mappable: 0, correctAtAnyConfidence: 0, autoFilledCorrectly: 0, highConfidenceMisMatches: 0 },
    );

    expect(total).toMatchSnapshot();
  });

  it('THE P0 NUMBER: zero high-confidence mis-mappings', () => {
    // The completion plan: "Target is zero. Report the actual number, not a
    // percentage — one wrong-but-confident field is a P0."
    const offenders = REPORTS.filter((r) => r.highConfidenceMisMatches > 0);
    expect(offenders).toEqual([]);
  });

  it('names the fixtures it cannot measure, rather than omitting them', () => {
    // These exist to exercise the filler, the guard and the resume path. They
    // have no `data-expect`, so no mismatch rate can be computed over them.
    expect(UNANNOTATED).toMatchSnapshot();
  });
});

describe('A.2.2 — coverage on a site never tuned against', () => {
  it('reports the fourth portal on its own, which is the universal-coverage estimate', () => {
    // The completion plan: "Pick a form you have never tuned against,
    // profiled, or taught. **This number is your universal-coverage
    // estimate.** Nothing else is."
    const fourth = REPORTS.find((r) => r.fixture === 'fourth-portal');
    expect(fourth).toBeDefined();

    const mapped = fourth!.correctAtAnyConfidence / fourth!.mappable;
    expect({
      mappedCorrectly: fourth!.correctAtAnyConfidence,
      of: fourth!.mappable,
      percent: Number((mapped * 100).toFixed(1)),
      highConfidenceMisMatches: fourth!.highConfidenceMisMatches,
    }).toMatchSnapshot();
  });

  it('is below the plan’s 85% bar on rules alone — the LLM tier is what closes it', () => {
    // Recorded as a fact, not a failure: the fixture was built to be hard for
    // the rules. The ≥85% gate is a rules+LLM number and needs an API key
    // (`eval-llm.test.ts`), which is why it is amber in STATUS.md.
    const fourth = REPORTS.find((r) => r.fixture === 'fourth-portal')!;
    expect(fourth.correctAtAnyConfidence / fourth.mappable).toBeLessThan(0.85);
  });
});
