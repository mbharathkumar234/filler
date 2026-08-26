/**
 * The deterministic matcher (§ Phase 4): `FieldDescriptor` → `FieldKey`, no LLM.
 *
 * Under the any-portal scope amendment this must work on a form it has never
 * seen, so it is built from general signals rather than per-site selectors:
 *
 *   1. `autocomplete` — the site told us, declaratively. Strongest signal there is.
 *   2. Synonym match on the label — exact, then coverage, then fuzzy.
 *   3. `name`/`id` token heuristics — `txtFatherName`, `ddlState`, `hdnPan`.
 *   4. Option-set matching — a select listing every Indian state is a state field.
 *   5. Section context — "Permanent" vs "Correspondence" resolves identical labels.
 *
 * And one rule that is not a signal at all: **traits veto** (`traits.ts`).
 * A 10-character numeric box is not a full name, whatever its label says.
 *
 * ## Why the scoring is deliberately timid
 *
 * §6.4 rates a high-confidence *mis*-match as Critical — strictly worse than a
 * miss, because a miss is visible on the review screen and a mis-match looks
 * correct. So: corroboration raises confidence slowly, a close runner-up caps
 * the winner below the auto-fill threshold, and anything that survives on one
 * weak signal alone stays under 0.5. Missing a field costs the user a manual
 * entry. Mis-filling one can cost them the application.
 */

import type { FieldDescriptor, MatchResult } from '@/shared/types';
import { CONFIDENCE } from '@/shared/types';
import { FIELD_KEYS, isFieldKey, type FieldKey } from './taxonomy';
import {
  canonicalForm,
  coverage,
  hasDistinctiveOverlap,
  identifierTokens,
  labelTokens,
  similarity,
  splitBilingual,
} from './normalise';
import { veto } from './traits';
import rawSynonyms from './synonyms.json';

// ---------------------------------------------------------------------------
// Dictionary
// ---------------------------------------------------------------------------

export interface SynonymEntry {
  key: FieldKey;
  phrase: string;
  tokens: string[];
  canonical: string;
}

function buildDictionary(source: Record<string, unknown>): SynonymEntry[] {
  const entries: SynonymEntry[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('$') || !Array.isArray(value)) continue;
    if (!isFieldKey(key)) continue;
    for (const phrase of value as string[]) {
      entries.push({
        key,
        phrase,
        tokens: labelTokens(phrase),
        canonical: canonicalForm(phrase),
      });
    }
  }
  return entries;
}

const DICTIONARY = buildDictionary(rawSynonyms as Record<string, unknown>);

/** Exposed so the synonym file can be validated by its own test. */
export function synonymEntries(): readonly SynonymEntry[] {
  return DICTIONARY;
}

const BY_CANONICAL = new Map<string, FieldKey[]>();
for (const entry of DICTIONARY) {
  const existing = BY_CANONICAL.get(entry.canonical);
  if (existing) existing.push(entry.key);
  else BY_CANONICAL.set(entry.canonical, [entry.key]);
}

// ---------------------------------------------------------------------------
// autocomplete
// ---------------------------------------------------------------------------

/** WHATWG autocomplete tokens → taxonomy keys. The site's own declaration. */
const AUTOCOMPLETE_MAP: Record<string, FieldKey> = {
  name: 'identity.full_name',
  'given-name': 'identity.given_name',
  'additional-name': 'identity.middle_name',
  'family-name': 'identity.surname',
  bday: 'identity.dob',
  sex: 'identity.gender',
  email: 'contact.email',
  tel: 'contact.mobile',
  'tel-national': 'contact.mobile',
  'address-line1': 'address.permanent.line1',
  'address-line2': 'address.permanent.line2',
  'address-level2': 'address.permanent.city',
  'address-level1': 'address.permanent.state',
  'postal-code': 'address.permanent.pincode',
  country: 'address.permanent.country',
  'country-name': 'address.permanent.country',
  organization: 'education[].institution',
};

// ---------------------------------------------------------------------------
// Option-set fingerprints
// ---------------------------------------------------------------------------

const INDIAN_STATES = [
  'andhra pradesh', 'arunachal pradesh', 'assam', 'bihar', 'chhattisgarh', 'goa',
  'gujarat', 'haryana', 'himachal pradesh', 'jharkhand', 'karnataka', 'kerala',
  'madhya pradesh', 'maharashtra', 'manipur', 'meghalaya', 'mizoram', 'nagaland',
  'odisha', 'punjab', 'rajasthan', 'sikkim', 'tamil nadu', 'telangana', 'tripura',
  'uttar pradesh', 'uttarakhand', 'west bengal', 'delhi', 'jammu and kashmir',
  'ladakh', 'puducherry', 'chandigarh',
];

