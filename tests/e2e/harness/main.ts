/**
 * Browser-side harness for the derivation pipeline.
 *
 * Unit tests cover the pipeline's decisions against a fake backend (§6.1: no
 * DOM). This harness exists so the *real* backend — OffscreenCanvas, the JPEG
 * encoder, pdf.js — can be exercised in a real browser by Playwright. It is a
 * test fixture and is never bundled into the extension.
 */

import { derive, type DerivationResult } from '@/documents/derive';
import { harvest } from '@/content/harvester';
import {
  engage,
  installSubmitGuard,
  guardState,
  setToastHandler,
  arm,
  __resetGuardForTests,
  openUploadWindowWithApproval,
  pressUploadInWindowWithApproval,
} from '@/content/submit-guard';
import { runFill, type PlannedWrite } from '@/content/fill-run';
import { parseConstraint } from '@/documents/constraints';
import { createRasterBackend } from '@/documents/raster';
import { RunController } from '@/content/run-controller';
import { describeElement } from '@/content/picker';
import { buildTaughtProfile, profileHealth } from '@/matching/teach';
import { locateBySelector } from '@/matching/profile-cache';
import { primaryBlocker, detectBlockers } from '@/content/blockers';
import { readValue, resolveRanked } from '@/content/reverify';
import { applyEdit, collectValues, focusField } from '@/content/review-bridge';
import { setRunStorage, type RunStorage } from '@/runtime/persistence';
import type { FillPlan, PlannedField, SiteProfile } from '@/shared/types';
import type { FieldKey } from '@/matching/taxonomy';
import { isVisible } from '@/content/harvester';
import { undoFill } from '@/content/fill-run';
import type { FieldSnapshot } from '@/content/filler';
import { findUploadButton, findUploadSlots } from '@/content/upload-slots';
import { placeFileInWindow, probeUploadWindow, questionShowsFile } from '@/content/upload-window';
import { pressUpload } from '@/content/upload-press';
import { pdfLock } from '@/documents/pdf-lock';
import { readPdfText } from '@/documents/pdf-text';
import { extractFromText } from '@/documents/extract';
import { constraintForField, fileNameFor } from '@/documents/field-constraint';
import { bandOf, matchForm } from '@/matching/deterministic';
import { isDocumentKey, isFieldKey } from '@/matching/taxonomy';
import { base64ToBytes, bytesToBase64 } from '@/shared/base64';
import { runUploadBatch, type BatchPorts, type BatchSlot } from '@/background/upload-batch';

import type { HarnessResult } from './harness.d';

async function run(url: string, sourceMime: string, constraintText: string): Promise<HarnessResult> {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const { constraint } = parseConstraint(constraintText);
  const result: DerivationResult = await derive(
    createRasterBackend(),
    bytes,
    sourceMime,
    constraint,
  );

  if (!result.ok) {
    return { ok: false, reason: result.reason, code: result.code };
  }
  return {
    ok: true,
    mime: result.mime,
    bytes: result.bytes.length,
    width: result.width,
    height: result.height,
    ...(result.quality === undefined ? {} : { quality: result.quality }),
    fit: result.fit,
    warnings: result.warnings.map((w) => w.code),
    attempts: result.attempts.length,
    magic: Array.from(result.bytes.slice(0, 8)),
  };
}

/**
 * Harvest the *current* page in a real browser.
 *
 * jsdom has no layout engine, so the unit suite cannot test visibility, and its
 * iframes are not really cross-origin. Both are only real here.
 */
function runHarvest() {
  const { fields, blockers, wizard, labelSources } = harvest(document);
  const visible = fields.filter((f) => f.visible);
  return {
    fields: fields.map((f) => ({
      ref: f.ref,
      tag: f.tag,
      labelText: f.labelText,
      nearbyText: f.nearbyText,
      visible: f.visible,
      enabled: f.enabled,
      required: f.required,
      selectors: f.selectors,
      optionCount: f.options?.length ?? 0,
      source: labelSources.get(f.ref) ?? 'none',
    })),
    blockers: blockers.map((b) => ({ type: b.type, reason: b.reason })),
    wizard,
    visibleCount: visible.length,
    labelledCount: visible.filter((f) => f.labelText.trim() !== '').length,
    domUnchanged: document.body.innerHTML,
  };
}

