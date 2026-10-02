/**
 * The audit log (§ Phase 7, P5).
 *
 *   "Every run is auditable. Append-only local log: what was filled, from
 *    where, what the user approved."
 *
 * ## Local, and only local
 *
 * `chrome.storage.local`, which survives a browser restart — unlike the run
 * state, which lives in `storage.session` and should not outlive the sitting.
 * The log is the user's record of what this software did on their behalf, so
 * it has to be there tomorrow. It is never uploaded anywhere; there is no code
 * path from here to the network, and P3 keeps it that way.
 *
 * ## Keys, not values
 *
 * By default an entry records *which kind of thing* was filled, never what was
 * in it: `id.aadhaar`, not the number. That is the difference between a log
 * that helps a user reconstruct what happened and a second, unencrypted copy
 * of their vault sitting in `storage.local` — the audit log becoming the
 * weakest link is a real way for a privacy feature to backfire.
 *
 * A user who wants values in their log can turn it on. It is off by default,
 * it is their choice, and `audit.test.ts` asserts both halves.
 *
 * ## Append-only, and what that honestly means
 *
 * There is no API to edit or delete a single entry — nothing here can rewrite
 * history to hide a fill. There *is* `clearAuditLog`, because a user must be
 * able to delete their own records; it removes everything, visibly, and cannot
 * be used to quietly tidy one inconvenient line out of the middle.
 */

import type { BlockReason, FieldRef } from '@/shared/types';
import type { FieldKey } from '@/matching/taxonomy';
import type { ReviewFlag } from './review';

export const AUDIT_KEY = 'audit:log';
export const AUDIT_SETTINGS_KEY = 'audit:settings';
export const AUDIT_SCHEMA_VERSION = 1;

/** Entries are trimmed to this many, oldest first, to bound storage. */
export const AUDIT_MAX_ENTRIES = 500;

export type AuditEvent =
  | { t: 'run.started'; fields: number }
  | { t: 'fill.completed'; keys: FieldKey[]; filled: number; attempted: number }
  | { t: 'fill.flagged'; flags: Partial<Record<ReviewFlag, number>> }
  | { t: 'user.edited'; key: FieldKey | null; ref: FieldRef }
  | { t: 'user.savedToVault'; key: FieldKey }
  | { t: 'run.blocked'; reason: BlockReason }
  | { t: 'submit.approved'; target: string }
  | { t: 'submit.done' }
  | { t: 'submit.refused'; why: string }
  | { t: 'run.aborted'; why: string }
  /** A document put somewhere a fill does not reach: a site's own upload window. */
  | { t: 'document.placed'; key: FieldKey; route: 'window' | 'drop' }
  /** One document's Upload button, approved and pressed (or refused). */
  | { t: 'upload.approved'; key: FieldKey; target: string }
  | { t: 'upload.done'; key: FieldKey }
  | { t: 'upload.refused'; key: FieldKey; why: string };

export type AuditEventType = AuditEvent['t'];

export interface AuditEntry {
  /** Monotonic within the log. Gaps mean entries were trimmed, not hidden. */
  seq: number;
  at: number;
  /** Origin only — never the full URL, which can carry an application id. */
  site: string;
  formFingerprint: string;
  event: AuditEvent;
  /** Present only when the user opted into value logging. */
  values?: Record<string, string>;
}

export interface AuditSettings {
  /** Off by default. See the note at the top of this file. */
  logValues: boolean;
}

export const DEFAULT_AUDIT_SETTINGS: AuditSettings = { logValues: false };

