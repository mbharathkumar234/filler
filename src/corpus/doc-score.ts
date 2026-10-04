/**
 * Scoring a document reading against its owner's answer key (U0.M7,
 * `MASTER_PROMPT.md`).
 *
 * The answer key (`.private/bench/answers.json`) and the reading hold the
 * person's real values and never leave `.private/`. The score holds counts and
 * field names only — a document is named by the slot it is filed under, never
 * by its file name — so it can be shared and committed. Pure.
 */

/** A value must equal the expected one (ignoring case and spacing), or contain it. */
export type Expected = string | { contains: string };

export interface DocAnswer {
  /** The document's file in `.private/bench/`. Never copied into a score. */
  file: string;
  /** The vault slot it is filed under, e.g. `doc.marksheet_10`. */
  slot: string;
  fields: Record<string, Expected>;
  /** The scripts to read it in, when not the default Latin and Devanagari. */
  scripts?: string[];
}

export interface DocScore {
  slot: string;
  fields: number;
  right: number;
  /** Keys read with a value that is not the expected one. */
  wrong: string[];
  /** Keys not read at all. */
  missing: string[];
}

const plain = (value: string) => value.normalize('NFC').toUpperCase().replace(/\s+/g, ' ').trim();

function matches(value: string, want: Expected): boolean {
  return typeof want === 'string' ? plain(value) === plain(want) : plain(value).includes(plain(want.contains));
}

export function scoreDocument(answer: DocAnswer, read: ReadonlyArray<{ key: string; value: string }>): DocScore {
  const score: DocScore = { slot: answer.slot, fields: 0, right: 0, wrong: [], missing: [] };
  for (const [key, want] of Object.entries(answer.fields)) {
    score.fields += 1;
    const value = read.find((candidate) => candidate.key === key)?.value;
    if (value === undefined) score.missing.push(key);
    else if (matches(value, want)) score.right += 1;
    else score.wrong.push(key);
  }
  return score;
}

export function totalScore(scores: readonly DocScore[]): {
  documents: DocScore[];
  fields: number;
  right: number;
  accuracy: number | null;
} {
  const seen = new Map<string, number>();
  const documents = scores.map((score) => {
    const count = (seen.get(score.slot) ?? 0) + 1;
    seen.set(score.slot, count);
    return count === 1 ? score : { ...score, slot: `${score.slot} (${count})` };
  });
  const fields = scores.reduce((sum, score) => sum + score.fields, 0);
  const right = scores.reduce((sum, score) => sum + score.right, 0);
  return { documents, fields, right, accuracy: fields === 0 ? null : right / fields };
}
