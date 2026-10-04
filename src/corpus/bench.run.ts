// @vitest-environment jsdom
/**
 * `npm run bench` — the mapping half of the benchmark (U0.M5, `MASTER_PROMPT.md`).
 *
 * Every corpus snapshot (`fixtures/corpus/<category>/<name>.html`) is opened,
 * harvested and matched exactly as the product does it, and every field is
 * scored against its `data-expect` (`metrics.ts`). The made-up fixtures are
 * measured too, apart: they were written by the same hand as the synonym list,
 * so they say whether something broke, never how good the product is.
 *
 * Writes `bench/results.json` (counts only; the same on every run),
 * `bench/summary.md` (readable, with every mistake listed by label) and
 * `bench/timing.json` (not committed: times vary run to run). With
 * `--baseline` it also writes `bench/baseline.json`; without it, a baseline
 * that exists is the bar (`bench/README.md`). Run only by `npm run bench`,
 * never by `npm test`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { harvest } from '@/content/harvester';
import { matchForm } from '@/matching/deterministic';
import { accuracy, combine, judge, tally, type FieldOutcome, type Tally } from './metrics';
import { openSnapshot } from './open';
import { extendSplit, splitIsHonest, type Side, type SplitEntry } from './split';

const BENCH = join(process.cwd(), 'bench');

const CORPUS = import.meta.glob('../../fixtures/corpus/*/*.html', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const MADE_UP = import.meta.glob(['../../fixtures/bench/*.html', '../../fixtures/heldout-*/*.html', '../../fixtures/*-portal/*.html'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

interface Field {
  label: string;
  outcome: FieldOutcome;
}

interface PageResult {
  page: string;
  set: 'corpus' | 'made-up';
  category: string;
  side: Side | null;
  tally: Tally;
  mistakes: Array<{ label: string; expected: string; actual: string; confidence: number }>;
  missed: Array<{ label: string; expected: string }>;
}

/**
 * A made-up fixture as a browser leaves it, its own scripts run.
 *
 * The bench loads each page several times in one window, so each script runs
 * in a block of its own (a page's top-level `const` would otherwise clash with
 * itself), and an element type registered again is taken as already registered.
 */
function loadMadeUp(html: string): void {
  document.documentElement.innerHTML = /<html[^>]*>([\s\S]*)<\/html>/i.exec(html)?.[1] ?? html;
  for (const script of Array.from(document.querySelectorAll('script'))) {
    if (!script.textContent) continue;
    const replacement = document.createElement('script');
    replacement.textContent = `{\n${script.textContent}\n}`;
    script.replaceWith(replacement);
  }
}

const registry = globalThis.customElements;
const define = registry.define.bind(registry);
registry.define = (name, constructor, options) => {
  if (registry.get(name) === undefined) define(name, constructor, options);
};

/** Errors a page's own scripts threw while loading. There must be none. */
const scriptErrors: string[] = [];
globalThis.addEventListener('error', (event) => scriptErrors.push(event.message));

/** What the product does on one page, field by field, and how long it took. */
function measure(html: string, set: PageResult['set']): { fields: Field[]; ms: number } {
  if (set === 'corpus') openSnapshot(document, html);
  else loadMadeUp(html);
  const started = performance.now();
  const { fields, elements } = harvest(document);
  const results = matchForm(fields);
  const ms = performance.now() - started;
  return {
    ms,
    fields: fields.map((field, index) => ({
      label: field.labelText,
      outcome: {
        expected: elements.get(field.ref)?.getAttribute('data-expect') ?? null,
        actual: results[index]!.key,
        confidence: Math.round(results[index]!.confidence * 1000) / 1000,
      },
    })),
  };
}

function pageResult(page: string, set: PageResult['set'], category: string, side: Side | null, fields: Field[]): PageResult {
  return {
    page,
    set,
    category,
    side,
    tally: tally(fields.map((field) => field.outcome)),
    mistakes: fields
      .filter((field) => judge(field.outcome).verdict === 'mismatch')
      .map((field) => ({ label: field.label, expected: field.outcome.expected!, actual: field.outcome.actual, confidence: field.outcome.confidence })),
    missed: fields
      .filter((field) => judge(field.outcome).verdict === 'unmapped')
      .map((field) => ({ label: field.label, expected: field.outcome.expected! })),
  };
}

const percent = (value: number | null) => (value === null ? '—' : `${(value * 100).toFixed(1)}%`);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!;
};
const p95 = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
};

/** Requests the bench tried to make. There must be none. */
const requests: string[] = [];
const realFetch = globalThis.fetch;
const realXhr = globalThis.XMLHttpRequest;

