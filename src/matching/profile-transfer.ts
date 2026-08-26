/**
 * Sharing site profiles (§ Phase 9 Should).
 *
 *   "Export/import site profiles as JSON so users can share them … profiles
 *    contain **selectors only, never values** … Treat an untrusted profile as
 *    untrusted input."
 *
 * ## The export half is easy; the import half is the whole job
 *
 * An imported profile is a file from a stranger that tells this extension
 * *where to type the user's Aadhaar*. That is a more interesting capability
 * than it first sounds, and the failure mode is specific: a profile that maps
 * `id.aadhaar` onto a field the portal displays publicly, or onto a "notes"
 * box, would put a government ID somewhere it does not belong — and it would
 * look exactly like the extension working.
 *
 * So an import is validated structurally, stripped of anything that is not a
 * selector or a key, and **marked as imported** — never as `taught`. A taught
 * mapping is trusted absolutely (`matchFromProfile` fills it at confidence 1);
 * a stranger's mapping has not earned that. It enters at rule-level confidence
 * and appears on the review screen like any other guess, where the user sees
 * it before it is submitted.
 *
 * There is no signing here and no registry. The plan lists both as conditional
 * on hosting one; until that exists, "treat it as untrusted input" is the
 * whole of the defence, and it is honest about what it is.
 */

import type { SiteProfile, SiteProfileDocument, SiteProfileField } from '@/shared/types';
import { isFieldKey } from './taxonomy';

export const TRANSFER_FORMAT = 'autofill-site-profile';
export const TRANSFER_VERSION = 1;

export interface ProfileBundle {
  format: typeof TRANSFER_FORMAT;
  version: number;
  exportedAt: string;
  profiles: SiteProfile[];
}

/** Cap on what an import is allowed to contain, so a file cannot exhaust us. */
const MAX_PROFILES = 200;
const MAX_FIELDS = 300;
const MAX_SELECTOR_LENGTH = 500;

export function exportProfiles(profiles: readonly SiteProfile[], now: Date = new Date()): string {
  const bundle: ProfileBundle = {
    format: TRANSFER_FORMAT,
    version: TRANSFER_VERSION,
    exportedAt: now.toISOString(),
    profiles: profiles.map(sanitise),
  };
  return JSON.stringify(bundle, null, 2);
}

export interface ImportOutcome {
  profiles: SiteProfile[];
  /** What was thrown away, so the user is told rather than silently trimmed. */
  rejected: string[];
}

/**
 * Read a bundle someone sent you.
 *
 * Every field is rebuilt from scratch rather than spread from the input, so a
 * property nobody anticipated cannot ride along into storage.
 */
export function importProfiles(text: string): ImportOutcome {
  const rejected: string[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { profiles: [], rejected: ['That file is not valid JSON.'] };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { profiles: [], rejected: ['That file is not a profile bundle.'] };
  }

  const bundle = parsed as Partial<ProfileBundle>;
  if (bundle.format !== TRANSFER_FORMAT) {
    return { profiles: [], rejected: ['That file is not an AutoFill profile bundle.'] };
  }
  if (bundle.version !== TRANSFER_VERSION) {
    return {
      profiles: [],
      rejected: [`This bundle is version ${String(bundle.version)}; this build reads version ${TRANSFER_VERSION}.`],
    };
  }
  if (!Array.isArray(bundle.profiles)) {
    return { profiles: [], rejected: ['That bundle has no profiles in it.'] };
  }

  const profiles: SiteProfile[] = [];

  for (const [index, candidate] of bundle.profiles.slice(0, MAX_PROFILES).entries()) {
    const result = readProfile(candidate, index);
    if (typeof result === 'string') rejected.push(result);
    else profiles.push(result);
  }

  if (bundle.profiles.length > MAX_PROFILES) {
    rejected.push(`Only the first ${MAX_PROFILES} profiles were read.`);
  }

  return { profiles, rejected };
}

function readProfile(candidate: unknown, index: number): SiteProfile | string {
  if (typeof candidate !== 'object' || candidate === null) {
    return `Profile ${index + 1} is not an object.`;
  }
  const raw = candidate as Partial<SiteProfile>;

  if (typeof raw.siteId !== 'string' || raw.siteId.trim() === '') {
    return `Profile ${index + 1} has no site id.`;
  }
  if (typeof raw.formFingerprint !== 'string') {
    return `Profile "${raw.siteId}" has no form fingerprint.`;
  }
  if (!Array.isArray(raw.fields)) {
    return `Profile "${raw.siteId}" has no fields.`;
  }

  const fields: SiteProfileField[] = [];
  for (const entry of raw.fields.slice(0, MAX_FIELDS)) {
    const field = readField(entry);
    if (field) fields.push(field);
  }

  if (fields.length === 0) {
    return `Profile "${raw.siteId}" had no usable field mappings.`;
  }

  return {
    siteId: raw.siteId.slice(0, 200),
    version: typeof raw.version === 'number' && raw.version > 0 ? Math.floor(raw.version) : 1,
    matchUrl: typeof raw.matchUrl === 'string' ? raw.matchUrl.slice(0, 500) : '',
    formFingerprint: raw.formFingerprint.slice(0, 200),
    createdAt: isoOr(raw.createdAt),
    lastVerifiedAt: isoOr(raw.lastVerifiedAt),
    fields,
    documents: readDocuments(raw.documents),
    submit: readSubmit(raw.submit),
    blockers: [],
  };
}

