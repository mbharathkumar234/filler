/**
 * Fill orchestration (§ Phase 5).
 *
 * Builds the write list from matches + vault values and hands it to the content
 * script. Two boundaries are enforced here and nowhere else:
 *
 *  - **Only the values this form actually needs cross into the page.** Filling
 *    a field requires putting its value in the DOM — that is inherent. What is
 *    *not* inherent is shipping the whole vault into a hostile tab, so the
 *    write list carries one value per matched field and nothing else.
 *  - **Nothing below the fill threshold is sent at all.** A low-confidence
 *    match is left blank for the user rather than written and hoped for.
 */

import type { Result } from '@/shared/messages';
import { envelope } from '@/shared/messages';
import type { MatchResult } from '@/shared/types';
import { CONFIDENCE } from '@/shared/types';
import { bandOf } from '@/matching';
import { isDocumentKey, isFieldKey, type FieldKey } from '@/matching/taxonomy';
import { describeReauth, reauthCheck } from '@/runtime/reauth';
import { openVaultDb } from '@/vault/db';
import { getAllFields } from '@/vault/profile-store';
import { isUnlocked, lastAuthenticatedAt, VaultLockedError, withKey } from '@/vault/session';
import { harvestTab, type TabHarvest } from './harvest-service';

export interface SerializedFileValue {
  bytes: number[];
  mime: string;
  filename: string;
}

export interface WriteInstruction {
  ref: string;
  key: string;
  value: string | SerializedFileValue;
  dependent?: boolean;
}

export interface FillOutcomeRecord {
  ref: string;
  key: string;
  ok: boolean;
  strategy?: string;
  truncated?: boolean;
  fuzzy?: boolean;
  fillFailed?: boolean;
  reason?: string;
  attempts: number;
}

export interface FillReport {
  attempted: number;
  filled: number;
  records: FillOutcomeRecord[];
  aborted: boolean;
  /** Fields matched but left blank because confidence was too low. */
  skippedLowConfidence: { key: string; confidence: number }[];
  /** Document fields we had no master for. */
  missingDocuments: string[];
  /** Submissions the guard blocked during the run (P5 audit). */
  blocked: number;
}

/**
 * Build the write list.
 *
 * Exported so it can be unit-tested without a browser: which values leave the
 * worker is exactly the decision that deserves a test of its own.
 */
