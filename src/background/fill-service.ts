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
import { isDocumentKey, type FieldKey } from '@/matching/taxonomy';
import { openVaultDb } from '@/vault/db';
import { getAllFields } from '@/vault/profile-store';
import { isUnlocked, VaultLockedError, withKey } from '@/vault/session';
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
