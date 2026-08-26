/**
 * Teach mode (§ Phase 9) — turning a user's correction into a durable profile.
 *
 * Pure: picks in, a versioned `SiteProfile` out. No DOM, no storage, no
 * `chrome.*`. The picker that produces the picks lives in `content/picker.ts`;
 * the store that keeps the versions lives in `learned-profiles.ts`.
 *
 * ## What this phase is really for
 *
 * The plan calls it "turn your maintenance burden into a user-driven feature",
 * and that is the whole argument. Every portal redesign breaks every selector
 * anyone recorded. A product that answers that with "wait for an update" is a
 * product that is broken on the day the user needs it, which for an application
 * deadline is the only day that counts. Teach mode means the person in front of
 * the form can repair it in two minutes.
 *
 * ## Two rules that make repair safe
 *
 *  1. **A repair never loses prior work.** Re-teaching three fields on a
 *     twenty-field profile keeps the other seventeen. Anything else would make
 *     fixing one field a reason to re-do the whole form.
 *  2. **Every teach bumps the version, and old versions are kept.** A user who
 *     mis-clicks and teaches "Father's Name" onto the mother's box needs to be
 *     able to get back, and the profile is the only record of what changed.
 */

import type {
  DocConstraint,
  FieldRef,
  SiteProfile,
  SiteProfileDocument,
  SiteProfileField,
} from '@/shared/types';
import { PROFILE_STALE_THRESHOLD } from '@/shared/types';
import { isFieldKey, type FieldKey } from './taxonomy';
import { isXPath, looksUnstable, looksUnstableName } from '@/content/selectors';

export interface TeachPick {
  ref: FieldRef;
  key: FieldKey;
  /** Ranked selectors, as the picker recorded them. */
  selectors: string[];
  /** What the user saw on the page, for the confirmation screen. */
  label: string;
}

export interface TeachDocumentPick {
  ref: FieldRef;
  key: FieldKey;
  selectors: string[];
  label: string;
  constraint: DocConstraint;
}

export interface TeachInput {
  siteId: string;
  url: string;
  fingerprint: string;
  picks: readonly TeachPick[];
  documents?: readonly TeachDocumentPick[];
  /** The profile being repaired, when there is one. */
  previous?: SiteProfile | null;
  submit?: { selectors: string[]; label: string } | null;
  now?: Date;
  /**
   * Optional probe: does this selector still find the same field on a *second*
   * render of the page? See `rankSelectors`.
   */
  survives?: (selector: string) => boolean;
}

/**
 * Build the next version of a profile from what the user taught.
 *
 * Taught entries win over anything previously recorded for the same key — a
 * human pointing at a field is the strongest signal this system has, stronger
 * than a rule, a model, or an older teach.
 */
export function buildTaughtProfile(input: TeachInput): SiteProfile {
  const at = (input.now ?? new Date()).toISOString();
  const previous = input.previous ?? null;

  const byKey = new Map<FieldKey, SiteProfileField>();

  // Start from what was already known, so a repair of three fields does not
  // discard the other seventeen.
  for (const field of previous?.fields ?? []) {
    if (isFieldKey(field.key)) byKey.set(field.key, field);
  }

  for (const pick of input.picks) {
    if (!isFieldKey(pick.key)) continue;
    const selectors = rankSelectors(pick.selectors, input.survives);
    if (selectors.length === 0) continue;

    byKey.set(pick.key, {
      key: pick.key,
      selectors,
      // A human's answer. Not "very confident" — correct, by definition of who
      // is asking. `matchFromProfile` reads `source === 'taught'` and trusts it
      // fully rather than reading this number, but they should agree.
      confidence: 1,
      source: 'taught',
    });
  }

  const documents = new Map<FieldKey, SiteProfileDocument>();
  for (const doc of previous?.documents ?? []) {
    if (isFieldKey(doc.key)) documents.set(doc.key, doc);
  }
  for (const doc of input.documents ?? []) {
    if (!isFieldKey(doc.key)) continue;
    const selectors = rankSelectors(doc.selectors, input.survives);
    if (selectors.length === 0) continue;
    documents.set(doc.key, { key: doc.key, selectors, constraint: doc.constraint });
  }

  return {
    siteId: previous?.siteId ?? input.siteId,
    version: (previous?.version ?? 0) + 1,
    matchUrl: previous?.matchUrl ?? originPattern(input.url),
    formFingerprint: input.fingerprint,
    createdAt: previous?.createdAt ?? at,
    lastVerifiedAt: at,
    fields: [...byKey.values()],
    documents: [...documents.values()],
    submit: input.submit ?? previous?.submit ?? { selectors: [], label: '' },
    blockers: previous?.blockers ?? [],
  };
}