/**
 * Install the submit guard and drive a fill, exactly as the content script
 * does. Exposed so Playwright can exercise the real P2 enforcement against the
 * hostile fixture — jsdom cannot model a page that navigates.
 */
const toasts: string[] = [];

/**
 * The guard as it stands on a page carrying a fill.
 *
 * Engaged, because that is the page every adversarial guard spec is about: a
 * portal holding the extension's values and trying to send them unapproved.
 * The real content script engages at its first write; a page it has not
 * written to leaves the guard dormant, and that half is proved against the
 * shipped bundle in `extension.spec.ts`.
 */
function installGuard() {
  __resetGuardForTests();
  toasts.length = 0;
  setToastHandler((message) => toasts.push(message));
  installSubmitGuard(document);
  engage();
  return { installed: true };
}

async function fill(writes: PlannedWrite[]) {
  const result = await runFill(writes, {
    resolve: (ref) => document.getElementById(ref),
    delay: () => new Promise((r) => setTimeout(r, 5)),
  });
  return {
    records: result.records.map((r) => ({
      ref: r.ref,
      ok: r.ok,
      strategy: r.strategy ?? '',
      truncated: Boolean(r.truncated),
      fuzzy: Boolean(r.fuzzy),
      attempts: r.attempts,
    })),
    aborted: result.aborted,
  };
}

function guardReport() {
  return {
    blocked: guardState().blocked,
    armed: guardState().armed !== null,
    toasts: [...toasts],
    submitAttempts: (window as unknown as { __submitAttempts?: number }).__submitAttempts ?? 0,
    submitEventsSeen: (window as unknown as { __submitEventsSeen?: number }).__submitEventsSeen ?? 0,
  };
}

// ---------------------------------------------------------------------------
// § Phase 6 — pause, resume, drift recovery
// ---------------------------------------------------------------------------

/**
 * Run storage backed by `sessionStorage`.
 *
 * `chrome.storage.session` does not exist on a plain page, and a Map would not
 * survive the reload — which is the one thing the rehydration test needs it to
 * do. `sessionStorage` has both properties: same tab, across reloads, gone
 * when the tab closes.
 */
const sessionArea: RunStorage = {
  get(keys) {
    const all: Record<string, unknown> = {};
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      if (key === null) continue;
      try {
        all[key] = JSON.parse(sessionStorage.getItem(key) ?? 'null');
      } catch {
        /* not ours */
      }
    }
    if (keys === null) return Promise.resolve(all);
    const wanted = Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const key of wanted) if (key in all) out[key] = all[key];
    return Promise.resolve(out);
  },
  set(items) {
    for (const [key, value] of Object.entries(items)) {
      sessionStorage.setItem(key, JSON.stringify(value));
    }
    return Promise.resolve();
  },
  remove(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) sessionStorage.removeItem(key);
    return Promise.resolve();
  },
};

setRunStorage(sessionArea);

/**
 * The harness stands in for the background worker.
 *
 * It holds the values the run was started with and re-sends them when the
 * controller asks — which is exactly the worker's `refillTab` contract, minus
 * the vault and the authorisation checks (both unit-tested separately). What
 * is *real* here is everything on the page side: the reducer, the persistence,
 * the observer, the blocker detection, and the re-verification pass.
 */
let plannedValues = new Map<string, string>();
let controller: RunController | null = null;
let planned: FillPlan | null = null;
const events: string[] = [];

/**
 * Resolve through the *controller's* plan when there is one.
 *
 * After a reload the plan comes back from storage before the harness has
 * rebuilt anything, and re-verification resolves fields during `attach()` —
 * so the persisted selectors have to be the ones used. That is also the
 * stronger test: those selectors were captured under element ids that no
 * longer exist.
 */
function activePlan(): FillPlan | null {
  return controller?.plan ?? planned;
}

function resolveRef(ref: string): Element | null {
  const field = activePlan()?.fields.find((f) => f.fieldRef === ref);
  if (!field) return null;
  return resolveRanked(field.selectors, document)?.el ?? null;
}

/**
 * The values the worker would hold.
 *
 * Kept in `sessionStorage` rather than a module variable because a reload
 * destroys module state — and the real holder of these values, the background
 * worker, is not destroyed by a page reload either.
 */
