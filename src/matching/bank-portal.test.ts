// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { harvest } from '@/content/harvester';
import { matchForm } from './deterministic';

/**
 * A scholarship form's bank page (`fixtures/bank-portal/bank-details.html`),
 * matched as the page really is. It asks for the MICR code and the branch's
 * address beside the IFSC — the two details RBI's list fills from the IFSC
 * alone — and then for the applicant's own address. The branch's address is
 * the bank's and the applicant's is theirs; neither box may take the other.
 */
const PAGES = import.meta.glob('../../fixtures/bank-portal/*.html', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('a bank page asking for the MICR code and the branch’s address', () => {
  it('matches every box to its own key, and the two addresses to their owners', () => {
    const html = Object.values(PAGES)[0]!;
    document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)![1]!;
    const { fields, elements } = harvest(document);
    const keys = matchForm(fields).map((match) => match.key);
    expect(keys).toEqual(fields.map((field) => elements.get(field.ref)!.getAttribute('data-expect')));
  });
});
