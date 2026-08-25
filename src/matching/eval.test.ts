// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { harvest } from '@/content/harvester';
import { bandOf, matchForm } from './deterministic';
import { CONFIDENCE } from '@/shared/types';

/**
 * The §Phase 4 acceptance gate, amended for the any-portal target:
 *
 *   "across a fixture corpus of forms the matcher has **no profile for**,
 *    deterministic matching alone maps >=70% of fields at >=0.85 confidence,
 *    with **zero** high-confidence *mis*-mappings."
 *
 * Ground truth is a `data-expect` attribute on each control. The matcher never
 * reads data attributes, so annotating the fixture cannot leak into the answer.
 *
 * ## An honest limitation
 *
 * These fixtures are synthetic and were written by the same hand as the synonym
 * dictionary, so "held-out" here means *not tuned against* — not *independently
 * sourced*. The wording was chosen to differ from `synonyms.json` on purpose,
 * but this is weaker evidence than real portal HTML would be. Replace these
 * with captured pages as soon as real fixtures exist (see fixtures/README.md).
 */
const HELD_OUT = import.meta.glob('../../fixtures/heldout-*/*.html', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const PAGES = Object.entries(HELD_OUT)
  .map(([path, html]) => ({ name: path.split('/').slice(-2).join('/'), html }))
  .sort((a, b) => a.name.localeCompare(b.name));

interface Scored {
  label: string;
  expected: string;
  actual: string;
  confidence: number;
  band: string;
  rationale: string;
}

function evaluate(html: string): Scored[] {
  document.head.innerHTML = '';
  for (const match of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const style = document.createElement('style');
    style.textContent = match[1] ?? '';
    document.head.append(style);
  }
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;

  const { fields, elements } = harvest(document);
  const results = matchForm(fields);

  return fields.map((field, index) => {
    const element = elements.get(field.ref);
    const result = results[index]!;
    return {
      label: field.labelText,
      expected: element?.getAttribute('data-expect') ?? 'unannotated',
      actual: result.key,
      confidence: result.confidence,
      band: bandOf(result),
      rationale: result.rationale,
    };
  });
}

const ALL: Scored[] = PAGES.flatMap((page) => evaluate(page.html));

describe('held-out corpus', () => {
  it('has fixtures to evaluate', () => {
    expect(PAGES.length).toBeGreaterThanOrEqual(2);
    expect(ALL.length).toBeGreaterThan(40);
  });

  it('every field carries ground truth', () => {
    const missing = ALL.filter((s) => s.expected === 'unannotated').map((s) => s.label);
    expect(missing).toEqual([]);
  });
});

/**
 * The gate that matters most. §6.4 rates a high-confidence mis-match as
 * Critical — worse than a miss — so this is a hard zero, not a percentage.
 */
describe('zero high-confidence mis-mappings (P0)', () => {
  it('never auto-fills a field with the wrong key', () => {
    const wrong = ALL.filter(
      (s) =>
        s.confidence >= CONFIDENCE.AUTO_FILL &&
        s.actual !== 'unknown' &&
        s.actual !== s.expected,
    ).map((s) => `"${s.label}": got ${s.actual}, expected ${s.expected} (${s.confidence}) — ${s.rationale}`);

    expect(wrong).toEqual([]);
  });

  it('never auto-fills a field that should map to nothing', () => {
    const overreach = ALL.filter(
      (s) => s.expected === 'unknown' && s.band === 'auto-fill',
    ).map((s) => `"${s.label}": claimed ${s.actual} at ${s.confidence} — ${s.rationale}`);

    expect(overreach).toEqual([]);
  });

  it('respects the traits veto on the trap fields', () => {
    // A 10-digit numeric box labelled "Name" must not become a full name.
    const trap = ALL.find((s) => s.label === 'Name' && s.expected === 'unknown');
    expect(trap).toBeDefined();
    expect(trap?.actual).not.toBe('identity.full_name');
  });
});

describe('coverage gate: >=70% of mappable fields at >=0.85', () => {
  it('meets the bar across the whole held-out corpus', () => {
    const mappable = ALL.filter((s) => s.expected !== 'unknown');
    const correct = mappable.filter(
      (s) => s.actual === s.expected && s.confidence >= CONFIDENCE.AUTO_FILL,
    );
    const percent = (correct.length / mappable.length) * 100;

    const missed = mappable
      .filter((s) => !(s.actual === s.expected && s.confidence >= CONFIDENCE.AUTO_FILL))
      .map((s) => `"${s.label}" → ${s.actual}@${s.confidence} (want ${s.expected})`);

    expect(
      percent,
      `${correct.length}/${mappable.length} = ${percent.toFixed(1)}%\nmissed:\n  ${missed.join('\n  ')}`,
    ).toBeGreaterThanOrEqual(70);
  });

  it.each(PAGES)('$name meets the bar on its own', ({ html }) => {
    const scored = evaluate(html);
    const mappable = scored.filter((s) => s.expected !== 'unknown');
    const correct = mappable.filter(
      (s) => s.actual === s.expected && s.confidence >= CONFIDENCE.AUTO_FILL,
    );
    const missed = mappable
      .filter((s) => !(s.actual === s.expected && s.confidence >= CONFIDENCE.AUTO_FILL))
      .map((s) => `"${s.label}" → ${s.actual}@${s.confidence}`);

    expect(
      (correct.length / mappable.length) * 100,
      `missed:\n  ${missed.join('\n  ')}`,
    ).toBeGreaterThanOrEqual(70);
  });
});

describe('quality of the misses', () => {
  it('a wrong key below the auto-fill bar is still flagged, not silent', () => {
    const quietlyWrong = ALL.filter(
      (s) =>
        s.actual !== 'unknown' &&
        s.actual !== s.expected &&
        s.band === 'fill-and-flag' &&
        !s.rationale,
    );
    expect(quietlyWrong).toEqual([]);
  });

  it('every result explains itself', () => {
    expect(ALL.filter((s) => s.rationale.trim() === '')).toEqual([]);
  });

  it('reports the measured numbers, for the record', () => {
    const mappable = ALL.filter((s) => s.expected !== 'unknown');
    const autoCorrect = mappable.filter(
      (s) => s.actual === s.expected && s.confidence >= CONFIDENCE.AUTO_FILL,
    ).length;
    const anyCorrect = mappable.filter((s) => s.actual === s.expected).length;
    const wrongHigh = mappable.filter(
      (s) => s.actual !== s.expected && s.actual !== 'unknown' && s.confidence >= CONFIDENCE.AUTO_FILL,
    ).length;

    expect({
      fields: ALL.length,
      mappable: mappable.length,
      autoFilledCorrectly: autoCorrect,
      correctAtAnyConfidence: anyCorrect,
      highConfidenceMisMatches: wrongHigh,
    }).toMatchSnapshot();
  });
});
