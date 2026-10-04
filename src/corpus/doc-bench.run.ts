/**
 * The scoring half of `npm run doc-bench` (U0.M7, `MASTER_PROMPT.md`).
 *
 * `scripts/doc-bench.mjs` has read each document with the built extension's
 * reader into `<DOC_BENCH_DIR>/reads.json`. Here each reading goes through the
 * product's own pipeline — laid out into lines, extracted, checked against
 * RBI's and India Post's lists from the build — and is scored against the
 * owner's answer key (`doc-score.ts`). Only counts and field names are written,
 * to `DOC_BENCH_OUT`. Skipped when there is nothing to score, so `npm run
 * bench` passes over it.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createReferenceLookup } from '@/background/reference-data';
import type { ReadItem } from '@/documents/paddle-reader';
import { layoutLines } from '@/documents/layout';
import { readAndExtract, type OcrEngine } from '@/documents/read-document';
import type { ReadTable } from '@/documents/table';
import type { FieldKey } from '@/matching/taxonomy';
import { scoreDocument, totalScore, type DocAnswer, type DocScore } from './doc-score';

const DIR = process.env.DOC_BENCH_DIR;
const OUT = process.env.DOC_BENCH_OUT;
const ready = DIR !== undefined && OUT !== undefined && existsSync(join(DIR, 'reads.json'));

interface Reading {
  index: number;
  unsupported?: true;
  ms?: number;
  items?: ReadItem[];
  tables?: ReadTable[];
  seals?: Array<{ box: ReadItem['box']; text: string[] }>;
}

describe.skipIf(!ready)('the document bench', () => {
  it('scores every document it read, and writes only counts', async () => {
    const answers = JSON.parse(readFileSync(join(DIR!, 'answers.json'), 'utf8')) as DocAnswer[];
    const reads = JSON.parse(readFileSync(join(DIR!, 'reads.json'), 'utf8')) as Reading[];
    const lists = join(process.cwd(), 'dist', 'reference');
    const reference = createReferenceLookup(async (path) =>
      existsSync(join(lists, path)) ? new Uint8Array(readFileSync(join(lists, path))) : null,
    );

    const scores: DocScore[] = [];
    const notMeasured: string[] = [];
    const times: number[] = [];
    for (const reading of reads) {
      const answer = answers[reading.index]!;
      if (reading.unsupported) {
        notMeasured.push(answer.slot);
        continue;
      }
      times.push(reading.ms ?? 0);
      const seals = (reading.seals ?? []).map((seal) => ({ text: `Seal: ${seal.text.join(', ')}`, box: seal.box }));
      const lines = [...layoutLines(reading.items ?? []), ...seals];
      const engine: OcrEngine = {
        availableScripts: async () => ['Latin', 'Devanagari', 'Telugu', 'Tamil'],
        recognise: async () => ({
          text: lines.map((line) => line.text).join('\n'),
          confidence: 0.9,
          ...((reading.tables ?? []).length > 0 ? { tables: reading.tables! } : {}),
        }),
      };
      const result = await readAndExtract(new Uint8Array([1]), { mime: 'image/jpeg' }, {
        ocr: engine,
        hint: { documentKey: answer.slot as FieldKey },
        reference,
      });
      scores.push(scoreDocument(answer, result.candidates));
    }

    const sorted = [...times].sort((a, b) => a - b);
    const report = {
      ...totalScore(scores),
      notMeasured,
      medianMsPerDocument: sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!,
    };
    writeFileSync(OUT!, `${JSON.stringify(report, null, 1)}\n`);
    process.stdout.write(`\ndoc-bench: ${report.right} of ${report.fields} fields right across ${scores.length} documents\n`);
    expect(scores.length + notMeasured.length).toBe(reads.length);
  });
});
