/**
 * The vault as one person sees it (§ vault structure).
 *
 * [field-groups.ts](./field-groups.ts) is the catalogue of everything anybody
 * might be asked for. This module narrows it to one person, using the rules in
 * `matching/pathway.ts`, and it is the only place that decides what a panel
 * renders.
 *
 * Two guarantees, and the tests are written against both:
 *
 *  1. **A key that holds something is always shown.** The offered set is
 *     unioned with what is already filled, so no answer to the setup questions
 *     — and no later change of mind — can take a user's own data off screen.
 *  2. **No path means everything.** Somebody who skips the questions gets the
 *     full catalogue, exactly as before this existed.
 */

import type { AcademicPath } from '@/matching/pathway';
import { documentKeysFor, fieldKeysFor } from '@/matching/pathway';
import {
  DOCUMENT_GROUPS,
  FIELD_GROUPS,
  type DocumentGroup,
  type FieldGroup,
} from './field-groups';

/**
 * Titles that should say what the person's own board and state call a thing.
 *
 * "Class 12" is what a form in Delhi asks for and "PUC" is what one in
 * Karnataka asks for; a student looking for somewhere to put their PUC marks
 * card should not have to work out that the two are the same.
 */
function retitle<T extends FieldGroup>(group: T, path: AcademicPath): T {
  const karnataka = path.state === 'karnataka' || path.afterTen === 'puc';
  // A document folder and a field block for the same qualification sit on one
  // page; named identically, neither one tells you which is which.
  const documents = group.id.startsWith('docs-');

  if (group.id === 'docs-class-10' || group.id === 'edu-class-10') {
    const board =
      path.board10 === 'cbse'
        ? 'CBSE'
        : path.board10 === 'icse'
          ? 'ICSE'
          : karnataka
            ? 'SSLC'
            : 'State board';
    return { ...group, title: `Class 10 (${board})${documents ? ' documents' : ''}` };
  }

  if (group.id === 'docs-class-12' || group.id === 'edu-class-12') {
    const level = karnataka ? 'PUC (Class 12)' : 'Class 12';
    return { ...group, title: `${level}${documents ? ' documents' : ''}` };
  }

  return group;
}

function narrow<T extends FieldGroup>(
  groups: readonly T[],
  offered: ReadonlySet<string>,
  filled: ReadonlySet<string>,
  path: AcademicPath,
): T[] {
  return groups
    .map((group) => ({
      ...retitle(group, path),
      keys: group.keys.filter((key) => offered.has(key) || filled.has(key)),
    }))
    .filter((group) => group.keys.length > 0);
}

/** The profile blocks this person is offered, in the catalogue's own order. */
export function fieldGroupsFor(
  path: AcademicPath | null,
  filled: ReadonlySet<string>,
): FieldGroup[] {
  if (path === null) return FIELD_GROUPS;
  return narrow(FIELD_GROUPS, fieldKeysFor(path), filled, path);
}

/** The document folders this person is offered, in the catalogue's own order. */
export function documentGroupsFor(
  path: AcademicPath | null,
  filled: ReadonlySet<string>,
): DocumentGroup[] {
  if (path === null) return DOCUMENT_GROUPS;
  const narrowed = narrow(DOCUMENT_GROUPS, documentKeysFor(path), filled, path);
  /*
   * Open what an answer asked for; leave the rest folded.
   *
   * A folder the path kept because of something the person *said* — the KCET
   * papers, the caste certificates, the college's own documents — is one a
   * form will demand, and collapsing it would hide the very slots the
   * questions were asked in order to surface. The four below are different:
   * they are kept for every student past school, because any student *might*
   * have them, and an open folder of seventeen empty slots is the clutter this
   * whole feature exists to remove.
   */
  return narrowed.map((group) => ({ ...group, optional: PORTFOLIO_FOLDERS.has(group.id) }));
}

/**
 * Folders offered to every student past school, rather than asked for.
 *
 * Nobody is asked whether they have been to a hackathon, so these cannot be
 * narrowed by an answer; they stay folded instead, one line each.
 */
const PORTFOLIO_FOLDERS: ReadonlySet<string> = new Set([
  'docs-work',
  'docs-skills',
  'docs-achievements',
  'docs-service',
]);

/** How much of the catalogue a path hides, for the "show everything" control. */
export function hiddenCount(path: AcademicPath | null, filled: ReadonlySet<string>): number {
  if (path === null) return 0;
  const shown =
    fieldGroupsFor(path, filled).reduce((n, group) => n + group.keys.length, 0) +
    documentGroupsFor(path, filled).reduce((n, group) => n + group.keys.length, 0);
  const all =
    FIELD_GROUPS.reduce((n, group) => n + group.keys.length, 0) +
    DOCUMENT_GROUPS.reduce((n, group) => n + group.keys.length, 0);
  return all - shown;
}
