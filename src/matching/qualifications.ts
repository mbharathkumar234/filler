/**
 * Which qualification answers a question that names none (§ vault structure).
 *
 * The taxonomy holds one block per qualification (`education.class_12.*`) and
 * a generic one for a form that asks "Roll number" without saying which
 * (`education[].*`). The vault editor used to show both, so the same marks
 * were typed twice — once under Class 12 and once under "any qualification" —
 * and the copy people forgot to update was the one that got filled in.
 *
 * Now the generic block is not something anyone fills. It is answered from the
 * qualification they most recently earned, which is what a portal asking
 * without qualifying means: the latest one.
 *
 * Kept pure and away from `vault/` so it can be read and tested as a rule
 * rather than as a database query.
 */

import { FIELD_KEYS, isFieldKey, type FieldKey } from './taxonomy';

/**
 * The qualification blocks, most recently earned first.
 *
 * A professional degree sits below a master's and above a bachelor's: it is
 * the degree somebody reads medicine or law for, and the people who hold one
 * and a postgraduate degree earned it first.
 */
export const QUALIFICATION_PREFIXES: readonly string[] = [
  'education.phd.',
  'education.postgraduate.',
  'education.professional_degree.',
  'education.undergraduate.',
  'education.diploma.',
  'education.class_12.',
  'education.class_10.',
];

const GENERIC_PREFIX = 'education[].';

/** The generic keys, and the field segment each one wants. */
const GENERIC_FIELDS: ReadonlyArray<{ key: FieldKey; field: string }> = FIELD_KEYS.filter((key) =>
  key.startsWith(GENERIC_PREFIX),
).map((key) => ({ key, field: key.slice(GENERIC_PREFIX.length) }));

/**
 * Fill in the level-less education keys from one qualification block.
 *
 * **One block, never a mixture.** Taking each field from wherever it happens
 * to be filled would compose a record nobody holds — the university from the
 * degree and the roll number from school — and a portal that asks for both
 * would be told something untrue. So the most recent qualification that has
 * been filled in at all answers every level-less question, and any field it
 * leaves blank stays blank.
 *
 * A value the user typed into the generic block themselves always wins: it may
 * be all that an older vault has.
 */
export function answerLevellessEducation(
  values: ReadonlyMap<string, string>,
): Map<string, string> {
  const answered = new Map(values);

  const source = QUALIFICATION_PREFIXES.find((prefix) =>
    [...values.keys()].some((key) => key.startsWith(prefix) && (values.get(key) ?? '') !== ''),
  );
  if (source === undefined) return answered;

  for (const { key, field } of GENERIC_FIELDS) {
    if ((answered.get(key) ?? '') !== '') continue;
    const from = `${source}${field}`;
    if (!isFieldKey(from)) continue;
    const value = values.get(from);
    if (value !== undefined && value !== '') answered.set(key, value);
  }

  return answered;
}