const VALUE_KEY = 'harness:values';

function loadPlannedValues(): Map<string, string> {
  if (plannedValues.size > 0) return plannedValues;
  try {
    const raw = sessionStorage.getItem(VALUE_KEY);
    plannedValues = new Map(Object.entries(raw === null ? {} : (JSON.parse(raw) as Record<string, string>)));
  } catch {
    plannedValues = new Map();
  }
  return plannedValues;
}

function savePlannedValues(): void {
  sessionStorage.setItem(VALUE_KEY, JSON.stringify(Object.fromEntries(plannedValues)));
}

function writesFor(refs: readonly string[]): PlannedWrite[] {
  const values = loadPlannedValues();
  const plan = activePlan();
  const writes: PlannedWrite[] = [];
  for (const ref of refs) {
    const value = values.get(ref);
    const field = plan?.fields.find((f) => f.fieldRef === ref);
    if (value === undefined || !field) continue;
    writes.push({ ref, key: field.key, value });
  }
  return writes;
}

async function applyWrites(writes: PlannedWrite[]): Promise<number> {
  const result = await runFill(writes, {
    resolve: resolveRef,
    delay: () => new Promise((r) => setTimeout(r, 5)),
  });
  controller?.remember(writes.map((w) => w.ref));
  return result.records.filter((r) => r.ok).length;
}

/** The worker's half of a refill, as the controller sees it. */
async function refillPort(refs: string[]): Promise<{ ok: boolean; error?: string }> {
  events.push(`refill:${refs.join(',')}`);
  await applyWrites(writesFor(refs));
  await controller?.toReview();
  return { ok: true };
}

function ensureController(): RunController {
  controller ??= new RunController({
    tabId: 1,
    doc: document,
    reloaded: true,
    resolve: resolveRef,
    requestRefill: refillPort,
    onState: (state) => events.push(`state:${state.t}`),
    onPause: (finding) => events.push(`pause:${finding.type}`),
    onResume: () => events.push('resume'),
  });
  return controller;
}

/**
 * Build a plan from the fixture's own `data-af` markers and start a run.
 *
 * The mapping is given by the test rather than inferred by the matcher: this
 * spec is about Phase 6's resume behaviour, and letting Phase 4 decide the
 * keys would make a matching regression look like a resume flake.
 */
async function runStart(values: Record<string, string>): Promise<string> {
  const harvested = harvest(document);
  const fields: PlannedField[] = [];
  plannedValues = new Map();

  for (const [name, value] of Object.entries(values)) {
    const descriptor = harvested.fields.find((field) => {
      const el = harvested.elements.get(field.ref);
      return el?.getAttribute('name') === name;
    });
    if (!descriptor) continue;
    fields.push({
      fieldRef: name,
      key: `fixture.${name}` as FieldKey,
      selectors: descriptor.selectors,
      confidence: 0.95,
      source: 'rule',
    });
    plannedValues.set(name, value);
  }
  savePlannedValues();

  planned = {
    siteId: 'postback-portal',
    profileVersion: null,
    formFingerprint: 'fixture-postback-step-2',
    tabId: 1,
    fields,
    documents: [],
    submit: { selectors: ['#btnFinalSubmit'], label: 'Final Submit' },
    createdAt: Date.now(),
  };

  const run = ensureController();
  await run.attach(planned.formFingerprint);
  await run.setPlan(planned);

  if (!(await run.beginFill())) return run.state.t;

  await applyWrites(writesFor(fields.map((f) => f.fieldRef)));

  if (!(await run.checkBlockers())) await run.toReview();
  return run.state.t;
}

/**
 * Resume an existing run in a freshly loaded document.
 *
 * Nothing is rebuilt from the page. The plan — refs, selectors, confidences —
 * comes back out of `chrome.storage.session`'s stand-in, which is the whole
 * claim §5 makes about persistence. The selectors in it were recorded against
 * element ids the reload has already destroyed, so this only works if the
 * ranked fallbacks do.
 */
async function runResumeAfterReload(): Promise<string> {
  loadPlannedValues();
  controller?.detach();
  controller = null;
  planned = null;

  const run = ensureController();
  await run.attach('fixture-postback-step-2');
  planned = run.plan;
  return run.state.t;
}