const GENDERS = ['male', 'female', 'transgender', 'other', 'others', 'm', 'f', 't'];
const CATEGORIES = ['general', 'gen', 'obc', 'sc', 'st', 'ews', 'obc ncl'];
const BLOOD_GROUPS = ['a+', 'a-', 'b+', 'b-', 'o+', 'o-', 'ab+', 'ab-', 'a positive'];
const MARITAL = ['single', 'married', 'unmarried', 'divorced', 'widowed'];
const ACCOUNT_TYPES = ['savings', 'current', 'salary', 'saving'];

interface OptionSet {
  key: FieldKey;
  members: string[];
  /** How many members must appear before this fires. */
  threshold: number;
}

const OPTION_SETS: OptionSet[] = [
  { key: 'address.permanent.state', members: INDIAN_STATES, threshold: 8 },
  { key: 'identity.gender', members: GENDERS, threshold: 2 },
  { key: 'identity.category', members: CATEGORIES, threshold: 3 },
  { key: 'identity.blood_group', members: BLOOD_GROUPS, threshold: 3 },
  { key: 'identity.marital_status', members: MARITAL, threshold: 2 },
  { key: 'bank.account_type', members: ACCOUNT_TYPES, threshold: 2 },
];

function matchOptionSet(field: FieldDescriptor): { key: FieldKey; matched: number } | null {
  if (!field.options || field.options.length < 2) return null;

  const texts = field.options
    .map((option) => canonicalForm(option.text || option.value))
    .filter((text) => text.length > 0);

  let best: { key: FieldKey; matched: number } | null = null;
  for (const set of OPTION_SETS) {
    const members = new Set(set.members);
    const matched = texts.filter((text) => members.has(text)).length;
    if (matched >= set.threshold && (!best || matched > best.matched)) {
      best = { key: set.key, matched };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Section context
// ---------------------------------------------------------------------------

const CORRESPONDENCE_HINT = /correspondence|communication|present|current|mailing|पत्राचार|वर्तमान/i;
const PERMANENT_HINT = /permanent|native|स्थायी/i;

export type AddressSection = 'permanent' | 'correspondence';

/** The section this field's own text names, if it names one. */
function ownSection(field: FieldDescriptor): AddressSection | undefined {
  const context = `${field.nearbyText} ${field.labelText}`;
  if (CORRESPONDENCE_HINT.test(context)) return 'correspondence';
  if (PERMANENT_HINT.test(context)) return 'permanent';
  return undefined;
}

/**
 * Carry a section heading forward across the address block beneath it.
 *
 * Found by the Phase E benchmark. A Google Form gives every question its own
 * heading, so "Current address" labelled the street field and the City, PIN and
 * State questions after it carried no adjective at all. Matched one at a time
 * they split: street to `address.correspondence.line1`, the rest to
 * `address.permanent.*` — one block assembled out of two different addresses,
 * at 0.90, which is worse than picking either one.
 *
 * A heading applies to what sits under it, which is how a person reads the
 * page. So the adjective propagates forward over a *run* of address fields and
 * stops at the first field that is not one — a following "Permanent Account
 * Number" is not a section heading, and neither is anything else past the end
 * of the block. Fields before any adjective keep the default.
 *
 * Forward only, deliberately: headings precede their fields. Inferring a
 * section backwards from a field further down would be guessing.
 */
export function resolveAddressSections(
  fields: readonly FieldDescriptor[],
  keys: ReadonlyArray<MatchResult['key']>,
): ReadonlyArray<AddressSection | undefined> {
  const out: Array<AddressSection | undefined> = [];
  let carried: AddressSection | undefined;

  fields.forEach((field, index) => {
    if (!(keys[index] ?? 'unknown').startsWith('address.')) {
      carried = undefined; // The run ended; this heading governs nothing further.
      out.push(undefined);
      return;
    }
    const own = ownSection(field);
    if (own !== undefined) carried = own;
    out.push(own ?? carried);
  });

  return out;
}

/**
 * Retarget an address key onto the block it actually sits in.
 *
 * A form has "Address Line 1" twice, under two headings. The label alone cannot
 * tell them apart; the section can. Without this the second block would either
 * mis-map or land in the ambiguity cap.
 *
 * `section` is the resolved answer above when the caller is `matchForm`. A
 * single-field call has no block to read, so it falls back to this field's own
 * text — the behaviour a lone `matchField` has always had.
 */
function applyAddressContext(
  key: FieldKey,
  field: FieldDescriptor,
  section: AddressSection | undefined,
): FieldKey {
  if (!key.startsWith('address.')) return key;

  const resolved = section ?? ownSection(field);
  if (resolved === 'correspondence') {
    return key.replace('address.permanent.', 'address.correspondence.') as FieldKey;
  }
  if (resolved === 'permanent') {
    return key.replace('address.correspondence.', 'address.permanent.') as FieldKey;
  }
  return key;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

interface Signal {
  key: FieldKey;
  score: number;
  rationale: string;
}

/** Score ceilings per signal kind. Corroboration adds a little on top. */
const SCORES = {
  autocomplete: 0.95,
  optionSet: 0.9,
  labelExact: 0.9,
  labelCoverage: 0.78,
  identifierExact: 0.8,
  identifierCoverage: 0.66,
  fuzzy: 0.55,
} as const;

/** Each corroborating signal beyond the first adds this much. */
const CORROBORATION_BONUS = 0.04;

/**
 * A longer synonym match is stronger evidence, and gets a little more score.
 *
 * Found by the Phase 8 fourth portal: "Indian Financial System Code of the
 * Branch" was confidently mapped to `bank.branch`, because a fully-covered
 * one-token synonym ("branch") scored exactly as high as a fully-covered
 * four-token one would. Length is the whole difference between a phrase that
 * happens to appear in a label and a phrase that *is* the label's subject.
 *
 * Capped at three steps so the ceiling (0.78 + 0.09 = 0.87) stays below
 * `labelExact`: a contained phrase, however long, is still weaker evidence
 * than a label that matches a synonym outright.
 */
const SPECIFICITY_BONUS = 0.03;
const MAX_SPECIFICITY_STEPS = 3;

function coverageScore(synonymTokens: number): number {
  const steps = Math.min(synonymTokens - 1, MAX_SPECIFICITY_STEPS);
  return SCORES.labelCoverage + Math.max(0, steps) * SPECIFICITY_BONUS;
}

/**
 * When the runner-up is this close, the match is ambiguous.
 *
 * Set just above the exact-vs-coverage gap (0.90 − 0.78 = 0.12), because that
 * is the shape almost every real near-tie takes: one synonym matches exactly
 * while another is fully contained in the same label. Treating that as settled
 * is precisely how a confident mis-match gets made.
 */
const AMBIGUITY_MARGIN = 0.15;

/** Ceiling applied to an ambiguous match — below auto-fill, so a human looks. */
const AMBIGUITY_CEILING = 0.8;

function collectSignals(field: FieldDescriptor): Signal[] {
  const signals: Signal[] = [];

  // 1. autocomplete — declarative, authored by the site.
  const auto = (field.autocomplete ?? '').toLowerCase().trim();
  if (auto && auto !== 'off' && auto !== 'on') {
    // "shipping address-line1" / "billing tel" carry a section token first.
    const token = auto.split(/\s+/).pop() ?? auto;
    const mapped = AUTOCOMPLETE_MAP[token];
    if (mapped) {
      signals.push({
        key: mapped,
        score: SCORES.autocomplete,
        rationale: `autocomplete="${token}"`,
      });
    }
  }

  // 2. Option set — a select listing every state is a state field.
  const optionSet = matchOptionSet(field);
  if (optionSet) {
    signals.push({
      key: optionSet.key,
      score: SCORES.optionSet,
      rationale: `options include ${optionSet.matched} known ${optionSet.key.split('.').pop()} values`,
    });
  }

  // 3. Label against the synonym dictionary, per bilingual half.
  for (const half of splitBilingual(field.labelText)) {
    const tokens = labelTokens(half);
    if (tokens.length === 0) continue;

    const exact = BY_CANONICAL.get(canonicalForm(half));
    if (exact) {
      for (const key of exact) {
        signals.push({ key, score: SCORES.labelExact, rationale: `label matches "${half}"` });
      }
      continue;
    }

    for (const entry of DICTIONARY) {
      const covered = coverage(entry.tokens, tokens);
      if (covered === 1 && entry.tokens.length > 0) {
        signals.push({
          key: entry.key,
          score: coverageScore(entry.tokens.length),
          rationale: `label contains "${entry.phrase}"`,
        });
      } else if (
        covered >= 0.5 &&
        entry.tokens.length >= 2 &&
        // A partial match carried only by a generic word ("code", "number")
        // is how a matcher produces confident nonsense — require at least one
        // distinctive token in common.
        hasDistinctiveOverlap(entry.tokens, tokens)
      ) {
        signals.push({
          key: entry.key,
          score: SCORES.fuzzy,
          rationale: `label partly matches "${entry.phrase}"`,
        });
      }
    }
  }

  // 4. name/id tokens.
  const identifier = identifierTokens(primaryIdentifier(field));
  if (identifier.length > 0) {
    const canonical = [...identifier].sort().join(' ');
    const exact = BY_CANONICAL.get(canonical);
    if (exact) {
      for (const key of exact) {
        signals.push({
          key,
          score: SCORES.identifierExact,
          rationale: `field name reads as "${identifier.join(' ')}"`,
        });
      }
    } else {
      for (const entry of DICTIONARY) {
        if (entry.tokens.length === 0) continue;
        if (coverage(entry.tokens, identifier) === 1) {
          signals.push({
            key: entry.key,
            score: SCORES.identifierCoverage,
            rationale: `field name contains "${entry.phrase}"`,
          });
        }
      }
    }
  }

  // 5. Single-token typo tolerance, last and weakest.
  if (signals.length === 0) {
    const tokens = labelTokens(field.labelText);
    if (tokens.length === 1) {
      for (const entry of DICTIONARY) {
        if (entry.tokens.length !== 1) continue;
        const score = similarity(tokens[0]!, entry.tokens[0]!);
        if (score >= 0.8) {
          signals.push({
            key: entry.key,
            score: SCORES.fuzzy * score,
            rationale: `label resembles "${entry.phrase}"`,
          });
        }
      }
    }
  }

  return signals;
}

function primaryIdentifier(field: FieldDescriptor): string {
  // The harvester puts #id or [name=] first when either is usable.
  for (const selector of field.selectors) {
    const name = /\[name="([^"]+)"\]/.exec(selector)?.[1];
    if (name) return name;
    if (selector.startsWith('#')) return selector.slice(1).replace(/\\/g, '');
  }
  return '';
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface MatchOptions {
  /** Keys already taken by a higher-priority match, to avoid duplicates. */
  taken?: ReadonlySet<FieldKey>;
  /**
   * Which address block this field sits in, resolved across the whole form by
   * `matchForm`. Omitted by a single-field call, which then reads the field's
   * own text instead.
   */
  section?: AddressSection;
}

export function matchField(field: FieldDescriptor, options: MatchOptions = {}): MatchResult {
  const unmatched: MatchResult = {
    fieldRef: field.ref,
    key: 'unknown',
    confidence: 0,
    rationale: 'No rule matched this field.',
    source: 'rule',
  };

  if (field.labelText.trim() === '' && field.selectors.length === 0) return unmatched;

  // Group signals by key, retargeting address keys onto their section.
  const byKey = new Map<FieldKey, { score: number; reasons: string[]; count: number }>();
  for (const signal of collectSignals(field)) {
    const key = applyAddressContext(signal.key, field, options.section);
    const existing = byKey.get(key);
    if (existing) {
      existing.score = Math.max(existing.score, signal.score);
      existing.count += 1;
      if (!existing.reasons.includes(signal.rationale)) existing.reasons.push(signal.rationale);
    } else {
      byKey.set(key, { score: signal.score, reasons: [signal.rationale], count: 1 });
    }
  }

  if (byKey.size === 0) return unmatched;

  // Apply the traits veto, and record why anything strong was rejected.
  const candidates: { key: FieldKey; score: number; reasons: string[] }[] = [];
  const vetoed: string[] = [];

  for (const [key, entry] of byKey) {
    const verdict = veto(field, key);
    if (verdict.vetoed) {
      if (entry.score >= SCORES.labelCoverage) {
        vetoed.push(`${key} ruled out — ${verdict.reason}`);
      }
      continue;
    }
    const bonus = Math.min(0.08, (entry.count - 1) * CORROBORATION_BONUS);
    candidates.push({
      key,
      score: Math.min(0.99, entry.score + bonus),
      reasons: entry.reasons,
    });
  }

  if (candidates.length === 0) {
    return {
      ...unmatched,
      rationale:
        vetoed.length > 0
          ? vetoed[0]!
          : 'Candidate keys were ruled out by the field’s type or length.',
    };
  }

  candidates.sort((a, b) => b.score - a.score);

  // Prefer a key that is not already taken by an earlier, stronger field.
  const taken = options.taken ?? new Set<FieldKey>();
  const available = candidates.filter((c) => !taken.has(c.key) || c.key.includes('[]'));
  const ranked = available.length > 0 ? available : candidates;

  const winner = ranked[0]!;
  const runnerUp = ranked[1];

  let confidence = winner.score;
  const reasons = [...winner.reasons];

  // Ambiguity cap: two plausible keys means a human should look, whatever the
  // raw scores say. This is the main guard behind the zero-mis-match gate.
  if (runnerUp && winner.score - runnerUp.score < AMBIGUITY_MARGIN) {
    confidence = Math.min(confidence, AMBIGUITY_CEILING);
    reasons.push(`also plausible: ${runnerUp.key}`);
  }

  // A single weak signal never reaches the fill-and-flag band on its own.
  if (winner.reasons.length === 1 && winner.score <= SCORES.fuzzy) {
    confidence = Math.min(confidence, CONFIDENCE.FILL_AND_FLAG - 0.01);
  }

  // An invisible or disabled field is not worth filling confidently.
  if (!field.visible || !field.enabled) {
    confidence = Math.min(confidence, AMBIGUITY_CEILING);
    reasons.push(field.visible ? 'field is disabled' : 'field is not visible');
  }

  return {
    fieldRef: field.ref,
    key: winner.key,
    confidence: Number(confidence.toFixed(3)),
    rationale: reasons.join('; '),
    source: 'rule',
  };
}

/**
 * Match a whole form.
 *
 * Fields are matched in descending confidence so a strong match claims its key
 * before a weaker field can take it — otherwise the first "Name" on the page
 * wins `identity.full_name` even when a later field says so far more clearly.
 */
function sectionOpt(section: AddressSection | undefined): { section?: AddressSection } {
  // `exactOptionalPropertyTypes` — an explicit `undefined` is not the same as absent.
  return section === undefined ? {} : { section };
}

export function matchForm(fields: readonly FieldDescriptor[]): MatchResult[] {
  // Two passes over the address keys: the first finds which fields are in an
  // address block at all, the second re-matches them with the section that the
  // block's heading implies. A field's own adjective still wins.
  const probe = fields.map((field) => matchField(field).key);
  const sections = resolveAddressSections(fields, probe);

  const first = fields.map((field, index) => ({
    field,
    index,
    result: matchField(field, { ...sectionOpt(sections[index]) }),
  }));

  const order = [...first].sort((a, b) => b.result.confidence - a.result.confidence);
  const taken = new Set<FieldKey>();
  const final = new Map<string, MatchResult>();

  for (const { field, index, result } of order) {
    // Repeatable rows legitimately reuse a key across rows.
    if (result.key !== 'unknown' && !result.key.includes('[]') && taken.has(result.key)) {
      const rematched = matchField(field, { taken, ...sectionOpt(sections[index]) });

      if (rematched.key !== 'unknown' && !taken.has(rematched.key)) {
        final.set(field.ref, rematched);
        taken.add(rematched.key);
        continue;
      }

      // No alternative key. Keep the match — a "Confirm Email" field really
      // does hold the same value — but never auto-fill it: two fields claiming
      // one key is exactly the shape a mis-match takes.
      final.set(field.ref, {
        ...result,
        confidence: Math.min(result.confidence, AMBIGUITY_CEILING),
        rationale: `${result.rationale}; another field also matched this key`,
      });
      continue;
    }
    final.set(field.ref, result);
    if (result.key !== 'unknown') taken.add(result.key);
  }

  return fields.map((field) => final.get(field.ref) ?? unknownFor(field.ref));
}

function unknownFor(fieldRef: string): MatchResult {
  return {
    fieldRef,
    key: 'unknown',
    confidence: 0,
    rationale: 'No rule matched this field.',
    source: 'rule',
  };
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

export type MatchBand = 'auto-fill' | 'fill-and-flag' | 'unmapped';

/** §Phase 4: >=0.85 auto-fill; 0.5–0.85 fill but flag; <0.5 leave blank. */
export function bandOf(result: MatchResult): MatchBand {
  if (result.key === 'unknown') return 'unmapped';
  if (result.confidence >= CONFIDENCE.AUTO_FILL) return 'auto-fill';
  if (result.confidence >= CONFIDENCE.FILL_AND_FLAG) return 'fill-and-flag';
  return 'unmapped';
}

export { FIELD_KEYS };
