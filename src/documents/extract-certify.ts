/**
 * "This is to certify that …" (§ reading a document).
 *
 * Some documents name their subject in a sentence rather than beside a label.
 * The CBSE statement prints the student as the rest of the line "This is to
 * certify that"; Karnataka's Nadakacheri certificates name the parents in the
 * same sentence:
 *
 *   This is to certify that Kumar. M KIRAN KUMAR S/O Sri. M NAGAPPA
 *   (Father Name) and Smt. M SAVITHA (Mother Name) is a resident of …
 *
 * These run after the labelled rules, and every key here is first-come: a
 * name printed beside "Candidate's Name" wins over one read out of a sentence.
 *
 * A sentence certifies nobody when what follows is not a name — the 2nd PUC
 * certificate reads "This is to certify that the candidate mentioned below …",
 * and "the candidate" is not a person. Names on these documents are printed in
 * capitals, and that is what is required here.
 */

import type { Ctx } from './extract';

const CERTIFY = /this\s+is\s+to\s+certify\s+that\s+(.*)$/i;

/** A courtesy title before a name, never part of it. */
const HONORIFIC = /^(?:kumar|kumari|kum|sri|shri|smt|shrimati|mr|mrs|ms|miss|master)\.?$/i;

/** A name token as these documents print one: capitals, an initial, a hyphen. */
const NAME_TOKEN = /^[A-Z][A-Z.'-]*$/;

/**
 * A person's name from the start of a run of words: an optional title, then
 * two to five words in capitals, stopping at the first word that is not.
 */
function nameAtStart(words: readonly string[]): string | null {
  let tokens = [...words];
  const first = tokens[0] ?? '';
  // A title is written like one — "Kumar.", "Sri." — where a name that merely
  // begins with KUMAR is written in capitals with no stop, and is kept whole.
  const writtenAsTitle = first.endsWith('.') || first !== first.toUpperCase();
  if (tokens.length >= 3 && HONORIFIC.test(first) && writtenAsTitle && NAME_TOKEN.test(tokens[1]!)) {
    tokens = tokens.slice(1);
  }
  const name: string[] = [];
  for (const token of tokens) {
    if (!NAME_TOKEN.test(token) || name.length === 5) break;
    name.push(token);
  }
  // "A" alone, or a lone surname, is not enough to file under a person.
  return name.length >= 2 ? name.join(' ').replace(/[.,]+$/, '') : null;
}

/** "S/O Sri. M NAGAPPA (Father Name)" — the parent named after the relation. */
const PARENT_AFTER_RELATION = /\b[SDC]\s*\/\s*O\b\.?\s+(.*)$/i;

/** "and Smt. M SAVITHA (Mother Name)". */
const MOTHER_AFTER_AND = /\band\s+(?:smt|shrimati|mrs)\.?\s+(.*)$/i;

export function extractCertifiedPerson(ctx: Ctx): void {
  const at = ctx.lines.findIndex((line) => CERTIFY.test(line));
  if (at === -1) return;

  const line = ctx.lines[at]!;
  const rest = CERTIFY.exec(line)![1]!.trim().split(/\s+/);
  const person = nameAtStart(rest);
  if (person !== null) {
    ctx.push({
      key: 'identity.full_name',
      value: person,
      // Read from a sentence, not beside a label: below the labelled rules.
      confidence: 0.75,
      evidence: line.trim(),
      line: at,
      verified: false,
    });
  }

  // The sentence may run on: the parents are named on the next line or two.
  const sentence = ctx.lines.slice(at, at + 3).join(' ');

  const relation = PARENT_AFTER_RELATION.exec(sentence);
  if (relation) {
    const father = nameAtStart(relation[1]!.trim().split(/\s+/));
    if (father !== null) {
      ctx.push({
        key: 'family.father_name',
        value: father,
        confidence: 0.75,
        evidence: sentence.trim().slice(0, 160),
        line: at,
        verified: false,
      });
    }
  }

  const mother = MOTHER_AFTER_AND.exec(sentence);
  if (mother) {
    const name = nameAtStart(mother[1]!.trim().split(/\s+/));
    if (name !== null) {
      ctx.push({
        key: 'family.mother_name',
        value: name,
        confidence: 0.75,
        evidence: sentence.trim().slice(0, 160),
        line: at,
        verified: false,
      });
    }
  }
}
