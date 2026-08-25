/**
 * Site-profile lookup (§ Phase 4).
 *
 * Precedence is fixed by the plan: **profile → rules → LLM**. A profile is a
 * recorded answer for a form someone has already worked out — either shipped
 * with the extension or taught by the user (Phase 9). Consulting it first means
 * the general matcher never has to re-derive a mapping that is already known,
 * and a taught correction always beats a rule that got it wrong.
 *
 * Under the any-portal amendment a profile is a *cache*, not a precondition: a
 * form with no profile still matches, just with rule-level confidence.
 */

import type { FieldDescriptor, MatchResult, SiteProfile } from '@/shared/types';
import { PROFILE_STALE_THRESHOLD } from '@/shared/types';
import { isFieldKey } from './taxonomy';

/** Profiles shipped in the repo. Empty until real portals are profiled. */
const BUNDLED = import.meta.glob('../../site-profiles/*.json', {
  import: 'default',
  eager: true,
}) as Record<string, unknown>;

export interface ProfileMatch {
  profile: SiteProfile;
  /** Fraction of the profile's selectors that resolved against this page. */
  resolveRate: number;
  /** Below PROFILE_STALE_THRESHOLD the profile is stale and must not be used. */
  stale: boolean;
}

export function bundledProfiles(): SiteProfile[] {
  return Object.values(BUNDLED).filter(isSiteProfile);
}

function isSiteProfile(value: unknown): value is SiteProfile {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SiteProfile>;
  return (
    typeof candidate.siteId === 'string' &&
    typeof candidate.version === 'number' &&
    Array.isArray(candidate.fields)
  );
}

/**
 * Does this profile apply to this page?
 *
 * A fingerprint match is decisive — it is the whole point of §5's fingerprint.
 * A URL-glob match is a weaker fallback for the first visit to a form whose
 * fingerprint has drifted, and the caller still has to check the resolve rate.
 */
export function profileApplies(
  profile: SiteProfile,
  url: string,
  fingerprint: string,
): boolean {
  if (profile.formFingerprint === fingerprint) return true;
  return matchesUrlPattern(profile.matchUrl, url);
}

export function matchesUrlPattern(pattern: string, url: string): boolean {
  if (!pattern) return false;
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  try {
    return new RegExp(`^${escaped}$`, 'i').test(url);
  } catch {
    return false;
  }
}

/**
 * Pick the best applicable profile, newest version first.
 *
 * `resolve` reports whether a selector still finds something on the live page.
 * It is injected rather than assumed so this module stays DOM-free and testable.
 */
export function selectProfile(
  profiles: readonly SiteProfile[],
  url: string,
  fingerprint: string,
  resolve: (selectors: string[]) => boolean,
): ProfileMatch | null {
  const applicable = profiles
    .filter((profile) => profileApplies(profile, url, fingerprint))
    .sort((a, b) => b.version - a.version);

  for (const profile of applicable) {
    if (profile.fields.length === 0) continue;
    const resolved = profile.fields.filter((field) => resolve(field.selectors)).length;
    const resolveRate = resolved / profile.fields.length;
    return {
      profile,
      resolveRate,
      // §Phase 9: below 60% the profile is stale — prompt for repair rather
      // than filling a half-broken form.
      stale: resolveRate < PROFILE_STALE_THRESHOLD,
    };
  }

  return null;
}

/**
 * Turn a profile into match results for the fields it recognises.
 *
 * `locate` maps a profile's selector list onto a harvested field ref, which is
 * how a recorded selector becomes a specific field on this page.
 */
export function matchFromProfile(
  profile: SiteProfile,
  fields: readonly FieldDescriptor[],
  locate: (selectors: string[], fields: readonly FieldDescriptor[]) => FieldDescriptor | null,
): MatchResult[] {
  const results: MatchResult[] = [];

  for (const entry of profile.fields) {
    if (!isFieldKey(entry.key)) continue;
    const field = locate(entry.selectors, fields);
    if (!field) continue;

    results.push({
      fieldRef: field.ref,
      key: entry.key,
      // A taught mapping is a human's answer, so it is trusted fully; a
      // recorded rule/LLM mapping keeps whatever confidence it earned.
      confidence: entry.source === 'taught' ? 1 : entry.confidence,
      rationale:
        entry.source === 'taught'
          ? `you taught this field on ${profile.siteId} (profile v${profile.version})`
          : `saved mapping for ${profile.siteId} (profile v${profile.version})`,
      source: 'profile',
    });
  }

  return results;
}

/**
 * Default `locate`: first selector that identifies exactly one harvested field.
 *
 * Matching on the recorded selector rather than on position means a profile
 * survives fields being added or reordered above it.
 */
export function locateBySelector(
  selectors: string[],
  fields: readonly FieldDescriptor[],
): FieldDescriptor | null {
  for (const selector of selectors) {
    const hits = fields.filter((field) => field.selectors.includes(selector));
    if (hits.length === 1) return hits[0]!;
  }
  return null;
}
