// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';

import { harvest } from '@/content/harvester';
import { findUploadSlots } from '@/content/upload-slots';
import { CONFIDENCE } from '@/shared/types';
import { bandOf, matchForm } from './deterministic';

/**
 * A real portal's document page, as it renders (CLAUDE.md rule 5).
 *
 * `fixtures/test-portal/documents.html` is the rendered DOM of the test
 * portal's `/documents` page, captured with `scripts/capture-page.mjs` — a
 * single-page app, so its HTML is empty until React runs, and jsdom cannot run
 * it. Each requirement is a visually hidden file box named by `aria-label`
 * ("Upload Class X Academic Record") and described by two lines: an "Also
 * known as" list and the accepted types and sizes.
 *
 * It exposed what the extension's own fixtures had not: a Roman "Class X", a
 * certificate named by the category it proves ("ST Category Certificate"),
 * and a portal that tells you, in so many words, what else its documents are
 * called — which the matcher never read.
 */

const PAGES = import.meta.glob('../../fixtures/test-portal/documents.html', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function load(): void {
  const html = Object.values(PAGES)[0];
  if (!html) throw new Error('fixtures/test-portal/documents.html is missing');
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
}

/** What each requirement on the page is, by the box's own accessible name. */
const EXPECTED: ReadonlyArray<[label: string, key: string]> = [
  ['Upload Recent Photograph', 'doc.photo'],
  ['Upload Candidate Signature', 'doc.signature'],
  ['Upload Class X Academic Record', 'doc.marksheet_10'],
  ['Upload ST Category Certificate', 'doc.caste_certificate'],
  ['Upload Candidate Resume', 'doc.resume'],
];

let scored: { label: string; key: string; confidence: number; rationale: string }[] = [];

beforeAll(() => {
  load();
  const result = harvest(document);
  const matches = matchForm(result.fields);
  scored = result.fields
    .map((field, index) => ({ field, match: matches[index]! }))
    .filter(({ field }) => field.tag === 'file')
    .map(({ field, match }) => ({
      label: field.labelText,
      key: match.key,
      confidence: match.confidence,
      rationale: match.rationale,
    }));
});

describe('the test portal’s document requirements', () => {
  it.each(EXPECTED)('reads "%s" as %s', (label, key) => {
    const found = scored.find((s) => s.label === label);
    expect(found, `no file box labelled "${label}"`).toBeDefined();
    expect(found!.key, `${label} → ${found!.rationale}`).toBe(key);
    expect(bandOf({ ...found!, fieldRef: '', source: 'rule', key: found!.key as never })).not.toBe(
      'unmapped',
    );
  });

  it('leaves the supplementary-evidence box unnamed: it asks for no particular document', () => {
    const found = scored.find((s) => s.label === 'Upload supplementary evidence');
    expect(found?.key).toBe('unknown');
  });

  it('makes no confident mistake on any file box', () => {
    const expected = new Map(EXPECTED);
    for (const s of scored) {
      if (s.confidence < CONFIDENCE.AUTO_FILL || s.key === 'unknown') continue;
      expect(s.key, `"${s.label}"`).toBe(expected.get(s.label));
    }
  });
});

describe('the page around the requirements', () => {
  it('takes no navigation link for an upload control', () => {
    // The header links to this very page as "Upload Documents". Read as an
    // "Add file" button, it became an upload question called "Home" — a slot a
    // document could be sent to, belonging to no requirement at all.
    load();
    const { slots, elements } = findUploadSlots(document, () => true);
    const links = slots.filter((slot) => elements.get(slot.ref)?.closest('a[href]') !== null);
    expect(links.map((slot) => slot.label)).toEqual([]);
    expect(slots.map((slot) => slot.label)).not.toContain('Home');
  });
});