function currentValues(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const el of document.querySelectorAll('[data-af]')) {
    const name = el.getAttribute('name');
    if (name) out[name] = readValue(el);
  }
  return out;
}

/**
 * § Phase 7 — the review screen's page-side operations.
 *
 * Only real in a browser: jsdom has no layout, so it cannot say whether the
 * highlight actually lands on top of the field it is pointing at.
 */
const reviewHarness = {
  collect: (refs: string[]) => collectValues(refs, (ref) => document.getElementById(ref)),
  focus(ref: string) {
    const el = document.getElementById(ref);
    if (!el) return null;
    focusField(el, document);
    const marker = document.getElementById('autofill-assistant-highlight');
    if (!marker) return null;
    const a = marker.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    return {
      marker: { top: a.top, left: a.left, width: a.width, height: a.height },
      field: { top: b.top, left: b.left, width: b.width, height: b.height },
      focused: document.activeElement === el,
      fieldHtml: el.outerHTML,
    };
  },
  async edit(ref: string, value: string) {
    const el = document.getElementById(ref);
    if (!el) return { ok: false, value: '' };
    return applyEdit(el, value);
  },
};

window.__review = reviewHarness;
window.__derive = run;
window.__harvest = runHarvest;
window.__installGuard = installGuard;
window.__fill = fill;
window.__guardReport = guardReport;
window.__arm = (token) => {
  arm(token);
};
// ---------------------------------------------------------------------------
// § Phase 9 — teach mode and profile repair
// ---------------------------------------------------------------------------

/**
 * The drift-and-repair cycle, driven from a spec.
 *
 * Real modules throughout: the real picker's `describeElement`, the real
 * `profileHealth`, the real `buildTaughtProfile` with its measured `survives`
 * probe, and the real `locateBySelector` the extension matches with. What the
 * harness supplies is only the "user" — which field they point at, and what
 * they say it is.
 */
const PROFILE_KEY = 'harness:profile';

function loadProfile(): SiteProfile | null {
  try {
    const raw = sessionStorage.getItem(PROFILE_KEY);
    return raw === null ? null : (JSON.parse(raw) as SiteProfile);
  } catch {
    return null;
  }
}