// ---------------------------------------------------------------------------
// Selector resilience
// ---------------------------------------------------------------------------

/**
 * Rank selectors by how likely they are to still work next month.
 *
 * The plan asks for a ranked list that "prefers selectors that survive across
 * your fixture's regenerated-ID variants", and that is two separate things:
 *
 *  - **A static judgement.** `ctl00$x$txtName` is a generated id and will be a
 *    different id on the next render; `input[name="txtName"]` is authored and
 *    usually is not. `looksUnstable` already encodes what those look like.
 *  - **A measured one.** When the caller can actually re-render the page — the
 *    picker after a postback, the e2e after a reload — `survives` reports
 *    whether a selector still finds the field. Measured evidence outranks the
 *    heuristic in both directions: a selector that demonstrably survived is
 *    promoted above one that merely looks stable, and one that demonstrably
 *    died is demoted below everything.
 *
 * Order within a tier is preserved, so the harvester's own ranking still
 * breaks ties.
 */
export function rankSelectors(
  selectors: readonly string[],
  survives?: (selector: string) => boolean,
): string[] {
  const unique = [...new Set(selectors.filter((selector) => selector.trim() !== ''))];

  return unique
    .map((selector, index) => ({ selector, index, tier: tierOf(selector, survives) }))
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map((entry) => entry.selector);
}

/** Lower is better. */
export const enum Tier {
  Survived = 0,
  StableId = 1,
  StableName = 2,
  LabelAnchored = 3,
  UnstableId = 4,
  Structural = 5,
  Died = 6,
}

function tierOf(selector: string, survives?: (selector: string) => boolean): Tier {
  if (survives) {
    // Measured evidence beats every heuristic below.
    return survives(selector) ? Tier.Survived : Tier.Died;
  }

  const id = /^#(.+)$/.exec(selector)?.[1];
  if (id !== undefined) {
    return looksUnstable(unescapeCss(id)) ? Tier.UnstableId : Tier.StableId;
  }

  const name = /\[name="(.+)"\]$/.exec(selector)?.[1];
  if (name !== undefined) {
    return looksUnstableName(unescapeCss(name)) ? Tier.Structural : Tier.StableName;
  }

  if (isXPath(selector)) return Tier.LabelAnchored;
  return Tier.Structural;
}

function unescapeCss(value: string): string {
  return value.replace(/\\(.)/g, '$1');
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface ProfileHealth {
  siteId: string;
  version: number;
  resolved: number;
  total: number;
  rate: number;
  /** Below the threshold the profile must not be used to fill. */
  stale: boolean;
  /** Keys whose selectors no longer find anything — what teach mode repairs. */
  broken: FieldKey[];
}

/**
 * How much of this profile still works on the page in front of us?
 *
 * §Phase 9: below 60% the profile is stale and the user is prompted to repair
 * it rather than being shown a half-filled form. A half-filled form is the
 * worse outcome by a distance — it looks finished.
 */
export function profileHealth(
  profile: SiteProfile,
  resolves: (selectors: string[]) => boolean,
): ProfileHealth {
  const broken: FieldKey[] = [];
  let resolved = 0;

  for (const field of profile.fields) {
    if (resolves(field.selectors)) resolved += 1;
    else if (isFieldKey(field.key)) broken.push(field.key);
  }

  const total = profile.fields.length;
  const rate = total === 0 ? 0 : resolved / total;

  return {
    siteId: profile.siteId,
    version: profile.version,
    resolved,
    total,
    rate,
    stale: total > 0 && rate < PROFILE_STALE_THRESHOLD,
    broken,
  };
}

function originPattern(url: string): string {
  try {
    return `${new URL(url).origin}/*`;
  } catch {
    return url;
  }
}
