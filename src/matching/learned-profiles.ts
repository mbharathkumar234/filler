/**
 * Learned site profiles (§ Phase 8).
 *
 *   "Successful runs are written into a new site profile so the LLM is called
 *    **once per form, ever**."
 *
 * A learned profile is the same `SiteProfile` shape the bundled ones use, so
 * it slots straight into the Phase 4 lookup and inherits its staleness check
 * for free. The only difference is provenance: `source: 'llm'` on every field,
 * which the review screen surfaces and Phase 9's teach mode can upgrade to
 * `'taught'` once a human has confirmed it.
 *
 * ## Where these live, and why not the vault
 *
 * `chrome.storage.local`, unencrypted, because a profile contains **no user
 * data at all** — field keys, CSS selectors, and confidences. It is a
 * description of a public web page. Putting it in the vault would tie form
 * recognition to the passphrase for no benefit, and would mean a locked vault
 * could not even tell you what a page is.
 *
 * It does record *which portals the user has visited*, which is not nothing.
 * That is the same exposure `chrome.history` already carries, it never leaves
 * the device, and `forgetLearned` is one click in settings.
 */

import type { FieldDescriptor, MatchResult, SiteProfile, SiteProfileField } from '@/shared/types';
import { isFieldKey } from './taxonomy';

export const LEARNED_KEY = 'profiles:learned';
export const LEARNED_SCHEMA_VERSION = 1;

/** Bound on how many forms we remember, oldest evicted first. */
export const MAX_LEARNED = 100;

export interface LearnedStorage {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

let storage: LearnedStorage | null = null;

export function setLearnedStorage(area: LearnedStorage | null): void {
  storage = area;
}

function area(): LearnedStorage {
  if (storage) return storage;
  const local = (globalThis as { chrome?: { storage?: { local?: LearnedStorage } } }).chrome?.storage
    ?.local;
  if (!local) throw new Error('chrome.storage.local is unavailable; call setLearnedStorage() first.');
  storage = local;
  return local;
}

/**
 * Build a profile from what the model worked out.
 *
 * Only fields the model actually placed are recorded. A profile that stored
 * `unknown` for half a form would satisfy the staleness check while teaching
 * the next run nothing, and would stop the LLM being called for the fields it
 * failed on last time — locking in a bad answer.
 */
export function learnedProfileFrom(args: {
  url: string;
  fingerprint: string;
  fields: readonly FieldDescriptor[];
  results: readonly MatchResult[];
  submit?: { selectors: string[]; label: string } | null;
  now?: Date;
}): SiteProfile | null {
  const selectorsByRef = new Map(args.fields.map((field) => [field.ref, field.selectors]));
  const at = (args.now ?? new Date()).toISOString();

  const fields: SiteProfileField[] = [];
  for (const result of args.results) {
    if (result.source !== 'llm') continue;
    if (!isFieldKey(result.key)) continue;
    const selectors = selectorsByRef.get(result.fieldRef);
    if (!selectors || selectors.length === 0) continue;

    fields.push({
      key: result.key,
      selectors,
      confidence: result.confidence,
      source: 'llm',
    });
  }

  if (fields.length === 0) return null;

  return {
    siteId: siteIdFor(args.url, args.fingerprint),
    version: 1,
    matchUrl: originOf(args.url),
    formFingerprint: args.fingerprint,
    createdAt: at,
    lastVerifiedAt: at,
    fields,
    documents: [],
    submit: args.submit ?? { selectors: [], label: '' },
    blockers: [],
  };
}

/**
 * A stable id for a learned profile.
 *
 * Origin plus a short slice of the fingerprint: readable enough to recognise
 * in a settings list, specific enough that two forms on one portal do not
 * collide.
 */
export function siteIdFor(url: string, fingerprint: string): string {
  return `learned:${originOf(url).replace(/^https?:\/\//, '')}:${fingerprint.slice(0, 12)}`;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

interface LearnedRecord {
  v: number;
  profiles: SiteProfile[];
}

export async function loadLearned(): Promise<SiteProfile[]> {
  const stored = (await area().get(LEARNED_KEY))[LEARNED_KEY];
  if (typeof stored !== 'object' || stored === null) return [];
  const record = stored as Partial<LearnedRecord>;
  if (record.v !== LEARNED_SCHEMA_VERSION) return [];
  if (!Array.isArray(record.profiles)) return [];
  return record.profiles.filter(isProfile);
}

/**
 * Remember a profile, replacing any earlier one for the same form.
 *
 * Replacing rather than appending is what makes "once per form, ever" true
 * across re-learns: a form whose layout changed enough to be re-learned gets
 * one entry, not a growing pile of near-duplicates.
 */
export async function saveLearned(profile: SiteProfile): Promise<void> {
  const existing = await loadLearned();
  const previous = existing.find((p) => p.formFingerprint === profile.formFingerprint);
  const kept = existing.filter((p) => p.formFingerprint !== profile.formFingerprint);

  const next: SiteProfile = previous
    ? { ...profile, version: previous.version + 1, createdAt: previous.createdAt }
    : profile;

  await area().set({
    [LEARNED_KEY]: {
      v: LEARNED_SCHEMA_VERSION,
      profiles: [...kept, next].slice(-MAX_LEARNED),
    } satisfies LearnedRecord,
  });
}

export async function findLearned(fingerprint: string): Promise<SiteProfile | null> {
  return (await loadLearned()).find((p) => p.formFingerprint === fingerprint) ?? null;
}

/** Forget everything learned. Offered in settings; the user owns this. */
export async function forgetLearned(): Promise<void> {
  await area().remove(LEARNED_KEY);
}

function isProfile(value: unknown): value is SiteProfile {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SiteProfile>;
  return (
    typeof candidate.siteId === 'string' &&
    typeof candidate.formFingerprint === 'string' &&
    Array.isArray(candidate.fields)
  );
}
