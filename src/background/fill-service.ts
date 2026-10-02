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
 *
 * Documents ride the same run. Each upload box the form has — a file box, or a
 * drag-and-drop area with none — is given the stored document it asks for,
 * fitted to what the page says it accepts (`documents/field-constraint.ts`),
 * after every text field, so a dependent dropdown's postback cannot wipe it.
 * An upload window the user has to open themselves (Google Forms' "Add file")
 * is not part of a fill; see `upload-window-service.ts`.
 */

import type { Result } from '@/shared/messages';
import { envelope } from '@/shared/messages';
import type { DocConstraint, FillPlan, MatchResult, PlannedField } from '@/shared/types';
import { CONFIDENCE } from '@/shared/types';
import { bandOf } from '@/matching';
import { isDocumentKey, isFieldKey, type FieldKey } from '@/matching/taxonomy';
import { answerLevellessEducation } from '@/matching/qualifications';
import { locateBySelector } from '@/matching/profile-cache';
import { describeReauth, reauthCheck } from '@/runtime/reauth';
import { appendAudit } from '@/runtime/audit';
import { rememberDocuments, rememberRecords } from './review-service';
import { openVaultDb } from '@/vault/db';
import { getAllFields } from '@/vault/profile-store';
import { isUnlocked, lastAuthenticatedAt, VaultLockedError, withKey } from '@/vault/session';
import { harvestTab, type TabHarvest } from './harvest-service';
import { variantFor } from './document-service';
import { __resetUploadsForTests, forgetUploads, uploadedKeys } from './upload-state';
import { constraintForField, fileNameFor } from '@/documents/field-constraint';
import { describeBytes, describeConstraint } from '@/documents/constraints';
import { bytesToBase64 } from '@/shared/base64';

/** A document on its way into the page. Base64: see `shared/base64.ts`. */
export interface SerializedFileValue {
  base64: string;
  mime: string;
  filename: string;
}

/**
 * The most document bytes one fill carries into the page.
 *
 * Not a P1/P6 cap — those live in `limits.ts`. This one is transport: every
 * document travels in the single `fill:apply` message, and Chrome refuses a
 * message over 64 MiB. Base64 at this budget is ~43 MB, leaving room for the
 * rest. A document past it is reported, never silently dropped.
 */
export const MAX_ATTACH_BYTES_PER_FILL = 32 * 1024 * 1024;

export type DocumentRoute = 'file-box' | 'drop' | 'window';

/** What happened to one document the form asked for. */
export interface DocumentOutcome {
  /** A field ref (`f3`) for a file box, a slot ref (`u1`) otherwise. */
  ref: string;
  key: FieldKey;
  /** The portal's own words for it. */
  portalLabel: string;
  route: DocumentRoute;
  attached: boolean;
  /** What the document was fitted to, in words. */
  requirement: string;
  /** What was attached, or would have been. */
  variant?: { mime: string; bytes: number; width: number; height: number; passedThrough: boolean };
  /** Why it is not attached, when it is not — a sentence for the user. */
  reason?: string;
  /** Machine-readable reason, so the panel can offer the right remedy. */
  code?: string;
  /** The file box's own Upload button, which the review can press with approval. */
  uploadButton?: string;
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
  /** Every document the form asked for, attached or not, and why. */
  documents: DocumentOutcome[];
  /**
   * Upload questions on the form that the extension could not name.
   *
   * Listed rather than dropped: on a test portal with five required uploads
   * the panel said "Attached 3 of 3 documents", which reads as done when two
   * had never been tried. A question the matcher cannot place is one the user
   * has to deal with, and the only way they know is if it is on the list.
   */
  unrecognisedUploads: { ref: string; label: string }[];
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
): {
  writes: WriteInstruction[];
  skipped: { key: string; confidence: number }[];
  /** Document fields: no vault value, a file — see `prepareDocuments`. */
  documents: { ref: string; key: FieldKey }[];
} {
  const writes: WriteInstruction[] = [];
  const skipped: { key: string; confidence: number }[] = [];
  const documents: { ref: string; key: FieldKey }[] = [];

  for (const match of matches) {
    if (match.key === 'unknown') continue;

    if (bandOf(match) === 'unmapped') {
      // Matched something, but not confidently enough to write.
      skipped.push({ key: match.key, confidence: match.confidence });
      continue;
    }

    if (isFieldKey(match.key) && isDocumentKey(match.key)) {
      documents.push({ ref: match.fieldRef, key: match.key });
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

  return { writes, skipped, documents };
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/** One upload box on the form, and everything needed to fit a document to it. */
interface DocumentSlot {
  ref: string;
  key: FieldKey;
  route: 'file-box' | 'drop';
  portalLabel: string;
  labelText: string;
  requirementText?: string;
  accept?: string;
  selectors: string[];
}

/**
 * The upload boxes a fill can put a document into, in form order.
 *
 * File boxes come from the matcher like any field. Drop areas come from the
 * harvest's upload slots — only the `drop` kind: a `window` slot needs the
 * user to open the site's own upload window first.
 */
/**
 * File boxes and drop areas the form has that no document was matched to.
 *
 * Top frame only, as `documentSlotsFor` is. A box with no words at all is
 * still listed ("An upload box with no label"): it is a question the page
 * asks, and saying nothing about it is how "3 of 3" happened.
 */
export function unrecognisedUploadsIn(
  harvest: Pick<TabHarvest, 'fields' | 'uploadSlots'>,
  fromMatches: readonly { ref: string }[],
): { ref: string; label: string }[] {
  const named = new Set(fromMatches.map((match) => match.ref));
  const unnamed: { ref: string; label: string }[] = [];

  for (const field of harvest.fields) {
    if (field.frameId !== 0 || field.tag !== 'file' || named.has(field.ref)) continue;
    unnamed.push({
      ref: field.ref,
      label: field.labelText.trim() || field.nearbyText.trim() || 'An upload box with no label',
    });
  }
  for (const slot of harvest.uploadSlots) {
    if (slot.kind === 'drop' && slot.key === null) unnamed.push({ ref: slot.ref, label: slot.label });
  }
  return unnamed;
}

export function documentSlotsFor(
  harvest: Pick<TabHarvest, 'fields' | 'uploadSlots'>,
  fromMatches: readonly { ref: string; key: FieldKey }[],
): DocumentSlot[] {
  const slots: DocumentSlot[] = [];
  const topFields = harvest.fields.filter((field) => field.frameId === 0);

  for (const { ref, key } of fromMatches) {
    const field = topFields.find((f) => f.ref === ref);
    // The traits veto keeps doc keys on file boxes; this is the belt to its braces.
    if (!field || field.tag !== 'file') continue;
    slots.push({
      ref,
      key,
      route: 'file-box',
      portalLabel: field.labelText.trim() || field.nearbyText.trim() || 'Document',
      labelText: field.labelText,
      ...(field.requirementText === undefined ? {} : { requirementText: field.requirementText }),
      ...(field.accept === undefined ? {} : { accept: field.accept }),
      selectors: field.selectors,
    });
  }

  for (const slot of harvest.uploadSlots) {
    if (slot.kind !== 'drop' || slot.key === null) continue;
    slots.push({
      ref: slot.ref,
      key: slot.key,
      route: 'drop',
      portalLabel: slot.label,
      labelText: slot.label,
      requirementText: slot.requirementText,
      selectors: slot.selectors,
    });
  }

  return slots;
}

/** A constraint the user taught for exactly this box, if a profile carries one. */
function taughtConstraint(
  harvest: Pick<TabHarvest, 'fields' | 'documentRules'>,
  slot: DocumentSlot,
): DocConstraint | null {
  const topFields = harvest.fields.filter((field) => field.frameId === 0);
  for (const rule of harvest.documentRules) {
    if (rule.key !== slot.key) continue;
    if (locateBySelector(rule.selectors, topFields)?.ref === slot.ref) return rule.constraint;
    // A drop area is not a field, so compare its own selectors directly.
    if (slot.route === 'drop' && rule.selectors.some((s) => slot.selectors.includes(s))) {
      return rule.constraint;
    }
  }
  return null;
}

/** The requirement one slot's document must be fitted to. */
export function constraintForSlot(
  harvest: Pick<TabHarvest, 'fields' | 'documentRules'>,
  slot: DocumentSlot,
): DocConstraint {
  return constraintForField({
    labelText: slot.labelText,
    ...(slot.requirementText === undefined ? {} : { requirementText: slot.requirementText }),
    ...(slot.accept === undefined ? {} : { accept: slot.accept }),
    taught: taughtConstraint(harvest, slot),
  }).constraint;
}

/** A document fitted and ready, or the outcome that explains why not. */
interface PreparedDocuments {
  writes: WriteInstruction[];
  /** Keyed by ref, in form order. `attached` is settled once the page answers. */
  outcomes: Map<string, DocumentOutcome>;
  constraints: Map<string, DocConstraint>;
}

/**
 * Fit each slot's document to what the page asks for.
 *
 * Runs only after the re-auth gate has passed, because this is where document
 * bytes are decrypted. A failure here is an outcome with the pipeline's own
 * sentence — "No PAN card saved", "cannot be made smaller than 50 KB" — never
 * an exception that takes the text fields down with it.
 */
async function prepareDocuments(
  harvest: TabHarvest,
  slots: readonly DocumentSlot[],
  alreadyUploaded: ReadonlySet<FieldKey>,
): Promise<PreparedDocuments> {
  const writes: WriteInstruction[] = [];
  const outcomes = new Map<string, DocumentOutcome>();
  const constraints = new Map<string, DocConstraint>();
  let budget = MAX_ATTACH_BYTES_PER_FILL;

  for (const slot of slots) {
    const constraint = constraintForSlot(harvest, slot);
    constraints.set(slot.ref, constraint);
    const button = slot.route === 'file-box' ? harvest.uploadButtons[slot.ref] : undefined;
    const base = {
      ref: slot.ref,
      key: slot.key,
      portalLabel: slot.portalLabel,
      route: slot.route,
      requirement: describeConstraint(constraint),
      ...(button ? { uploadButton: button.label } : {}),
    };

    if (alreadyUploaded.has(slot.key)) {
      outcomes.set(slot.ref, {
        ...base,
        attached: false,
        code: 'already-uploaded',
        reason: 'Already uploaded in this run, so it was not attached a second time.',
      });
      continue;
    }

    const variant = await variantFor(slot.key, constraint);
    if (!variant.ok) {
      outcomes.set(slot.ref, { ...base, attached: false, code: variant.code, reason: variant.reason });
      continue;
    }

    if (variant.bytes.length > budget) {
      outcomes.set(slot.ref, {
        ...base,
        attached: false,
        code: 'over-budget',
        reason:
          `At ${describeBytes(variant.bytes.length)} this would take one fill past what it can ` +
          'carry into the page. Upload the others first, then press Fill again.',
      });
      continue;
    }
    budget -= variant.bytes.length;

    writes.push({
      ref: slot.ref,
      key: slot.key,
      value: {
        base64: bytesToBase64(variant.bytes),
        mime: variant.mime,
        filename: fileNameFor(slot.key, variant.mime),
      },
    });
    outcomes.set(slot.ref, {
      ...base,
      // Settled from the page's own read-back once it answers.
      attached: false,
      variant: {
        mime: variant.mime,
        bytes: variant.bytes.length,
        width: variant.width,
        height: variant.height,
        passedThrough: variant.passedThrough,
      },
    });
  }

  return { writes, outcomes, constraints };
}

/** Fold the page's per-write records into the document outcomes. */
function settleDocuments(
  outcomes: ReadonlyMap<string, DocumentOutcome>,
  records: readonly FillOutcomeRecord[],
): DocumentOutcome[] {
  return [...outcomes.values()].map((outcome) => {
    if (!outcome.variant || outcome.code !== undefined) return outcome;
    const record = records.find((r) => r.ref === outcome.ref);
    if (record?.ok) return { ...outcome, attached: true };
    return {
      ...outcome,
      attached: false,
      code: 'page-refused',
      reason: record?.reason
        ? `The page did not take it: ${record.reason}.`
        : 'The fill stopped before this document was reached.',
    };
  });
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

/**
 * Told when a run ends, however it ends: approved and submitted, aborted,
 * timed out, or its tab closed.
 *
 * The worker uses it to hand the page back — the guard disengaged, the
 * per-origin document_start script unregistered. Without it that script
 * outlived the fill for the rest of the browser session, and locked the submit
 * buttons of every later page on the same host.
 */
type RunEndedHandler = (tabId: number) => void;
let runEnded: RunEndedHandler = () => {};

export function onRunEnded(handler: RunEndedHandler): void {
  runEnded = handler;
}

export function endRun(tabId: number): void {
  const had = authorisedRuns.delete(tabId);
  forgetUploads(tabId);
  if (had) runEnded(tabId);
}

/** The tabs with a fill live right now. */
export function liveRunTabs(now: number = Date.now()): number[] {
  return [...authorisedRuns.keys()].filter((tabId) => authorisedRun(tabId, now) !== null);
}

export function authorisedRun(
  tabId: number,
  now: number = Date.now(),
): AuthorisedRun | null {
  const run = authorisedRuns.get(tabId);
  if (!run) return null;
  if (now - run.startedAt > RUN_AUTHORISATION_MS) {
    // Expired: ended, and released like any other ending.
    authorisedRuns.delete(tabId);
    runEnded(tabId);
    return null;
  }
  return run;
}

/** Test seam. */
export function __resetRunsForTests(): void {
  authorisedRuns.clear();
  __resetUploadsForTests();
}

// ---------------------------------------------------------------------------
// Filling
// ---------------------------------------------------------------------------

/**
 * The plan the page's run state machine runs on.
 *
 * Built from the harvest that was just taken, so the selectors it carries are
 * the ones the fill is about to use — which is the whole point, since drift
 * recovery later asks "are these still here?".
 *
 * `submit` is deliberately null. P2 says submission happens only after an
 * explicit approval action, and the guard is armed separately by an approval
 * token; putting a submit selector in the plan would be the first half of a
 * capability nothing here should have.
 *
 * Documents go in `documents`, never `fields`. Re-verification walks `fields`
 * and refills what a postback emptied — and on a portal whose Upload button
 * posts the form, an emptied file box usually means the upload *worked*.
 * Putting it back would ask the user to upload the same document twice.
 */
function planFrom(
  harvest: TabHarvest,
  writes: readonly WriteInstruction[],
  documents: ReadonlyMap<string, { key: FieldKey; constraint: DocConstraint }> = new Map(),
): FillPlan {
  const selectors = new Map(harvest.fields.map((field) => [field.ref, field.selectors]));
  const matched = new Map(harvest.matches.map((match) => [match.fieldRef, match]));

  const fields: PlannedField[] = [];
  for (const write of writes) {
    if (documents.has(write.ref)) continue;
    const match = matched.get(write.ref);
    if (!match || !isFieldKey(match.key)) continue;
    fields.push({
      fieldRef: write.ref,
      key: match.key,
      selectors: selectors.get(write.ref) ?? [],
      confidence: match.confidence,
      source: match.source,
    });
  }

  return {
    siteId: harvest.profileUsed?.siteId ?? new URL(harvest.url).hostname,
    profileVersion: harvest.profileUsed?.version ?? null,
    formFingerprint: harvest.fingerprint,
    tabId: harvest.tabId,
    fields,
    documents: [...documents].map(([fieldRef, { key, constraint }]) => ({ fieldRef, key, constraint })),
    submit: null,
    createdAt: Date.now(),
  };
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
    // A question that names no qualification is answered from the most recent
    // one the user holds, rather than from a second copy they had to type.
    return answerLevellessEducation(new Map(entries.map((entry) => [entry.key as string, entry.value])));
  });

  const fieldSelectors = new Map(harvest.fields.map((field) => [field.ref, field.selectors]));
  const dependent = new Set(harvest.frames.flatMap((frame) => frame.dependentSelects));

  const { writes: textWrites, skipped, documents: documentMatches } = buildWrites(
    harvest.matches,
    values,
    dependent,
    fieldSelectors,
  );

  const alreadyUploaded = uploadedKeys(tabId);
  const slots = documentSlotsFor(harvest, documentMatches);

  // § Phase 6: the re-authentication gate. Checked here, before any value
  // leaves the worker — not in the panel, which is only the thing that asks.
  // Documents count: a signature or an Aadhaar card is `high` sensitivity, and
  // the gate runs before a single document is decrypted, not after.
  const gate = reauthCheck(
    [
      ...textWrites.map((write) => write.key).filter(isFieldKey),
      ...slots.filter((slot) => !alreadyUploaded.has(slot.key)).map((slot) => slot.key),
    ],
    lastAuthenticatedAt(),
    Date.now(),
  );
  if (gate.required) {
    return { ok: false, error: describeReauth(gate.keys), code: 'REAUTH_REQUIRED' };
  }

  const prepared = await prepareDocuments(harvest, slots, alreadyUploaded);

  // Text first, documents last: a dependent dropdown's postback empties every
  // file box, and it should happen before anything is attached, not after.
  const writes = [...textWrites, ...prepared.writes];

  if (writes.length === 0) {
    const documents = settleDocuments(prepared.outcomes, []);
    rememberDocuments(tabId, documents);
    return {
      ok: true,
      data: {
        attempted: 0,
        filled: 0,
        records: [],
        aborted: false,
        skippedLowConfidence: skipped,
        documents,
        unrecognisedUploads: unrecognisedUploadsIn(harvest, documentMatches),
        blocked: 0,
      },
    };
  }

  // The user asked for this fill, so the tab may refill itself after a
  // postback until the run ends or expires. Text only — a refill never
  // carries a document (see `planFrom`).
  authoriseRun(tabId, textWrites);

  const planned = new Map(
    prepared.writes.map((write) => [
      write.ref,
      { key: write.key as FieldKey, constraint: prepared.constraints.get(write.ref) ?? { mime: [] } },
    ]),
  );

  const response = (await chrome.tabs.sendMessage(
    tabId,
    envelope({ type: 'fill:apply', writes, plan: planFrom(harvest, writes, planned) }),
    { frameId: 0 },
  )) as Result<{ records: FillOutcomeRecord[]; aborted: boolean; blocked: number }> | undefined;

  if (!response?.ok) {
    return { ok: false, error: response?.error ?? 'The page did not respond to the fill request.' };
  }

  const documents = settleDocuments(prepared.outcomes, response.data.records);

  // § Phase 7: keep the per-field outcomes for the review screen. `truncated`
  // and `fuzzy` are facts about what the fill engine did, and the page has no
  // memory of them — a shortened value is indistinguishable from a short one
  // once it is sitting in an input.
  rememberRecords(tabId, response.data.records);
  rememberDocuments(tabId, documents);

  await appendAudit({
    site: harvest.url,
    formFingerprint: harvest.fingerprint,
    event: {
      t: 'fill.completed',
      keys: writes.map((write) => write.key).filter(isFieldKey),
      filled: response.data.records.filter((record) => record.ok).length,
      attempted: writes.length,
    },
    // Text only. A document is never a logged value — not its bytes, and not
    // even the neutral filename; the key above says which one went in.
    values: Object.fromEntries(
      writes
        .filter((write) => typeof write.value === 'string')
        .map((write) => [write.key, write.value as string]),
    ),
  }).catch(() => {
    // An audit write that fails must not take the fill down with it.
  });

  return {
    ok: true,
    data: {
      attempted: writes.length,
      filled: response.data.records.filter((record) => record.ok).length,
      records: response.data.records,
      aborted: response.data.aborted,
      skippedLowConfidence: skipped,
      documents,
      unrecognisedUploads: unrecognisedUploadsIn(harvest, documentMatches),
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
    // A question that names no qualification is answered from the most recent
    // one the user holds, rather than from a second copy they had to type.
    return answerLevellessEducation(new Map(entries.map((entry) => [entry.key as string, entry.value])));
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
      documents: [],
      unrecognisedUploads: [],
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
    documents: [],
    unrecognisedUploads: [],
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
