/**
 * Fill-run orchestration (§ Phase 5).
 *
 * Walks a plan field by field, writing values and verifying each one. Three
 * things here are policy rather than mechanism, and each is deliberate:
 *
 *  1. **Sequential, with a small randomised gap.** The plan is explicit that
 *     this is for *dependent-dropdown correctness and not tripping naive rate
 *     heuristics* — not for deception. Selecting a State repopulates District
 *     via XHR; writing both in the same tick fills District before its options
 *     exist. The gap is what makes cascading selects work at all.
 *  2. **Retry once, then flag.** A field that refuses a value twice is a field
 *     the review screen must show as `fillFailed`. Retrying forever hides a
 *     real problem behind a hang.
 *  3. **Snapshot before writing.** Undo has to be able to put the page back
 *     exactly as it was, including fields the user had already filled.
 */

import { fillElement, restore, snapshot, type FieldSnapshot, type FillOutcome, type FileValue } from './filler';

/** §Phase 5: "a small randomised inter-field delay (60–200 ms)". */
export const MIN_DELAY_MS = 60;
export const MAX_DELAY_MS = 200;

/** How long to wait for a dependent select to repopulate before giving up. */
export const DEPENDENT_TIMEOUT_MS = 3000;

export interface PlannedWrite {
  ref: string;
  /** For diagnostics and the review screen. */
  key: string;
  value: string | FileValue;
  /** True when this field's options are populated by an earlier field. */
  dependent?: boolean;
}

export interface WriteRecord {
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

export interface RunHooks {
  /** Resolve a plan ref to a live element. */
  resolve(ref: string): Element | null;
  /** Called after every field, for the in-page status pill. */
  onProgress?(done: number, total: number): void;
  /** Returns true when the user has asked to stop. */
  aborted?(): boolean;
  /** Injectable for tests; real runs use a randomised delay. */
  delay?(ms: number): Promise<void>;
}

export interface RunResult {
  records: WriteRecord[];
  snapshots: FieldSnapshot[];
  aborted: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function interFieldDelay(): number {
  return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1));
}

/**
 * Wait for a select to gain real options.
 *
 * A dependent select starts with just a placeholder and is repopulated after
 * its parent changes. Filling before that lands writes into an empty list and
 * silently does nothing, which is exactly the failure the review screen would
 * then have to catch instead.
 */
export async function waitForOptions(
  el: Element,
  timeoutMs = DEPENDENT_TIMEOUT_MS,
  delay: (ms: number) => Promise<void> = sleep,
): Promise<boolean> {
  if (el.tagName.toLowerCase() !== 'select') return true;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const options = [...(el as HTMLSelectElement).options];
    const real = options.filter((option) => option.value !== '');
    if (real.length > 0) return true;
    await delay(50);
  }
  return false;
}

/**
 * Detect selects whose options are populated by an earlier selection.
 *
 * Heuristic and deliberately conservative: a select that currently holds only a
 * placeholder, on a page that has another select before it. Getting this wrong
 * costs a short wait; not detecting it costs a silently unfilled field.
 */
export function findDependentSelects(doc: Document): Set<string> {
  const dependent = new Set<string>();
  const selects = [...doc.querySelectorAll('select')];

  selects.forEach((select, index) => {
    if (index === 0) return;
    const real = [...select.options].filter((option) => option.value !== '');
    if (real.length === 0) {
      const id = select.getAttribute('id') ?? select.getAttribute('name');
      if (id) dependent.add(id);
    }
  });

  return dependent;
}

/**
 * Execute a fill plan.
 *
 * Never submits, never clicks anything. The only element this touches is a
 * field it was told to fill.
 */
export async function runFill(
  writes: readonly PlannedWrite[],
  hooks: RunHooks,
): Promise<RunResult> {
  const delay = hooks.delay ?? sleep;
  const records: WriteRecord[] = [];
  const snapshots: FieldSnapshot[] = [];

  for (const [index, write] of writes.entries()) {
    if (hooks.aborted?.()) {
      return { records, snapshots, aborted: true };
    }

    const el = hooks.resolve(write.ref);
    if (!el) {
      records.push({
        ref: write.ref,
        key: write.key,
        ok: false,
        fillFailed: true,
        reason: 'this field is no longer on the page',
        attempts: 0,
      });
      continue;
    }

    snapshots.push(snapshot(write.ref, el));

    if (write.dependent) {
      const ready = await waitForOptions(el, DEPENDENT_TIMEOUT_MS, delay);
      if (!ready) {
        records.push({
          ref: write.ref,
          key: write.key,
          ok: false,
          fillFailed: true,
          reason: 'the dropdown never loaded its options',
          attempts: 0,
        });
        continue;
      }
    }

    let outcome: FillOutcome = fillElement(el, write.value);
    let attempts = 1;

    // Retry exactly once. A second failure is a real problem, not a race.
    if (!outcome.ok) {
      await delay(interFieldDelay());
      outcome = fillElement(el, write.value);
      attempts = 2;
    }

    records.push({
      ref: write.ref,
      key: write.key,
      ok: outcome.ok,
      ...(outcome.strategy ? { strategy: outcome.strategy } : {}),
      ...(outcome.truncated ? { truncated: true } : {}),
      ...(outcome.fuzzy ? { fuzzy: true } : {}),
      ...(outcome.ok ? {} : { fillFailed: true }),
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      attempts,
    });

    hooks.onProgress?.(index + 1, writes.length);

    if (index < writes.length - 1) {
      await delay(interFieldDelay());
    }
  }

  return { records, snapshots, aborted: false };
}

/** Put every touched field back the way it was (§Phase 5 Should: Undo). */
export function undoFill(
  snapshots: readonly FieldSnapshot[],
  resolve: (ref: string) => Element | null,
): number {
  let restored = 0;
  for (const snap of snapshots) {
    const el = resolve(snap.ref);
    if (!el) continue;
    restore(el, snap);
    restored += 1;
  }
  return restored;
}
