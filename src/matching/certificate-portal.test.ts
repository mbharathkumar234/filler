// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { harvest } from '@/content/harvester';
import { matchForm } from './deterministic';

/**
 * A central recruitment form's reservation page
 * (`fixtures/certificate-portal/reservation.html`), matched as the page really
 * is. Each certificate is asked for by number, date of issue and issuing
 * authority under a heading that names it — "OBC Certificate Details", "EWS
 * Certificate Details" — while the boxes say only "Date of Issue". The same
 * words under "Passport Details" name no certificate the vault holds, and that
 * box is left alone.
 */
const PAGES = import.meta.glob('../../fixtures/certificate-portal/*.html', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('a certificate asked for under its own heading', () => {
  it('matches every box to the certificate its heading names, and leaves the passport’s date alone', () => {
    const html = Object.values(PAGES)[0]!;
    document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)![1]!;
    const { fields, elements } = harvest(document);
    const keys = matchForm(fields).map((match) => match.key);
    expect(keys).toEqual(fields.map((field) => elements.get(field.ref)!.getAttribute('data-expect')));
  });
});