/**
 * Read one mapping.
 *
 * Note what is *not* carried over: `source` and `confidence`. A bundle claiming
 * `source: 'taught'` would be claiming a trust level the recipient never
 * granted — `matchFromProfile` fills a taught mapping at confidence 1, without
 * flagging it. An imported mapping enters as a rule-level guess instead, so it
 * lands on the review screen where a human looks at it.
 */
function readField(entry: unknown): SiteProfileField | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const raw = entry as Partial<SiteProfileField>;

  if (typeof raw.key !== 'string' || !isFieldKey(raw.key)) return null;

  const selectors = readSelectors(raw.selectors);
  if (selectors.length === 0) return null;

  return { key: raw.key, selectors, confidence: 0.8, source: 'profile' };
}

function readDocuments(value: unknown): SiteProfileDocument[] {
  if (!Array.isArray(value)) return [];
  const documents: SiteProfileDocument[] = [];

  for (const entry of value.slice(0, MAX_FIELDS)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const raw = entry as Partial<SiteProfileDocument>;
    if (typeof raw.key !== 'string' || !isFieldKey(raw.key)) continue;
    const selectors = readSelectors(raw.selectors);
    if (selectors.length === 0) continue;
    documents.push({
      key: raw.key,
      selectors,
      constraint: readConstraint(raw.constraint),
    });
  }

  return documents;
}

function readConstraint(value: unknown): SiteProfileDocument['constraint'] {
  if (typeof value !== 'object' || value === null) return { mime: [] };
  const raw = value as Record<string, unknown>;
  const mime = Array.isArray(raw.mime)
    ? raw.mime.filter((m): m is string => typeof m === 'string').slice(0, 10)
    : [];

  const constraint: SiteProfileDocument['constraint'] = { mime };
  for (const key of ['minBytes', 'maxBytes', 'minW', 'minH', 'maxW', 'maxH', 'dpi'] as const) {
    const number = raw[key];
    if (typeof number === 'number' && Number.isFinite(number) && number > 0) {
      constraint[key] = number;
    }
  }
  return constraint;
}

/**
 * Selectors, length-capped and stripped of anything that is not a string.
 *
 * A selector is inert data — it is handed to `querySelector` or `evaluate`,
 * both of which parse rather than execute — so the risk here is denial of
 * service and confusion, not code execution. Capping length and count deals
 * with both.
 */
function readSelectors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((selector): selector is string => typeof selector === 'string')
    .map((selector) => selector.trim())
    .filter((selector) => selector !== '' && selector.length <= MAX_SELECTOR_LENGTH)
    .slice(0, 10);
}

function readSubmit(value: unknown): SiteProfile['submit'] {
  if (typeof value !== 'object' || value === null) return { selectors: [], label: '' };
  const raw = value as Partial<SiteProfile['submit']>;
  return {
    selectors: readSelectors(raw.selectors),
    label: typeof raw.label === 'string' ? raw.label.slice(0, 100) : '',
  };
}

function isoOr(value: unknown): string {
  if (typeof value !== 'string') return new Date().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

/**
 * An outgoing profile, with nothing in it that should not travel.
 *
 * Rebuilt property by property for the same reason imports are: whatever ends
 * up in a `SiteProfile` in future, only the things named here are shared.
 */
function sanitise(profile: SiteProfile): SiteProfile {
  return {
    siteId: profile.siteId,
    version: profile.version,
    matchUrl: profile.matchUrl,
    formFingerprint: profile.formFingerprint,
    createdAt: profile.createdAt,
    lastVerifiedAt: profile.lastVerifiedAt,
    fields: profile.fields.map((field) => ({
      key: field.key,
      selectors: [...field.selectors],
      confidence: field.confidence,
      source: field.source,
    })),
    documents: profile.documents.map((doc) => ({
      key: doc.key,
      selectors: [...doc.selectors],
      constraint: doc.constraint,
    })),
    submit: { selectors: [...profile.submit.selectors], label: profile.submit.label },
    blockers: profile.blockers.map((blocker) => ({
      type: blocker.type,
      selectors: [...blocker.selectors],
    })),
  };
}
