// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { harvest } from '@/content/harvester';
import { matchForm } from './deterministic';
import { CONFIDENCE } from '@/shared/types';

/**
 * The held-out benchmark (§ COMPLETION_PLAN Phase E).
 *
 *   "Assemble 10 forms across varied stacks (old ASP.NET, React SPA, PHP, a
 *    Google Form, a plain HTML form) that you have never tuned against. Report
 *    mapped / unmapped / mismatched for each."
 *
 *   Gate: ">=85% correctly mapped and **zero** high-confidence mismatches."
 *
 * The Phase A audit measured this on a sample of **one** form and got 63%. That
 * is not a coverage estimate, it is an anecdote. `fixtures/bench/` is the ten
 * the plan asks for, and they vary along the axis that actually stresses the
 * matcher — *how the field is labelled*:
 *
 *  01 ASP.NET      label in the adjacent table cell, generated ids
 *  02 React SPA    aria-label only; no `name` attribute anywhere
 *  03 PHP legacy   bare text nodes and `<br>`; no `<label>` at all
 *  04 Google Form  `aria-labelledby` pointing at heading divs
 *  05 Plain HTML5  proper labels *and* `autocomplete` — the ceiling
 *  06 Bootstrap    placeholder as the only visible label
 *  07 Wizard       mid-flow, bank details, `<legend>` for context
 *  08 Bilingual    Devanagari + English in one label
 *  09 Grid         labels in `<th>`, inputs in the row beneath
 *  10 Components   open shadow roots, one custom element per field
 *
 * ## Which half of the gate this file can enforce
 *
 * **Zero high-confidence mismatches: enforced.** That is the P0 half and it
 * needs no API key.
 *
 * **>=85% mapped: reported, not enforced.** The plan's 85% is a *rules + LLM*
 * number and the LLM tier needs a live key (`eval-llm.test.ts`). What is
 * asserted here is the rules-only floor, so a regression is caught, plus the
 * per-form table for the record.
 */

