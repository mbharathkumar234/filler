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
import type { FieldRef } from '@/shared/types';
import { buildReview, type ReviewModel, type ReviewRecord } from '@/runtime/review';
import { isDocumentKey, isFieldKey, type FieldKey } from '@/matching/taxonomy';
import { describeConstraint } from '@/documents/constraints';
import { constraintForField } from '@/documents/field-constraint';
import { setField } from '@/vault/profile-store';
import { isUnlocked, VaultLockedError, withKey } from '@/vault/session';
import { harvestTab, type TabHarvest } from './harvest-service';
import type { DocumentOutcome, DocumentRoute, FillOutcomeRecord } from './fill-service';
import { uploadedKeys } from './upload-state';

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
  route: DocumentRoute;
  /** What the page asks for, in words — shown beside what was attached. */
  requirement: string;
  /** What was attached — set once a fill has fitted a document to this box. */
  variant: { mime: string; bytes: number; width: number; height: number } | null;
  /**
   * Whether the page holds it now. For a file box this is read back from the
   * page, not remembered: a postback empties file boxes, and the review must
   * not claim a document the page no longer has.
   */
  attached: boolean;
  /** The file box's own Upload button — offered, with approval, when present. */
  uploadButton: string | null;
  /** The extension already pressed Upload for this one in this run. */
  uploaded: boolean;
  /** Why it is not attached, when it is not. */
  problem?: string;
  code?: string;
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
const lastDocuments = new Map<number, DocumentOutcome[]>();
const userEdits = new Map<number, Set<FieldRef>>();

export function rememberRecords(tabId: number, records: readonly FillOutcomeRecord[]): void {
  lastRecords.set(tabId, [...records]);
}

/** What the last fill did with each document, for the review's document section. */
export function rememberDocuments(tabId: number, outcomes: readonly DocumentOutcome[]): void {
  lastDocuments.set(tabId, [...outcomes]);
}

export function documentOutcomes(tabId: number): readonly DocumentOutcome[] {
  return lastDocuments.get(tabId) ?? [];
}

/** One document's latest outcome — an upload window is filled one at a time. */
export function rememberDocument(tabId: number, outcome: DocumentOutcome): void {
  const others = (lastDocuments.get(tabId) ?? []).filter((known) => known.ref !== outcome.ref);
  lastDocuments.set(tabId, [...others, outcome]);
}

export function noteUserEdit(tabId: number, ref: FieldRef): void {
  const edits = userEdits.get(tabId) ?? new Set<FieldRef>();
  edits.add(ref);
  userEdits.set(tabId, edits);
}

export function forgetTabReview(tabId: number): void {
  lastRecords.delete(tabId);
  lastDocuments.delete(tabId);
  userEdits.delete(tabId);
}

/** Test seam. */
export function __resetReviewForTests(): void {
  lastRecords.clear();
  lastDocuments.clear();
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
        // A file box is often hidden behind a styled button, and whether it
        // holds the document is exactly what the document section must know.
        (field.visible || (field.tag === 'file' && matched.has(field.ref))) &&
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
      documents: documentsFor(harvest, values, documentOutcomes(tabId), uploadedKeys(tabId)),
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

export async function collectValues(
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
 * Every document this form asks for, and where each one stands.
 *
 * The requirement sits beside what was attached, so a photograph 3 KB over the
 * limit is visible before the portal rejects it rather than after. Three
 * sources, in form order: file boxes (matched like any field), drop areas and
 * upload windows (the harvest's upload slots).
 */
export function documentsFor(
  harvest: Pick<TabHarvest, 'matches' | 'fields' | 'uploadSlots' | 'uploadButtons'>,
  values: ReadonlyMap<FieldRef, string>,
  outcomes: readonly DocumentOutcome[],
  uploaded: ReadonlySet<FieldKey>,
): ReviewDocument[] {
  const documents: ReviewDocument[] = [];
  const outcomeFor = (ref: string) => outcomes.find((outcome) => outcome.ref === ref);

  for (const match of harvest.matches) {
    if (!isFieldKey(match.key) || !isDocumentKey(match.key)) continue;
    const field = harvest.fields.find((f) => f.ref === match.fieldRef && f.frameId === 0);
    if (!field || field.tag !== 'file') continue;

    const outcome = outcomeFor(match.fieldRef);
    // Read back, not remembered: a postback empties file boxes.
    const attached = values.get(match.fieldRef) === 'file';
    const done = uploaded.has(match.key);
    documents.push({
      ref: match.fieldRef,
      key: match.key,
      portalLabel: field.labelText.trim() || field.nearbyText.trim() || 'Document',
      route: 'file-box',
      requirement:
        outcome?.requirement ??
        describeConstraint(
          constraintForField({
            labelText: field.labelText,
            ...(field.requirementText === undefined ? {} : { requirementText: field.requirementText }),
            ...(field.accept === undefined ? {} : { accept: field.accept }),
          }).constraint,
        ),
      variant: outcome?.variant ? stripVariant(outcome.variant) : null,
      attached,
      uploadButton: harvest.uploadButtons[match.fieldRef]?.label ?? null,
      uploaded: done,
      ...problemFor(outcome, attached, done),
    });
  }

  for (const slot of harvest.uploadSlots) {
    if (slot.key === null) continue;
    const outcome = outcomeFor(slot.ref);
    const route: DocumentRoute = slot.kind === 'drop' ? 'drop' : 'window';
    // Neither kind can be read back — a drop widget and an upload window keep
    // the file in their own state — so the last answer is the best knowledge.
    const attached = outcome?.attached === true;
    documents.push({
      ref: slot.ref,
      key: slot.key,
      portalLabel: slot.label,
      route,
      requirement: outcome?.requirement ?? describeConstraint(slot.constraint),
      variant: outcome?.variant ? stripVariant(outcome.variant) : null,
      attached,
      uploadButton: null,
      uploaded: false,
      ...(route === 'window' ? windowProblem(attached) : problemFor(outcome, attached, false)),
    });
  }

  return documents;
}

function windowProblem(placed: boolean): { problem: string; code: string } {
  return placed
    ? {
        code: 'press-upload-in-window',
        problem: 'Placed in the form’s upload window — press Upload there to finish.',
      }
    : {
        code: 'needs-window',
        problem:
          'This form uploads through its own window: click its Add file button, then press ' +
          '“Put in the upload window” in the Fields panel, and press Upload yourself.',
      };
}

function stripVariant(variant: NonNullable<DocumentOutcome['variant']>): ReviewDocument['variant'] {
  return { mime: variant.mime, bytes: variant.bytes, width: variant.width, height: variant.height };
}

function problemFor(
  outcome: DocumentOutcome | undefined,
  attached: boolean,
  uploaded: boolean,
): { problem?: string; code?: string } {
  if (attached) return {};
  if (uploaded) return { code: 'already-uploaded', problem: 'Uploaded earlier in this run.' };
  if (!outcome) return { code: 'not-filled', problem: 'Nothing attached yet — press Fill this form.' };
  if (outcome.reason) {
    return { problem: outcome.reason, ...(outcome.code === undefined ? {} : { code: outcome.code }) };
  }
  // The fill attached it, and it is gone now: a postback emptied the box.
  return {
    code: 'emptied',
    problem: 'It was attached, but the page has since emptied the box. Press Fill again to re-attach it.',
  };
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