export function buildWrites(
  matches: readonly MatchResult[],
  values: ReadonlyMap<string, string>,
  dependentSelects: ReadonlySet<string>,
  fieldSelectors: ReadonlyMap<string, string[]>,
): { writes: WriteInstruction[]; skipped: { key: string; confidence: number }[]; missingDocs: string[] } {
  const writes: WriteInstruction[] = [];
  const skipped: { key: string; confidence: number }[] = [];
  const missingDocs: string[] = [];

  for (const match of matches) {
    if (match.key === 'unknown') continue;

    if (bandOf(match) === 'unmapped') {
      // Matched something, but not confidently enough to write.
      skipped.push({ key: match.key, confidence: match.confidence });
      continue;
    }

    if (isDocumentKey(match.key as FieldKey)) {
      // Document variants are attached separately — see attachDocuments.
      missingDocs.push(match.key);
      continue;
    }

    const value = values.get(match.key);
    if (value === undefined || value === '') continue;

    const selectors = fieldSelectors.get(match.fieldRef) ?? [];
    const dependent = selectors.some((selector) => {
      const id = selector.replace(/^#/, '').replace(/^\w+\[name="(.+)"\]$/, '$1');
      return dependentSelects.has(id);
    });

    writes.push({
      ref: match.fieldRef,
      key: match.key,
      value,
      ...(dependent ? { dependent: true } : {}),
    });
  }

  return { writes, skipped, missingDocs };
}

// ---------------------------------------------------------------------------
// Run authorisation (§ Phase 6)
// ---------------------------------------------------------------------------

/**
 * What the worker will do for a tab without a fresh panel gesture.
 *
 * A postback wipes the form, and the run has to be able to put the values back
 * without marching the user to the side panel again. That means honouring a
 * refill request that *originates inside the page* — so it needs a boundary of
 * its own, because a content script lives in hostile territory.
 *
 * The boundary is this: a refill may only ask for keys that were part of a run
 * the user themselves started on that tab, and only while that run is live.
 * A compromised content script gains the ability to re-request values the user
 * already agreed to put on that form. It does not gain the vault.
 */
interface AuthorisedRun {
  tabId: number;
  /** ref -> key, exactly as the run was planned. */
  refs: Map<string, FieldKey>;
  startedAt: number;
}

/** How long a run stays refillable without a new gesture. */
export const RUN_AUTHORISATION_MS = 10 * 60 * 1000;

const authorisedRuns = new Map<number, AuthorisedRun>();

export function authoriseRun(
  tabId: number,
  writes: readonly WriteInstruction[],
  now: number = Date.now(),
): void {
  const refs = new Map<string, FieldKey>();
  for (const write of writes) {
    if (isFieldKey(write.key)) refs.set(write.ref, write.key);
  }
  authorisedRuns.set(tabId, { tabId, refs, startedAt: now });
}

export function endRun(tabId: number): void {
  authorisedRuns.delete(tabId);
}

export function authorisedRun(
  tabId: number,
  now: number = Date.now(),
): AuthorisedRun | null {
  const run = authorisedRuns.get(tabId);
  if (!run) return null;
  if (now - run.startedAt > RUN_AUTHORISATION_MS) {
    authorisedRuns.delete(tabId);
    return null;
  }
  return run;
}

/** Test seam. */
export function __resetRunsForTests(): void {
  authorisedRuns.clear();
}

// ---------------------------------------------------------------------------
// Filling
// ---------------------------------------------------------------------------

/**
 * Fill the active tab.
 *
 * Re-harvests first: the plan may have been built minutes ago, and a page that
 * has since changed shape must not be filled against a stale map.
 */
export async function fillTab(tabId: number): Promise<Result<FillReport>> {
  if (!isUnlocked()) {
    return { ok: false, error: new VaultLockedError().message, code: 'VAULT_LOCKED' };
  }

  const harvested = await harvestTab(tabId);
  if (!harvested.ok) return harvested;

  const harvest: TabHarvest = harvested.data;

  const values = await withKey(async (db, key) => {
    const entries = await getAllFields(db, key);
    return new Map(entries.map((entry) => [entry.key as string, entry.value]));
  });

  const fieldSelectors = new Map(harvest.fields.map((field) => [field.ref, field.selectors]));
  const dependent = new Set(harvest.frames.flatMap((frame) => frame.dependentSelects));

  const { writes, skipped, missingDocs } = buildWrites(
    harvest.matches,
    values,
    dependent,
    fieldSelectors,
  );

  // § Phase 6: the re-authentication gate. Checked here, before any value
  // leaves the worker — not in the panel, which is only the thing that asks.
  const gate = reauthCheck(
    writes.map((write) => write.key).filter(isFieldKey),
    lastAuthenticatedAt(),
    Date.now(),
  );
  if (gate.required) {
    return { ok: false, error: describeReauth(gate.keys), code: 'REAUTH_REQUIRED' };
  }

  if (writes.length === 0) {
    return {
      ok: true,
      data: {
        attempted: 0,
        filled: 0,
        records: [],
        aborted: false,
        skippedLowConfidence: skipped,
        missingDocuments: missingDocs,
        blocked: 0,
      },
    };
  }

  // The user asked for this fill, so the tab may refill itself after a
  // postback until the run ends or expires.
  authoriseRun(tabId, writes);

  const response = (await chrome.tabs.sendMessage(
    tabId,
    envelope({ type: 'fill:apply', writes }),
    { frameId: 0 },
  )) as Result<{ records: FillOutcomeRecord[]; aborted: boolean; blocked: number }> | undefined;

  if (!response?.ok) {
    return { ok: false, error: response?.error ?? 'The page did not respond to the fill request.' };
  }

  return {
    ok: true,
    data: {
      attempted: writes.length,
      filled: response.data.records.filter((record) => record.ok).length,
      records: response.data.records,
      aborted: response.data.aborted,
      skippedLowConfidence: skipped,
      missingDocuments: missingDocs,
      blocked: response.data.blocked,
    },
  };
}

/**
 * Re-send the values for fields a postback reset (§ Phase 6).
 *
 * Requested by the content script, so every guard here matters:
 *
 *  - the vault must be unlocked;
 *  - the tab must have a live, user-started run;
 *  - the refs are intersected with that run's plan, so a request for anything
 *    the user did not approve filling comes back empty rather than honoured;
 *  - the re-auth gate applies again, because time has passed since the gesture.
 */
export async function refillTab(
  tabId: number,
  refs: readonly string[],
): Promise<Result<FillReport>> {
  if (!isUnlocked()) {
    return { ok: false, error: new VaultLockedError().message, code: 'VAULT_LOCKED' };
  }

  const run = authorisedRun(tabId);
  if (!run) {
    return {
      ok: false,
      error: 'This tab has no run in progress. Start the fill from the side panel.',
      code: 'NO_ACTIVE_RUN',
    };
  }

  // Intersection, not trust: the page asks, the plan decides.
  const wanted = refs.filter((ref) => run.refs.has(ref));
  if (wanted.length === 0) {
    return { ok: true, data: emptyReport() };
  }

  const values = await withKey(async (db, key) => {
    const entries = await getAllFields(db, key);
    return new Map(entries.map((entry) => [entry.key as string, entry.value]));
  });

  const keys = wanted.map((ref) => run.refs.get(ref)!).filter(isFieldKey);
  const gate = reauthCheck(keys, lastAuthenticatedAt(), Date.now());
  if (gate.required) {
    return { ok: false, error: describeReauth(gate.keys), code: 'REAUTH_REQUIRED' };
  }

  const writes: WriteInstruction[] = [];
  for (const ref of wanted) {
    const key = run.refs.get(ref)!;
    const value = values.get(key);
    if (value === undefined || value === '') continue;
    writes.push({ ref, key, value });
  }

  if (writes.length === 0) return { ok: true, data: emptyReport() };

  const response = (await chrome.tabs.sendMessage(
    tabId,
    envelope({ type: 'fill:apply', writes }),
    { frameId: 0 },
  )) as Result<{ records: FillOutcomeRecord[]; aborted: boolean; blocked: number }> | undefined;

  if (!response?.ok) {
    return { ok: false, error: response?.error ?? 'The page did not respond to the refill.' };
  }

  return {
    ok: true,
    data: {
      attempted: writes.length,
      filled: response.data.records.filter((record) => record.ok).length,
      records: response.data.records,
      aborted: response.data.aborted,
      skippedLowConfidence: [],
      missingDocuments: [],
      blocked: response.data.blocked,
    },
  };
}

function emptyReport(): FillReport {
  return {
    attempted: 0,
    filled: 0,
    records: [],
    aborted: false,
    skippedLowConfidence: [],
    missingDocuments: [],
    blocked: 0,
  };
}

export async function undoFillOnTab(tabId: number): Promise<Result<{ restored: number }>> {
  const response = (await chrome.tabs.sendMessage(tabId, envelope({ type: 'fill:undo' }), {
    frameId: 0,
  })) as Result<{ restored: number }> | undefined;

  return response ?? { ok: false, error: 'The page did not respond to the undo request.' };
}

/** Confidence bands, re-exported so the panel and the worker agree. */
export { CONFIDENCE };

/** Ensure the vault is open before a fill is even offered. */
export async function canFill(): Promise<boolean> {
  if (!isUnlocked()) return false;
  const db = await openVaultDb();
  return (await db.count('profile')) > 0;
}
