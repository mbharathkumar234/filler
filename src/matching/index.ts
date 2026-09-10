/**
 * Matching orchestration (§ Phase 4).
 *
 * ## Semantics first, on every field
 *
 * The filling capability rests on two things that hold on any form: the
 * canonical taxonomy, and a semantic reading of each label against it
 * (`deterministic.ts` for the attribute, `frame.ts` for whose / which one /
 * which qualification). That runs on **every field, always** — it is what fills
 * a portal nobody has seen before.
 *
 * A site profile is portal knowledge. It refines the semantic answer; it does
 * not replace it. It used to: a profile covering a field meant the matcher never
 * looked at that field, so a model's guess saved as a learned profile went on
 * overriding a correct reading on that form indefinitely. Now, field by field:
 *
 *  - **taught** by the user → the user's answer. A person correcting a field is
 *    the strongest evidence there is, and it is theirs to give.
 *  - semantics has **no answer** → the profile fills the gap. This is what a
 *    learned profile is for: the model is asked once per form, ever.
 *  - they **agree** → the semantic answer, at the higher of the two confidences.
 *  - they **disagree** → the semantic answer, capped below auto-fill and flagged
 *    with what the profile said, so a person decides.
 *
 * The LLM slots in underneath all of this (Phase 8) for whatever is still unknown.
 */

import type { FieldDescriptor, MatchResult, SiteProfile } from '@/shared/types';
import { AMBIGUITY_CEILING, matchForm } from './deterministic';
import {
  locateBySelector,
  profileAnswers,
  selectProfile,
  type ProfileAnswer,
  type ProfileMatch,
} from './profile-cache';

export interface MatchContext {
  url: string;
  fingerprint: string;
  profiles?: readonly SiteProfile[];
  /** Whether a recorded selector still finds something on the live page. */
  resolve?: (selectors: string[]) => boolean;
}

export interface FormMatch {
  results: MatchResult[];
  /** The profile used, when one applied and was not stale. */
  profile: ProfileMatch | null;
  /** Set when a profile applied but too few of its selectors resolved. */
  staleProfile: ProfileMatch | null;
  /** A "same as permanent address" control, for Phase 5 to act on. */
  sameAsPermanent: string | null;
  unmapped: string[];
}

/**
 * Match a whole form: semantics on every field, refined by a profile where one
 * applies.
 *
 * A stale profile is reported rather than used. §Phase 9 is explicit that
 * filling a half-broken form is worse than admitting the profile has drifted.
 */
export function matchFormWithContext(
  fields: readonly FieldDescriptor[],
  context: MatchContext,
): FormMatch {
  const answers = new Map<string, ProfileAnswer>();
  let used: ProfileMatch | null = null;
  let stale: ProfileMatch | null = null;

  const profiles = context.profiles ?? [];
  if (profiles.length > 0) {
    const selected = selectProfile(
      profiles,
      context.url,
      context.fingerprint,
      context.resolve ?? (() => true),
    );

    if (selected?.stale) {
      stale = selected;
    } else if (selected) {
      used = selected;
      for (const answer of profileAnswers(selected.profile, fields, locateBySelector)) {
        answers.set(answer.result.fieldRef, answer);
      }
    }
  }

  /*
   * Semantics on every field a person has not already answered — including the
   * ones a saved profile covers, because a disagreement can only be noticed if
   * semantics looked. The whole form at once, so address sections and the
   * duplicate check see it the way a person reads it.
   *
   * Taught fields are left out rather than overridden afterwards: the user's
   * answer is final, and letting semantics run on it anyway would have it
   * "take" a key in the duplicate check and demote the field that really is it.
   */
  const open = fields.filter((field) => !answers.get(field.ref)?.taught);
  const semantic = new Map(matchForm(open).map((result) => [result.fieldRef, result]));

  const results = fields.map((field) => {
    const answer = answers.get(field.ref);
    if (answer?.taught) return answer.result;
    return refine(semantic.get(field.ref)!, answer);
  });

  return {
    results,
    profile: used,
    staleProfile: stale,
    sameAsPermanent: detectSameAsPermanent(fields),
    unmapped: results.filter((r) => r.key === 'unknown').map((r) => r.fieldRef),
  };
}

/**
 * One field's semantic answer, refined by what a saved (untaught) profile says.
 *
 * A saved mapping is portal knowledge that nobody confirmed: a rule's answer
 * from an older release, or a model's guess from the one time it was asked. It
 * is good evidence where semantics has nothing, and corroboration where the two
 * agree — but where they disagree, one of them is wrong, and the only honest
 * move is to keep the reading that holds on every form and let a person look.
 */
function refine(semantic: MatchResult, answer: ProfileAnswer | undefined): MatchResult {
  if (!answer) return semantic;
  const saved = answer.result;

  if (semantic.key === 'unknown') return saved;

  if (semantic.key === saved.key) {
    return {
      ...semantic,
      confidence: Math.max(semantic.confidence, saved.confidence),
      rationale: `${semantic.rationale}; ${saved.rationale} agrees`,
    };
  }

  return {
    ...semantic,
    confidence: Math.min(semantic.confidence, AMBIGUITY_CEILING),
    rationale: `${semantic.rationale}; ${saved.rationale} says ${saved.key} instead`,
  };
}

const SAME_AS_PERMANENT =
  /same as (permanent|above|residential)|copy (from )?permanent|address is the same|उपरोक्त के समान/i;

/**
 * Find a "Correspondence address same as permanent" checkbox.
 *
 * There is no taxonomy key for it — it is a control, not a value. Phase 5 needs
 * to know it exists so it can tick it and skip the mirrored block, rather than
 * filling both and risking a mismatch the portal then rejects.
 */
export function detectSameAsPermanent(fields: readonly FieldDescriptor[]): string | null {
  const hit = fields.find(
    (field) =>
      field.tag === 'checkbox' &&
      SAME_AS_PERMANENT.test(`${field.labelText} ${field.nearbyText}`),
  );
  return hit?.ref ?? null;
}

export { matchForm, matchField, bandOf } from './deterministic';
export type { MatchBand } from './deterministic';