export interface AuditStorage {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

let storage: AuditStorage | null = null;

export function setAuditStorage(area: AuditStorage | null): void {
  storage = area;
}

function area(): AuditStorage {
  if (storage) return storage;
  const local = (globalThis as { chrome?: { storage?: { local?: AuditStorage } } }).chrome?.storage
    ?.local;
  if (!local) throw new Error('chrome.storage.local is unavailable; call setAuditStorage() first.');
  storage = local;
  return local;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getAuditSettings(): Promise<AuditSettings> {
  const stored = (await area().get(AUDIT_SETTINGS_KEY))[AUDIT_SETTINGS_KEY];
  if (typeof stored !== 'object' || stored === null) return { ...DEFAULT_AUDIT_SETTINGS };
  const logValues = (stored as Partial<AuditSettings>).logValues;
  return { logValues: logValues === true };
}

export async function setAuditSettings(settings: AuditSettings): Promise<void> {
  await area().set({ [AUDIT_SETTINGS_KEY]: { logValues: settings.logValues === true } });
}

// ---------------------------------------------------------------------------
// Appending
// ---------------------------------------------------------------------------

export interface AppendInput {
  site: string;
  formFingerprint: string;
  event: AuditEvent;
  /** Offered, and recorded only if the user turned value logging on. */
  values?: Record<string, string>;
  now?: number;
}

/**
 * Append one entry.
 *
 * The `values` argument is *offered* rather than obeyed: the setting decides.
 * Putting the check here rather than at each call site means a future caller
 * cannot accidentally opt the user in by passing values along.
 */
export async function appendAudit(input: AppendInput): Promise<AuditEntry> {
  const settings = await getAuditSettings();
  const log = await readRawLog();
  const seq = (log.at(-1)?.seq ?? 0) + 1;

  const entry: AuditEntry = {
    seq,
    at: input.now ?? Date.now(),
    site: originOf(input.site),
    formFingerprint: input.formFingerprint,
    event: input.event,
    ...(settings.logValues && input.values ? { values: input.values } : {}),
  };

  const next = [...log, entry].slice(-AUDIT_MAX_ENTRIES);
  await area().set({ [AUDIT_KEY]: { v: AUDIT_SCHEMA_VERSION, entries: next } });
  return entry;
}

export async function readAudit(limit = AUDIT_MAX_ENTRIES): Promise<AuditEntry[]> {
  const log = await readRawLog();
  return limit >= log.length ? log : log.slice(-limit);
}

/** Every entry for one form, oldest first — the story of a single run. */
export async function readRun(formFingerprint: string): Promise<AuditEntry[]> {
  return (await readRawLog()).filter((entry) => entry.formFingerprint === formFingerprint);
}

/**
 * Delete the whole log.
 *
 * The only removal there is, and deliberately all-or-nothing: see the note at
 * the top about what "append-only" means when the user still owns their data.
 */
export async function clearAuditLog(): Promise<void> {
  await area().remove(AUDIT_KEY);
}

async function readRawLog(): Promise<AuditEntry[]> {
  const stored = (await area().get(AUDIT_KEY))[AUDIT_KEY];
  if (typeof stored !== 'object' || stored === null) return [];
  const record = stored as { v?: unknown; entries?: unknown };
  if (record.v !== AUDIT_SCHEMA_VERSION) return [];
  if (!Array.isArray(record.entries)) return [];
  return record.entries.filter(isEntry);
}

function isEntry(value: unknown): value is AuditEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<AuditEntry>;
  return (
    typeof entry.seq === 'number' &&
    typeof entry.at === 'number' &&
    typeof entry.site === 'string' &&
    typeof entry.event === 'object' &&
    entry.event !== null &&
    typeof (entry.event as { t?: unknown }).t === 'string'
  );
}

/**
 * Reduce a URL to its origin.
 *
 * A portal URL frequently carries an application number, a session id, or a
 * candidate id in its query string. The log needs to say *which site*; it does
 * not need to carry an identifier that turns the log into a tracking record.
 */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** One line of plain English per entry, for the panel and for an export. */
export function describeEntry(entry: AuditEntry): string {
  const event = entry.event;
  switch (event.t) {
    case 'run.started':
      return `Scanned a form with ${event.fields} field${event.fields === 1 ? '' : 's'}.`;
    case 'fill.completed':
      return `Filled ${event.filled} of ${event.attempted} fields: ${event.keys.join(', ')}.`;
    case 'fill.flagged': {
      const parts = Object.entries(event.flags).map(([flag, count]) => `${count} ${flag}`);
      return parts.length > 0 ? `Flagged for review: ${parts.join(', ')}.` : 'Nothing flagged.';
    }
    case 'user.edited':
      return `You corrected ${event.key ?? event.ref} by hand.`;
    case 'user.savedToVault':
      return `You saved a correction to your vault: ${event.key}.`;
    case 'run.blocked':
      return `Paused for you to complete a ${event.reason} step.`;
    case 'submit.approved':
      return `You approved submission of ${event.target}.`;
    case 'submit.done':
      return 'Submitted.';
    case 'submit.refused':
      return `Submission refused: ${event.why}`;
    case 'run.aborted':
      return `Run stopped: ${event.why}`;
    case 'document.placed':
      return `Put ${event.key} into the form’s ${event.route === 'window' ? 'upload window' : 'drop area'}.`;
    case 'upload.approved':
      return `You approved uploading ${event.key} with ${event.target}.`;
    case 'upload.done':
      return `Pressed Upload for ${event.key}.`;
    case 'upload.refused':
      return `Upload of ${event.key} refused: ${event.why}`;
  }
}
