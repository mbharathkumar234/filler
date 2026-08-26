/**
 * What "set up" actually means, as a function of stored state (§ Phase F).
 *
 *   "Onboarding: vault creation → guided profile entry → document upload with
 *    quality checks → first supervised fill on a demo fixture."
 *
 * The whole design decision in this file is that a step is complete when the
 * *thing* is true, never when the user clicked Next. A wizard that advances on
 * a click will happily tell somebody they are ready to fill government forms
 * when their vault is empty, and the first they hear otherwise is a blank
 * application. So each step asks the vault, the document store, or the audit
 * log, and answers from that.
 *
 * It also means the checklist is correct for somebody who never saw it — a
 * user who set everything up before this shipped opens the panel already done.
 *
 * Kept free of React so the rules can be tested without rendering anything.
 */

import type { FieldKey } from '@/matching/taxonomy';
import type { MessageKey } from '@/ui/lib/i18n';

/**
 * The details essentially every Indian portal asks for.
 *
 * Deliberately not "the whole taxonomy": that is ~60 keys covering bank,
 * education, family and four kinds of address, and nobody fills all of it. A
 * completeness meter over the whole set reads ~15% for a perfectly usable
 * vault, which teaches people to ignore the meter.
 *
 * This is the shortest list that makes the first fill work. It lives here
 * rather than in `taxonomy.ts` because it is an onboarding judgement about
 * what to ask for first, not a fact about the taxonomy — and the taxonomy is
 * append-only, so opinions do not belong in it.
 */
export const CORE_KEYS: readonly FieldKey[] = [
  'identity.full_name',
  'identity.dob',
  'identity.gender',
  'contact.email',
  'contact.mobile',
  'address.permanent.line1',
  'address.permanent.state',
  'address.permanent.pincode',
];

/** Enough of the core to attempt a real form. */
export const CORE_THRESHOLD = 6;

export type StepId = 'vault' | 'profile' | 'documents' | 'first-fill';

export interface StepState {
  id: StepId;
  /**
   * Message keys rather than words (§ Phase F localisation).
   *
   * These rules decide *what* is outstanding; the panel decides what language
   * to say it in. Keeping English literals here would put half the checklist's
   * copy outside the catalogue, where the completeness tests cannot see it.
   */
  titleKey: MessageKey;
  /** What the user gets out of it — not what the software does. */
  detailKey: MessageKey;
  done: boolean;
  /** Progress within the step, when it has any. */
  progress?: { at: number; of: number };
}

export interface SetupFacts {
  /** A vault exists and is open. */
  vaultReady: boolean;
  /** Which of `CORE_KEYS` currently hold a value. */
  filledCoreKeys: readonly string[];
  /** Documents that passed their quality checks on upload. */
  usableDocuments: number;
  /** Documents stored but flagged as too poor to derive from. */
  unusableDocuments: number;
  /** Has a run ever reached the review screen? */
  hasReviewedFill: boolean;
}

export function stepsFor(facts: SetupFacts): StepState[] {
  const core = facts.filledCoreKeys.filter((key) =>
    (CORE_KEYS as readonly string[]).includes(key),
  ).length;

  return [
    {
      id: 'vault',
      titleKey: 'step.vault.title',
      detailKey: 'step.vault.detail',
      done: facts.vaultReady,
    },
    {
      id: 'profile',
      titleKey: 'step.profile.title',
      detailKey: 'step.profile.detail',
      done: core >= CORE_THRESHOLD,
      progress: { at: core, of: CORE_KEYS.length },
    },
    {
      id: 'documents',
      titleKey: 'step.documents.title',
      detailKey: 'step.documents.detail',
      done: facts.usableDocuments > 0,
      progress: { at: facts.usableDocuments, of: 2 },
    },
    {
      id: 'first-fill',
      titleKey: 'step.firstFill.title',
      detailKey: 'step.firstFill.detail',
      done: facts.hasReviewedFill,
    },
  ];
}

/**
 * Should the checklist be on screen?
 *
 * Not once everything is done — a permanent checklist of completed things is
 * clutter. Dismissing is separate and remembered, so somebody who wants it
 * gone before finishing can have that; the panel keeps a way back to it.
 */
export function shouldShowChecklist(steps: readonly StepState[], dismissed: boolean): boolean {
  return !dismissed && steps.some((step) => !step.done);
}

/** The step to point at: the first unfinished one. */
export function currentStep(steps: readonly StepState[]): StepState | undefined {
  return steps.find((step) => !step.done);
}
