/**
 * Matching orchestration (§ Phase 4).
 *
 *   "Profile cache lookup precedes rules; rules precede LLM (Phase 8)."
 *
 * This module owns that precedence so no caller has to remember it, and so
 * Phase 8 has exactly one place to slot the LLM in underneath.
 */

import type { FieldDescriptor, MatchResult, SiteProfile } from '@/shared/types';
import { matchForm } from './deterministic';
import { locateBySelector, matchFromProfile, selectProfile, type ProfileMatch } from './profile-cache';

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
 * Match a whole form: profile first, rules for whatever the profile missed.
 *
 * A stale profile is reported rather than used. §Phase 9 is explicit that
 * filling a half-broken form is worse than admitting the profile has drifted.
 */
export function matchFormWithContext(
  fields: readonly FieldDescriptor[],
  context: MatchContext,
): FormMatch {
  const byRef = new Map<string, MatchResult>();
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
      for (const result of matchFromProfile(selected.profile, fields, locateBySelector)) {
        byRef.set(result.fieldRef, result);
      }
    }
  }

  // Rules fill the gaps the profile left.
  const remaining = fields.filter((field) => !byRef.has(field.ref));
  for (const result of matchForm(remaining)) {
    byRef.set(result.fieldRef, result);
  }

  const results = fields.map(
    (field) =>
      byRef.get(field.ref) ?? {
        fieldRef: field.ref,
        key: 'unknown' as const,
        confidence: 0,
        rationale: 'No rule matched this field.',
        source: 'rule' as const,
      },
  );

  return {
    results,
    profile: used,
    staleProfile: stale,
    sameAsPermanent: detectSameAsPermanent(fields),
    unmapped: results.filter((r) => r.key === 'unknown').map((r) => r.fieldRef),
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