function storeProfile(profile: SiteProfile): void {
  sessionStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

/** Resolve a profile's selectors against what is on the page right now. */
function resolvesNow(selectors: string[]): boolean {
  return locateBySelector(selectors, harvest(document).fields) !== null;
}

/**
 * Record a profile using *only* the current element ids.
 *
 * Stands in for a profile captured before a portal redesign: id-only, and
 * therefore about to break. Nothing in the extension records profiles this
 * badly — that is the point, and the repair path is what is under test.
 */
function recordIdOnlyProfile(mapping: Record<string, string>): SiteProfile {
  const result = harvest(document);
  const fields: SiteProfile['fields'] = [];

  for (const [name, key] of Object.entries(mapping)) {
    const descriptor = result.fields.find((field) => {
      const el = result.elements.get(field.ref);
      return el?.getAttribute('name') === name;
    });
    const el = descriptor ? result.elements.get(descriptor.ref) : null;
    const id = el?.getAttribute('id');
    if (!id) continue;
    fields.push({ key: key as FieldKey, selectors: [`#${id}`], confidence: 1, source: 'taught' });
  }

  const profile: SiteProfile = {
    siteId: 'harness:drift',
    version: 1,
    matchUrl: `${location.origin}/*`,
    formFingerprint: 'fixture-postback-step-2',
    createdAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
    fields,
    documents: [],
    submit: { selectors: ['#btnFinalSubmit'], label: 'Final Submit' },
    blockers: [],
  };

  storeProfile(profile);
  return profile;
}

/** Point at a field by its `name`, as a user would point at it on screen. */
function pickByName(name: string) {
  const el = document.getElementsByName(name)[0];
  if (!el) return null;
  return describeElement(el, document);
}

/**
 * Teach every mapping in one pass and save a new version.
 *
 * `survives` is measured, not guessed: the page has been re-rendered since the
 * ids were recorded, so a selector that still finds its field has demonstrated
 * the property the ranking is trying to reward.
 */
function teachAndSave(mapping: Record<string, string>): SiteProfile {
  const picks = [];
  for (const [name, key] of Object.entries(mapping)) {
    const picked = pickByName(name);
    if (!picked || picked.refused) continue;
    picks.push({ ref: picked.ref ?? '', key: key as FieldKey, selectors: picked.selectors, label: picked.label });
  }

  const next = buildTaughtProfile({
    siteId: 'harness:drift',
    url: location.href,
    fingerprint: 'fixture-postback-step-2',
    picks,
    previous: loadProfile(),
    survives: (selector) => resolvesNow([selector]),
  });

  storeProfile(next);
  return next;
}

/** Fill the page from a profile, the way a profile-matched run would. */
async function fillFromProfile(values: Record<string, string>): Promise<number> {
  const profile = loadProfile();
  if (!profile) return 0;

  const result = harvest(document);
  const writes: PlannedWrite[] = [];

  for (const field of profile.fields) {
    const located = locateBySelector(field.selectors, result.fields);
    if (!located) continue;
    const value = values[field.key];
    if (value === undefined) continue;
    writes.push({ ref: located.ref, key: field.key, value });
  }

  const run = await runFill(writes, {
    resolve: (ref) => result.elements.get(ref) ?? null,
    delay: () => new Promise((r) => setTimeout(r, 2)),
  });

  return run.records.filter((record) => record.ok).length;
}

// ---------------------------------------------------------------------------
// § document attachment
// ---------------------------------------------------------------------------

/**
 * Documents into a real page, through the same code the content script runs.
 *
 * jsdom has no `DataTransfer` and no `DragEvent`, so whether a file actually
 * lands in a file box — and whether the page sees it land — can only be
 * answered here. What stands in for the worker is only where the bytes come
 * from.
 */
let documentSnapshots: FieldSnapshot[] = [];

function byRef(ref: string): Element | null {
  return document.getElementById(ref) ?? document.querySelector(`[name="${CSS.escape(ref)}"]`);
}

async function attachDocument(ref: string, base64: string, mime: string, filename: string) {
  const run = await runFill(
    [{ ref, key: 'doc', value: { bytes: base64ToBytes(base64), mime, filename } }],
    { resolve: byRef, delay: () => Promise.resolve() },
  );
  documentSnapshots.push(...run.snapshots);
  return run.records.map((r) => ({
    ref: r.ref,
    ok: r.ok,
    strategy: r.strategy ?? '',
    reason: r.reason ?? '',
  }));
}

/**
 * Fill's own document decisions, on whatever page this is (§ test portal).
 *
 * Harvest, match, the same band threshold `buildWrites` applies, the same
 * neutral file name `prepareDocuments` gives — then the content script's real
 * filler. Only the bytes are stand-ins. What comes back is which file each box
 * on the page ended up holding, which is the question a portal that refused
 * "an income certificate" in its photo box was really asking.
 */
async function fillLikeFill() {
  const result = harvest(document);
  const matches = matchForm(result.fields);

  const writes: PlannedWrite[] = [];
  for (const match of matches) {
    if (match.key === 'unknown' || bandOf(match) === 'unmapped') continue;
    if (!isFieldKey(match.key) || !isDocumentKey(match.key)) continue;
    const mime = match.key === 'doc.photo' || match.key === 'doc.signature' ? 'image/jpeg' : 'application/pdf';
    writes.push({
      ref: match.fieldRef,
      key: match.key,
      value: {
        bytes: new TextEncoder().encode(`stand-in for ${match.key}`),
        mime,
        filename: fileNameFor(match.key, mime),
      },
    });
  }

  await runFill(writes, {
    resolve: (ref) => result.elements.get(ref) ?? null,
    delay: () => Promise.resolve(),
  });

  return result.fields
    .filter((field) => field.tag === 'file')
    .map((field) => {
      const box = result.elements.get(field.ref) as HTMLInputElement | undefined;
      return { label: field.labelText, filename: box?.files?.[0]?.name ?? null };
    });
}

/** The whole path: read the box's requirement, derive the real photo to it, attach. */
async function deriveAndAttach(ref: string, url: string, sourceMime: string) {
  const el = byRef(ref);
  const result = harvest(document);
  const field = result.fields.find((f) => result.elements.get(f.ref) === el);
  const { constraint } = constraintForField({
    labelText: field?.labelText ?? '',
    ...(field?.requirementText === undefined ? {} : { requirementText: field.requirementText }),
    ...(field?.accept === undefined ? {} : { accept: field.accept }),
  });
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const derived = await derive(createRasterBackend(), bytes, sourceMime, constraint);
  if (!derived.ok) return { ok: false, reason: derived.reason, minBytes: 0, maxBytes: 0 };
  const [record] = await attachDocument(ref, bytesToBase64(derived.bytes), derived.mime, 'photo.jpg');
  return {
    ok: record?.ok ?? false,
    reason: record?.reason ?? '',
    minBytes: constraint.minBytes ?? 0,
    maxBytes: constraint.maxBytes ?? 0,
  };
}

/**
 * `chrome.scripting.executeScript`, as far as a page can play it.
 *
 * Each function runs from its own source text, evaluated inside the frame it
 * targets — so it sees that frame's `document`, and a function reaching for
 * anything outside itself breaks here as it would in the extension. Frames are
 * numbered in the order they are first seen, as Chrome numbers them, and a
 * frame that is hidden and shown again keeps its number.
 *
 * And it answers as Chrome answers: `null` — never `undefined` — for a frame
 * that could not run the function (another origin's, or one where it threw),
 * and `null` for a function that returned nothing. A real form always has such
 * frames; a harness that skipped them hid the crash that stopped every hold
 * after its first document.
 */
const frameNumbers = new WeakMap<Window, number>();
let nextFrameNumber = 1;

function allFrames(win: Window, out: { id: number; win: Window; reachable: boolean }[] = []) {
  for (const el of Array.from(win.document.querySelectorAll('iframe'))) {
    const child = el.contentWindow;
    if (!child) continue;
    if (!frameNumbers.has(child)) frameNumbers.set(child, nextFrameNumber++);
    let reachable = true;
    try {
      void child.document.body;
    } catch {
      reachable = false;
    }
    out.push({ id: frameNumbers.get(child)!, win: child, reachable });
    if (reachable) allFrames(child, out);
  }
  return out;
}

const pageInjector: BatchPorts['inject'] = async (target, func, args) => {
  const all = [{ id: 0, win: window as Window, reachable: true }, ...allFrames(window)];
  const chosen = target === 'all' ? all : all.filter((frame) => frame.id === target);
  return chosen.map(({ id, win, reachable }) => {
    if (!reachable) return { frameId: id, result: null };
    try {
      const run = (win as unknown as { eval(code: string): (...a: unknown[]) => unknown }).eval(
        `(${func.toString()})`,
      );
      return { frameId: id, result: (run(...args) ?? null) as ReturnType<typeof func> | null };
    } catch {
      return { frameId: id, result: null };
    }
  });
};

/**
 * The real batch — `upload-batch.ts`, the code the extension runs — against
 * this page. Only the document bytes and the token are stood in for.
 *
 * Recorded selectors are stripped of ids on purpose: Google's buttons have no
 * stable id, so the extension only ever has a positional path for them.
 */
let scannedSlots: ReturnType<typeof findUploadSlots>['slots'] | null = null;

async function uploadAll(keysByLabel: Record<string, string>) {
  const pdf = new Set(['doc.aadhaar_card', 'doc.pan_card', 'doc.marksheet_10']);
  // Scanned once, like the panel: a later hold works from the same scan.
  scannedSlots ??= findUploadSlots(document, isVisible).slots;
  const slots: BatchSlot[] = scannedSlots
    .filter((slot) => slot.kind === 'window')
    .map((slot) => ({
      ref: slot.ref,
      label: slot.label,
      selectors: slot.selectors.filter((selector) => !selector.startsWith('#')),
      key: (keysByLabel[slot.label] ?? null) as FieldKey | null,
      constraint: { mime: [] },
    }));
  return runUploadBatch(slots, {
    inject: pageInjector,
    variant: async (key) => ({
      ok: true,
      bytes: new TextEncoder().encode(`stand-in for ${key}`),
      mime: pdf.has(key) ? 'application/pdf' : 'image/jpeg',
      width: 0,
      height: 0,
      passedThrough: true,
    }),
    token: () => ({ value: 'e2e-approved', expiresAt: Date.now() + 90_000 }),
  });
}

async function bytesAt(url: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

window.__pdf = {
  lock: async (url, password) => pdfLock(await bytesAt(url), password),
  read: async (url, password) => {
    const { text } = await readPdfText(await bytesAt(url), password);
    return extractFromText(text, { documentKey: 'doc.aadhaar_card' }).candidates.map((c) => ({
      key: c.key,
      value: c.value,
      verified: c.verified,
    }));
  },
  raster: async (url, password) => {
    const page = await createRasterBackend().rasterisePdf(await bytesAt(url), 800, password);
    return { width: page.width, height: page.height };
  },
  derive: async (url, password, constraintText) => {
    const { constraint } = parseConstraint(constraintText);
    const result = await derive(createRasterBackend(), await bytesAt(url), 'application/pdf', constraint, {
      password,
    });
    if (!result.ok) return { ok: false, reason: result.reason };
    const opens = result.mime === 'application/pdf' ? (await pdfLock(result.bytes)) === 'open' : true;
    return { ok: true, mime: result.mime, opensWithoutPassword: opens };
  },
};

window.__documents = {
  uploadAll,
  fillLikeFill,
  attach: attachDocument,
  deriveAndAttach,
  undo: () => {
    const restored = undoFill(documentSnapshots, byRef);
    documentSnapshots = [];
    return restored;
  },
  file: (ref) => {
    const box = byRef(ref) as HTMLInputElement | null;
    const file = box?.files?.[0];
    return file ? { name: file.name, type: file.type, size: file.size } : null;
  },
  harvest: () => {
    const result = harvest(document);
    return result.fields
      .filter((f) => f.tag === 'file')
      .map((f) => ({
        id: result.elements.get(f.ref)?.id ?? '',
        name: result.elements.get(f.ref)?.getAttribute('name') ?? '',
        labelText: f.labelText,
        accept: f.accept ?? '',
        requirementText: f.requirementText ?? '',
      }));
  },
  slots: () =>
    findUploadSlots(document, isVisible).slots.map((slot) => ({
      ref: slot.ref,
      kind: slot.kind,
      label: slot.label,
      requirementText: slot.requirementText,
    })),
  uploadButton: (ref) => {
    const box = byRef(ref);
    return box ? (findUploadButton(box, document.getElementById('btnFinal'))?.button ?? null) : null;
  },
  pressUpload: (targetSelector, approvedRef) =>
    pressUpload(
      { value: 'e2e-approved', expiresAt: Date.now() + 90_000, targetSelector },
      byRef(approvedRef),
      document,
    ),
  windowFunctions: () => ({
    probe: probeUploadWindow.toString(),
    place: placeFileInWindow.toString(),
    open: openUploadWindowWithApproval.toString(),
    press: pressUploadInWindowWithApproval.toString(),
    shows: questionShowsFile.toString(),
  }),
};

window.__teach = {
  recordIdOnlyProfile,
  health: () => {
    const profile = loadProfile();
    return profile ? profileHealth(profile, resolvesNow) : null;
  },
  pick: (name: string) => pickByName(name),
  teachAndSave: (mapping: Record<string, string>) => {
    const profile = teachAndSave(mapping);
    return { version: profile.version, fields: profile.fields.length };
  },
  profileVersion: () => loadProfile()?.version ?? 0,
  selectorsFor: (key: string) =>
    loadProfile()?.fields.find((field) => field.key === key)?.selectors ?? [],
  fill: fillFromProfile,
  resetProfile: () => sessionStorage.removeItem(PROFILE_KEY),
};

window.__run = {
  start: runStart,
  resume: runResumeAfterReload,
  state: () => controller?.state.t ?? 'IDLE',
  planSize: () => controller?.plan?.fields.length ?? 0,
  blocker: () => primaryBlocker(detectBlockers(document))?.type ?? null,
  blockerCount: () => detectBlockers(document).length,
  instruction: () => controller?.blocker?.instruction ?? '',
  async continue() {
    await controller?.userContinue();
    return controller?.state.t ?? 'IDLE';
  },
  async reverify() {
    await controller?.reverifyNow();
    return controller?.state.t ?? 'IDLE';
  },
  checkPage: () => controller?.checkPageNow(),
  values: currentValues,
  events: () => [...events],
  reset: () => {
    sessionStorage.clear();
    controller?.detach();
    controller = null;
    planned = null;
    plannedValues = new Map();
    events.length = 0;
  },
};