const PAGES = import.meta.glob('../../fixtures/bench/*.html', {
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

interface Row {
  form: string;
  fields: number;
  mappable: number;
  mapped: number;
  unmapped: number;
  /** The P0 count: confidently wrong. */
  mismatched: number;
  percent: number;
}

function evaluate(html: string): Scored[] {
  document.head.innerHTML = '';
  document.documentElement.innerHTML = html;

  // Fixture 10 builds its fields from a script; run it before harvesting.
  for (const script of [...document.querySelectorAll('script')]) {
    if (script.textContent) {
      const replacement = document.createElement('script');
      replacement.textContent = script.textContent;
      script.replaceWith(replacement);
    }
  }

  const result = harvest(document, { shadowDom: true });
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

function score(form: string, scored: Scored[]): Row {
  const mappable = scored.filter((s) => s.expected !== 'unknown' && s.expected !== 'unannotated');
  const mapped = mappable.filter((s) => s.actual === s.expected).length;

  return {
    form,
    fields: scored.length,
    mappable: mappable.length,
    mapped,
    unmapped: mappable.filter((s) => s.actual === 'unknown').length,
    mismatched: scored.filter(
      (s) =>
        s.expected !== 'unannotated' &&
        s.confidence >= CONFIDENCE.AUTO_FILL &&
        s.actual !== 'unknown' &&
        s.actual !== s.expected,
    ).length,
    percent: mappable.length === 0 ? 0 : Number(((mapped / mappable.length) * 100).toFixed(1)),
  };
}

const SCORED = new Map<string, Scored[]>();
const ROWS: Row[] = Object.entries(PAGES)
  .map(([path, html]) => ({ name: path.split('/').pop()!.replace('.html', ''), html }))
  .sort((a, b) => a.name.localeCompare(b.name))
  .map(({ name, html }) => {
    const scored = evaluate(html);
    SCORED.set(name, scored);
    return score(name, scored);
  });

const TOTAL = ROWS.reduce(
  (acc, r) => ({
    fields: acc.fields + r.fields,
    mappable: acc.mappable + r.mappable,
    mapped: acc.mapped + r.mapped,
    unmapped: acc.unmapped + r.unmapped,
    mismatched: acc.mismatched + r.mismatched,
  }),
  { fields: 0, mappable: 0, mapped: 0, unmapped: 0, mismatched: 0 },
);

describe('the benchmark corpus', () => {
  it('is the ten forms the plan asks for', () => {
    expect(ROWS).toHaveLength(10);
  });

  it('covers the stacks the plan names', () => {
    const names = ROWS.map((r) => r.form).join(' ');
    for (const stack of ['aspnet', 'react', 'php', 'google-form', 'plain-html5']) {
      expect(names, `no fixture for ${stack}`).toContain(stack);
    }
  });

  it('is fully annotated — a field with no right answer measures nothing', () => {
    const unannotated: string[] = [];
    for (const [form, scored] of SCORED) {
      for (const s of scored) if (s.expected === 'unannotated') unannotated.push(`${form}: ${s.label}`);
    }
    expect(unannotated).toEqual([]);
  });

  it('has enough fields to be worth quoting a percentage of', () => {
    expect(TOTAL.mappable).toBeGreaterThanOrEqual(100);
  });
});

describe('THE P0 GATE — zero high-confidence mismatches', () => {
  it('never auto-fills a wrong key, on any of the ten', () => {
    // The half of the plan's gate that can be enforced without an API key, and
    // the half that matters most: "a confidently wrong field on an unfamiliar
    // site is the failure mode that ends this product."
    const offenders: string[] = [];
    for (const [form, scored] of SCORED) {
      for (const s of scored) {
        if (
          s.expected !== 'unannotated' &&
          s.confidence >= CONFIDENCE.AUTO_FILL &&
          s.actual !== 'unknown' &&
          s.actual !== s.expected
        ) {
          offenders.push(`${form}: "${s.label}" → ${s.actual}@${s.confidence} (want ${s.expected})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never auto-fills a field whose right answer is "nothing"', () => {
    // Every fixture carries at least one office-use or unrelated field.
    const overreach: string[] = [];
    for (const [form, scored] of SCORED) {
      for (const s of scored) {
        if (s.expected === 'unknown' && s.confidence >= CONFIDENCE.AUTO_FILL) {
          overreach.push(`${form}: "${s.label}" → ${s.actual}@${s.confidence}`);
        }
      }
    }
    expect(overreach).toEqual([]);
  });
});

describe('coverage, reported per form', () => {
  it('records the table', () => {
    expect(ROWS).toMatchSnapshot();
  });

  it('records the total', () => {
    expect({
      ...TOTAL,
      percent: Number(((TOTAL.mapped / TOTAL.mappable) * 100).toFixed(1)),
    }).toMatchSnapshot();
  });

  it('prints the misses, so the next improvement is obvious', () => {
    const lines: string[] = [];
    for (const [form, scored] of SCORED) {
      for (const s of scored) {
        if (s.expected === 'unknown' || s.expected === 'unannotated') continue;
        if (s.actual === s.expected) continue;
        lines.push(`  ${form}  "${s.label}" → ${s.actual}@${s.confidence} (want ${s.expected})`);
      }
    }
    console.info(
      `[phase E] rules-only across 10 held-out forms: ${TOTAL.mapped}/${TOTAL.mappable} = ` +
        `${((TOTAL.mapped / TOTAL.mappable) * 100).toFixed(1)}%, ` +
        `${TOTAL.mismatched} high-confidence mismatches\n${lines.join('\n')}`,
    );
    expect(lines.length).toBeGreaterThanOrEqual(0);
  });

  /**
   * A floor, not the plan's gate.
   *
   * The plan's >=85% is rules + LLM. This asserts the rules-only number does
   * not regress, and is deliberately set just below what is measured today
   * rather than at an aspiration — a gate nobody can pass gets deleted, and a
   * gate set at today's number fails on every unrelated synonym edit.
   */
  it('does not regress below the rules-only floor', () => {
    const percent = (TOTAL.mapped / TOTAL.mappable) * 100;
    expect(percent).toBeGreaterThanOrEqual(60);
  });

  it('the well-built form scores far higher than the hostile ones', () => {
    // 05 declares `autocomplete`. If the matcher cannot do well *there*, the
    // problem is not the portals.
    const plain = ROWS.find((r) => r.form.includes('plain-html5'))!;
    expect(plain.percent).toBeGreaterThanOrEqual(85);
  });
});