beforeAll(() => {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    requests.push(String(input));
    return Promise.reject(new Error('The bench makes no requests.'));
  }) as typeof fetch;
  globalThis.XMLHttpRequest = class {
    constructor() {
      requests.push('XMLHttpRequest');
      throw new Error('The bench makes no requests.');
    }
  } as unknown as typeof XMLHttpRequest;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  globalThis.XMLHttpRequest = realXhr;
});

describe('the bench', () => {
  const corpusPages = Object.entries(CORPUS)
    .map(([path, html]) => ({ name: path.replace(/^.*fixtures\/corpus\//, '').replace(/\.html$/, ''), html }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const madeUpPages = Object.entries(MADE_UP)
    .map(([path, html]) => ({ name: path.replace(/^.*fixtures\//, '').replace(/\.html$/, ''), html }))
    .filter(({ html }) => html.includes('data-expect'))
    .sort((a, b) => a.name.localeCompare(b.name));

  const splitPath = join(BENCH, 'split.json');
  const recorded: SplitEntry[] = existsSync(splitPath) ? (JSON.parse(readFileSync(splitPath, 'utf8')) as { entries: SplitEntry[] }).entries : [];
  let results: PageResult[] = [];
  const times: number[] = [];

  it('finds the tune and held-out split as it was recorded, and places new snapshots', () => {
    expect(splitIsHonest(recorded), 'bench/split.json has an entry moved by hand').toBe(true);
    const split = extendSplit(recorded, corpusPages.map(({ name }) => name));
    const unknown = recorded.filter(([name]) => !corpusPages.some((page) => page.name === name));
    expect(unknown.map(([name]) => name), 'bench/split.json names snapshots that are gone').toEqual([]);
    if (split.length !== recorded.length) {
      writeFileSync(
        splitPath,
        `${JSON.stringify({ rule: 'U0.M4 — src/corpus/split.ts: placed once, in hash order, 60/40 per category; never moved', entries: split }, null, 1)}\n`,
      );
    }
  });

  it('measures every page, the corpus and the made-up fixtures', () => {
    const split = new Map(extendSplit(recorded, corpusPages.map(({ name }) => name)));
    results = [
      ...corpusPages.map(({ name, html }) => {
        const category = name.split('/')[0]!;
        const meta = /<meta name="corpus:category" content="([^"]*)">/.exec(html)?.[1];
        expect(meta, `${name} says it is in another category`).toBe(category);
        const { fields, ms } = measure(html, 'corpus');
        times.push(ms);
        return pageResult(`corpus/${name}`, 'corpus', category, split.get(name) ?? null, fields);
      }),
      ...madeUpPages.map(({ name, html }) => {
        const { fields } = measure(html, 'made-up');
        return pageResult(name, 'made-up', 'made-up', null, fields);
      }),
    ];
    expect(results.length).toBe(corpusPages.length + madeUpPages.length);
  });

  it('gives the same answers twice', () => {
    const pass = () => [
      ...corpusPages.map(({ html }) => measure(html, 'corpus').fields),
      ...madeUpPages.map(({ html }) => measure(html, 'made-up').fields),
    ];
    expect(pass()).toEqual(pass());
  });

  it('reports a wrong answer planted in a page it scores', () => {
    // Change one confidently right field's expected key: the bench must call it a mistake.
    const every = [
      ...corpusPages.map(({ html }) => ({ html, set: 'corpus' as const })),
      ...madeUpPages.map(({ html }) => ({ html, set: 'made-up' as const })),
    ];
    for (const { html, set } of every) {
      const right = measure(html, set).fields.find((field) => judge(field.outcome).verdict === 'correct' && judge(field.outcome).confident);
      if (right === undefined) continue;
      const wrongKey = right.outcome.expected === 'identity.full_name' ? 'contact.email' : 'identity.full_name';
      const planted = html.replace(`data-expect="${right.outcome.expected}"`, `data-expect="${wrongKey}"`);
      const before = tally(measure(html, set).fields.map((field) => field.outcome)).confidentMismatches;
      const after = tally(measure(planted, set).fields.map((field) => field.outcome)).confidentMismatches;
      expect(after).toBeGreaterThan(before);
      return;
    }
    throw new Error('No page has a confidently right field to plant a mistake in.');
  });

  it('made no request of any kind', () => {
    expect(requests).toEqual([]);
  });

  it('loaded every page without its scripts failing', () => {
    expect(scriptErrors).toEqual([]);
  });

  it('writes what it measured', () => {
    const corpus = results.filter((result) => result.set === 'corpus');
    const madeUp = results.filter((result) => result.set === 'made-up');
    const byCategory = Object.fromEntries(
      [...new Set(corpus.map((result) => result.category))].sort().map((category) => [
        category,
        combine(corpus.filter((result) => result.category === category).map((result) => result.tally)),
      ]),
    );
    const bySide = Object.fromEntries(
      (['tune', 'held-out'] as const).map((side) => [side, combine(corpus.filter((result) => result.side === side).map((result) => result.tally))]),
    );
    const report = {
      corpus: { snapshots: corpus.length, total: combine(corpus.map((result) => result.tally)), byCategory, bySide },
      madeUp: { pages: madeUp.length, total: combine(madeUp.map((result) => result.tally)) },
      pages: results.map(({ page, set, category, side, tally: counts }) => ({ page, set, category, side, ...counts })),
    };
    writeFileSync(join(BENCH, 'results.json'), `${JSON.stringify(report, null, 1)}\n`);
    writeFileSync(join(BENCH, 'timing.json'), `${JSON.stringify({ forms: times.length, medianMs: median(times), p95Ms: p95(times) }, null, 1)}\n`);

    const row = (name: string, t: Tally, count: number) =>
      `| ${name} | ${count} | ${t.mappable} | ${percent(accuracy(t))} | ${percent(t.mappable === 0 ? null : t.correctConfident / t.mappable)} | ${t.unmapped} | ${t.mismatched} | **${t.confidentMismatches}** | ${t.ambiguous} | ${t.unlabelled} |`;
    const header = '| Set | Pages | Fields with a key | Correct | Correct, unflagged | Left empty | Wrong | Wrong, unflagged | Ambiguous | Unlabelled |\n|---|---|---|---|---|---|---|---|---|---|';
    const lines = [
      '# Bench results',
      '',
      'Written by `npm run bench` (`src/corpus/bench.run.ts`); how to read it: `bench/README.md`.',
      '',
      '## The corpus — real forms',
      '',
      corpus.length === 0 ? '_No snapshots yet._' : header,
      ...(corpus.length === 0 ? [] : Object.entries(byCategory).map(([category, t]) => row(category, t, corpus.filter((r) => r.category === category).length))),
      ...(corpus.length === 0 ? [] : [row('**all**', report.corpus.total, corpus.length), row('tune', bySide.tune!, corpus.filter((r) => r.side === 'tune').length), row('held-out', bySide['held-out']!, corpus.filter((r) => r.side === 'held-out').length)]),
      '',
      '## The made-up fixtures — a regression check, not a measure of quality',
      '',
      header,
      ...madeUp.map((result) => row(result.page, result.tally, 1)),
      row('**all**', report.madeUp.total, madeUp.length),
      '',
      '## Every mistake',
      '',
      ...results.flatMap((result) =>
        result.mistakes.map((m) => `- ${result.page}: "${m.label}" — filled as \`${m.actual}\` (${m.confidence}), should be \`${m.expected}\``),
      ),
      '',
      '## Left empty, by the key they should have had',
      '',
      ...Object.entries(
        results.flatMap((result) => result.missed).reduce<Record<string, string[]>>((groups, m) => {
          (groups[m.expected] ??= []).push(m.label);
          return groups;
        }, {}),
      )
        .sort(([, a], [, b]) => b.length - a.length)
        .map(([key, labels]) => `- \`${key}\` × ${labels.length}: ${[...new Set(labels)].slice(0, 6).map((l) => `"${l}"`).join(', ')}`),
      '',
    ];
    writeFileSync(join(BENCH, 'summary.md'), `${lines.join('\n')}\n`);
    process.stdout.write(`\nbench: ${corpus.length} corpus snapshots, ${madeUp.length} made-up pages; confident mistakes: corpus ${report.corpus.total.confidentMismatches}, made-up ${report.madeUp.total.confidentMismatches}\n`);
  });

  it('holds the bar', () => {
    const corpus = combine(results.filter((result) => result.set === 'corpus').map((result) => result.tally));
    expect(corpus.confidentMismatches, 'a wrong key filled without a flag, on a real form').toBe(0);

    const baselinePath = join(BENCH, 'baseline.json');
    if (process.env.BENCH_WRITE_BASELINE === '1') {
      const byCategory = Object.fromEntries(
        [...new Set(results.filter((r) => r.set === 'corpus').map((r) => r.category))].sort().map((category) => [
          category,
          accuracy(combine(results.filter((r) => r.set === 'corpus' && r.category === category).map((r) => r.tally))),
        ]),
      );
      writeFileSync(baselinePath, `${JSON.stringify({ corpusAccuracy: accuracy(corpus), byCategory, medianMs: median(times) }, null, 1)}\n`);
      return;
    }
    if (!existsSync(baselinePath)) return;
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as { byCategory: Record<string, number | null> };
    for (const [category, before] of Object.entries(baseline.byCategory)) {
      if (before === null) continue;
      const now = accuracy(combine(results.filter((r) => r.set === 'corpus' && r.category === category).map((r) => r.tally)));
      expect(now ?? 0, `${category}: accuracy fell more than a point below the baseline`).toBeGreaterThanOrEqual(before - 0.01);
    }
  });
});
