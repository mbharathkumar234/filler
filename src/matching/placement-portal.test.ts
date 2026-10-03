// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { harvest } from '@/content/harvester';
import { matchForm } from './deterministic';

/**
 * A campus placement form (`fixtures/placement-portal/grades.html`), matched as
 * the page really is — labels, ids and names together. It asks what a semester
 * grade card answers: the USN, the SGPA, the CGPA and the backlogs. "SGPA" once
 * sat in the CGPA list, and a form asking for both got the CGPA twice.
 */
const PAGES = import.meta.glob('../../fixtures/placement-portal/*.html', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('a placement form asking what a grade card answers', () => {
  it('matches every question to the key it asks for', () => {
    const html = Object.values(PAGES)[0]!;
    document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)![1]!;
    const { fields, elements } = harvest(document);
    const keys = matchForm(fields).map((match) => match.key);
    expect(keys).toEqual(fields.map((field) => elements.get(field.ref)!.getAttribute('data-expect')));
  });
});
