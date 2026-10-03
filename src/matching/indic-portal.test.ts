// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { harvest } from '@/content/harvester';
import { matchForm } from './deterministic';

/**
 * A form that asks for the name in English, in Hindi and in Kannada
 * (`fixtures/indic-portal/name-in-hindi.html`), matched as the page really is —
 * labels, ids and names together.
 *
 * Found by filling it through the real panel: "Name (in English)" half-matched
 * "english marks" and claimed nothing, and "Name in Kannada", re-matched as a
 * duplicate of "Name in Hindi", fell through to the English name by its `name`
 * attribute. The English spelling was typed into the box for Kannada.
 */
const PAGES = import.meta.glob('../../fixtures/indic-portal/*.html', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('the name asked in English, in Hindi and in Kannada', () => {
  it('matches every question to the key it asks for', () => {
    const html = Object.values(PAGES)[0]!;
    document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)![1]!;
    const { fields, elements } = harvest(document);
    const keys = matchForm(fields).map((match) => match.key);
    expect(keys).toEqual(fields.map((field) => elements.get(field.ref)!.getAttribute('data-expect')));
  });
});
