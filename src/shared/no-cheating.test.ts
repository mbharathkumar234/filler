import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The product cannot see the answers (U0.M6, `MASTER_PROMPT.md`).
 *
 * Every measurement in this project marks the right answer on the page itself:
 * `data-expect` on each field of a fixture or corpus snapshot. A product that
 * read that attribute — or recognised a fixture by its path or by the server
 * the tests run on — would score perfectly and know nothing. Product code is
 * everything under `src/` that is not a test, and not `src/corpus/`: the
 * measuring tools, which must read the answers, and which no product file may
 * import.
 */

const SRC = join(process.cwd(), 'src');
const CORPUS = join(SRC, 'corpus');

function productFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (path === CORPUS) return [];
    if (statSync(path).isDirectory()) return productFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const FORBIDDEN: Array<[string, RegExp]> = [
  ['reads the answers', /data-expect|dataset\.expect/],
  ['names a fixture path', /fixtures\//],
  ['knows the test server', /localhost:4173/],
  ['uses the measuring tools', /from ['"](?:@\/corpus|\.{1,2}\/(?:\.\.\/)*corpus)\//],
];

describe('the product cannot see the answers', () => {
  const files = productFiles(SRC);

  it('has product code to check', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(FORBIDDEN)('no product file %s', (_, pattern) => {
    const offenders = files.filter((path) => pattern.test(readFileSync(path, 'utf8')));
    expect(offenders.map((path) => path.slice(SRC.length + 1))).toEqual([]);
  });
});
