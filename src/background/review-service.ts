/**
 * Review orchestration (§ Phase 7).
 *
 * Assembles what the user is shown: re-harvests the page, reads back what is
 * actually in every field, folds in the outcomes of the fill run, and hands
 * `buildReview` the lot.
 *
 * It re-harvests rather than trusting the plan for the same reason `fillTab`
 * does — the page may have changed since. A review screen built from a stale
 * map would describe a form that is no longer there, which is the one failure
 * a review screen cannot be allowed to have.
 */

import type { Result } from '@/shared/messages';
import { envelope } from '@/shared/messages';
import type { DocConstraint, FieldRef } from '@/shared/types';
import { buildReview, type ReviewModel, type ReviewRecord } from '@/runtime/review';
import { isFieldKey, type FieldKey } from '@/matching/taxonomy';
import { setField } from '@/vault/profile-store';
import { isUnlocked, VaultLockedError, withKey } from '@/vault/session';
import { harvestTab, type TabHarvest } from './harvest-service';
import type { FillOutcomeRecord } from './fill-service';

/** What the panel receives. The model, plus the context around it. */
export interface ReviewPayload {
  model: ReviewModel;
  url: string;
  title: string;
  formFingerprint: string;
  /** The element approval would name. Null means there is nothing to submit. */
  submit: { selector: string; label: string } | null;
  /** Human-only steps still outstanding — approval is refused while any remain. */
  blockers: { type: string; reason: string }[];
  /** Documents this form asked for, with what we would attach (§ Phase 7 Must). */
  documents: ReviewDocument[];
}

export interface ReviewDocument {
  ref: FieldRef;
  key: FieldKey;
  portalLabel: string;
  constraint: DocConstraint | null;
  /** Set once a variant has been derived for this field. */
  variant: { mime: string; bytes: number; width: number; height: number } | null;
  /** Why we cannot attach one, when we cannot. */
  problem?: string;
}

/**
 * The outcomes of the last fill, per tab.
 *
 * Held in the worker rather than asked of the page, because `truncated` and
 * `fuzzy` are facts about *what the fill engine did*, and the page has no
 * memory of them — a truncated value looks identical to a short one once it
 * is sitting in an input.
 */
const lastRecords = new Map<number, FillOutcomeRecord[]>();
const userEdits = new Map<number, Set<FieldRef>>();

export function rememberRecords(tabId: number, records: readonly FillOutcomeRecord[]): void {
  lastRecords.set(tabId, [...records]);
}

export function noteUserEdit(tabId: number, ref: FieldRef): void {
  const edits = userEdits.get(tabId) ?? new Set<FieldRef>();
  edits.add(ref);
  userEdits.set(tabId, edits);
}

export function forgetTabReview(tabId: number): void {
  lastRecords.delete(tabId);
  userEdits.delete(tabId);
}

/** Test seam. */
export function __resetReviewForTests(): void {
  lastRecords.clear();
  userEdits.clear();
}

/**
 * Build the review for a tab.
 *
 * The values come from the page in one round trip, asking only for the refs
 * the review will actually show. Asking for everything would mean pulling the
 * contents of fields the user typed themselves and we have no business
 * reading.
 */
export async function buildReviewForTab(tabId: number): Promise<Result<ReviewPayload>> {
  const harvested = await harvestTab(tabId);
  if (!harvested.ok) return harvested;

  const harvest: TabHarvest = harvested.data;
  const records = lastRecords.get(tabId) ?? [];

  // Only fields we touched, mapped, or the portal requires — the same set
  // `buildReview` will keep, worked out here so the page is asked for no more
  // than that.
  const matched = new Set(
    harvest.matches.filter((match) => match.key !== 'unknown').map((match) => match.fieldRef),
  );
  const refs = harvest.fields
    .filter(
      (field) =>
        field.visible &&
        (matched.has(field.ref) || field.required || records.some((r) => r.ref === field.ref)),
    )
    .map((field) => field.ref);

  const values = await collectValues(tabId, refs);

  const model = buildReview({
    fields: harvest.fields,
    matches: harvest.matches,
    records: records.map(toReviewRecord),
    values,
    edits: userEdits.get(tabId) ?? new Set(),
  });

  return {
    ok: true,
    data: {
      model,
      url: harvest.url,
      title: harvest.title,
      formFingerprint: harvest.fingerprint,
      submit: harvest.frames.find((frame) => frame.frameId === 0)?.submit ?? null,
      blockers: harvest.blockers.map((blocker) => ({
        type: blocker.type,
        reason: blocker.reason,
      })),
      documents: documentsFor(harvest),
    },
  };
}

function toReviewRecord(record: FillOutcomeRecord): ReviewRecord {
  return {
    ref: record.ref,
    ok: record.ok,
    ...(record.truncated === undefined ? {} : { truncated: record.truncated }),
    ...(record.fuzzy === undefined ? {} : { fuzzy: record.fuzzy }),
    ...(record.fillFailed === undefined ? {} : { fillFailed: record.fillFailed }),
    ...(record.reason === undefined ? {} : { reason: record.reason }),
  };
}

async function collectValues(
  tabId: number,
  refs: readonly string[],
): Promise<Map<FieldRef, string>> {
  if (refs.length === 0) return new Map();
  try {
    const response = (await chrome.tabs.sendMessage(
      tabId,
      envelope({ type: 'review:collect', refs: [...refs] }),
      { frameId: 0 },
    )) as Result<Record<string, string>> | undefined;

    if (!response?.ok) return new Map();
    return new Map(Object.entries(response.data));
  } catch {
    // A page that will not answer leaves every value blank, which the review
    // renders as "we cannot see this field" rather than as "it is empty".
    return new Map();
  }
}

/**
 * Document fields on this form.
 *
 * Phase 2 derives the variants; this only reports what the form is asking for
 * and what state we are in. The panel shows the requirement beside what we
 * would attach, so a photograph that is 3 KB over the limit is visible before
 * the portal rejects it rather than after.
 */
function documentsFor(harvest: TabHarvest): ReviewDocument[] {
  const documents: ReviewDocument[] = [];

  for (const match of harvest.matches) {
    if (!isFieldKey(match.key) || !match.key.startsWith('doc.')) continue;
    const field = harvest.fields.find((f) => f.ref === match.fieldRef);
    if (!field) continue;

    documents.push({
      ref: match.fieldRef,
      key: match.key,
      portalLabel: field.labelText.trim() || field.nearbyText.trim() || 'Document',
      // Requirement text lives beside the input; Phase 2's parser turns it
      // into a constraint when the panel asks to derive.
      constraint: null,
      variant: null,
      problem: 'Attach from the Documents panel — derived variants arrive there.',
    });
  }

  return documents;
}

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

export interface EditResult {
  ok: boolean;
  value: string;
  savedToVault: boolean;
}

/**
 * Apply a correction the user typed, and optionally learn from it.
 *
 * "Save this to my vault" is opt-in per correction rather than automatic. An
 * extension that silently rewrote the user's stored details every time they
 * fixed a portal's idea of their own name would corrupt the vault one form at
 * a time.
 */
export async function editFieldOnTab(args: {
  tabId: number;
  ref: FieldRef;
  value: string;
  saveKey?: FieldKey;
}): Promise<Result<EditResult>> {
  const response = (await chrome.tabs.sendMessage(
    args.tabId,
    envelope({ type: 'field:apply-edit', ref: args.ref, value: args.value }),
    { frameId: 0 },
  )) as Result<{ ok: boolean; value: string }> | undefined;

  if (!response?.ok) {
    return { ok: false, error: response?.error ?? 'The page did not accept that correction.' };
  }

  noteUserEdit(args.tabId, args.ref);

  let savedToVault = false;
  if (args.saveKey !== undefined && response.data.ok) {
    if (!isUnlocked()) {
      return { ok: false, error: new VaultLockedError().message, code: 'VAULT_LOCKED' };
    }
    await withKey((db, key) => setField(db, key, args.saveKey!, response.data.value));
    savedToVault = true;
  }

  return { ok: true, data: { ...response.data, savedToVault } };
}

export async function highlightFieldOnTab(tabId: number, ref: FieldRef): Promise<Result<null>> {
  const response = (await chrome.tabs.sendMessage(
    tabId,
    envelope({ type: 'field:focus', ref }),
    { frameId: 0 },
  )) as Result<null> | undefined;

  return response ?? { ok: false, error: 'The page did not respond.' };
}
