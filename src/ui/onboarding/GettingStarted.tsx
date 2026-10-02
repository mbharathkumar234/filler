/**
 * The first-run checklist (§ Phase F).
 *
 *   "Onboarding: vault creation → guided profile entry → document upload with
 *    quality checks → first supervised fill on a demo fixture."
 *
 * A checklist rather than a wizard, for one reason: a wizard owns the screen
 * and people abandon it halfway, and there is no good answer to what a
 * half-finished wizard should do the next time you open the panel. This sits
 * above the normal panel, which stays usable throughout, and every step reads
 * its own completion out of stored state (`steps.ts`). Somebody who wanders
 * off and fills three details by hand comes back to a checklist that already
 * knows.
 *
 * It disappears on its own when everything is done. There is no congratulation
 * screen.
 */

import { useCallback, useEffect, useState } from 'react';

import { send } from '@/ui/lib/client';
import { useT, type Translate } from '@/ui/lib/LocaleProvider';
import { isUsable } from '@/documents/intake';
import { hasSkippedPath } from '@/ui/lib/path-skip';
import { CORE_KEYS, currentStep, shouldShowChecklist, stepsFor, type SetupFacts, type StepState } from './steps';

const DISMISS_KEY = 'onboarding:dismissed';

/** Where the practice form lives inside the bundle. See `vite.config.ts`. */
export const PRACTICE_PATH = 'practice/first-fill.html';

export function openPracticeForm(): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL(PRACTICE_PATH) });
}

/**
 * Ask the background worker what is actually set up.
 *
 * Every question here is one the user could answer by looking; none of it is
 * a flag this component wrote earlier.
 */
export async function readSetupFacts(): Promise<SetupFacts> {
  const [status, fields, documents, audit, path, skippedPath] = await Promise.all([
    send({ type: 'vault:status' }),
    send({ type: 'vault:list' }).catch(() => []),
    send({ type: 'doc:list' }).catch(() => []),
    send({ type: 'audit:read', limit: 200 }).catch(() => []),
    send({ type: 'vault:path' }).catch(() => null),
    hasSkippedPath(),
  ]);

  const usable = documents.filter((doc) => isUsable(doc.meta));

  return {
    vaultReady: status.exists && status.unlocked,
    filledCoreKeys: fields.map((f) => f.key),
    usableDocuments: usable.length,
    unusableDocuments: documents.length - usable.length,
    // Reaching review is the milestone, not approving. Somebody who fills the
    // practice form, reads the review screen and closes it has learnt the
    // thing this step exists to teach.
    hasReviewedFill: audit.some((entry) => entry.event.t === 'fill.completed'),
    pathAnswered: path !== null || skippedPath,
  };
}

export function GettingStarted({ onOpenVault }: { onOpenVault?: () => void }) {
  const t = useT();
  const [steps, setSteps] = useState<StepState[] | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const refresh = useCallback(async () => {
    setSteps(stepsFor(await readSetupFacts()));
  }, []);

  useEffect(() => {
    void chrome.storage.local
      .get(DISMISS_KEY)
      .then((items) => setDismissed(items[DISMISS_KEY] === true))
      .catch(() => {});
    void refresh();
  }, [refresh]);

  // The panel is where people come back after doing one of these elsewhere.
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  if (steps === null || !shouldShowChecklist(steps, dismissed)) return null;

  const next = currentStep(steps);
  const done = steps.filter((s) => s.done).length;

  const dismiss = () => {
    setDismissed(true);
    void chrome.storage.local.set({ [DISMISS_KEY]: true }).catch(() => {});
  };

  return (
    <section aria-labelledby="gs-heading" className="border-b border-slate-200 bg-slate-50 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="gs-heading" className="text-sm font-semibold">
          {t('onboarding.heading')}
        </h2>
        <span className="text-xs text-slate-500">
          {t('onboarding.progress', { done, total: steps.length })}
        </span>
      </div>

      <ol className="mt-3 space-y-2">
        {steps.map((step) => (
          <li key={step.id} className="flex gap-2 text-xs">
            <span aria-hidden="true" className={step.done ? 'text-emerald-600' : 'text-slate-300'}>
              {step.done ? '✓' : '○'}
            </span>
            <div className="min-w-0">
              <p className={step.done ? 'font-medium text-slate-400 line-through' : 'font-medium text-slate-900'}>
                {t(step.titleKey)}
                <span className="sr-only">
                  {step.done ? t('onboarding.step.done') : t('onboarding.step.todo')}
                </span>
              </p>
              {!step.done && (
                <>
                  <p className="mt-0.5 text-slate-600">{t(step.detailKey)}</p>
                  {step.progress && step.progress.at > 0 && (
                    <p className="mt-0.5 text-slate-500">
                      {step.id === 'profile'
                        ? t('onboarding.detailsSaved', { at: step.progress.at, of: CORE_KEYS.length })
                        : t('onboarding.uploaded', { at: step.progress.at })}
                    </p>
                  )}
                </>
              )}
            </div>
          </li>
        ))}
      </ol>

      {next && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {next.id === 'first-fill' ? (
            <button
              type="button"
              onClick={openPracticeForm}
              className="rounded bg-blue-700 px-3 py-1.5 text-xs font-medium text-white"
            >
              {t('onboarding.openPractice')}
            </button>
          ) : next.id === 'vault' ? null : (
            <button
              type="button"
              onClick={onOpenVault}
              className="rounded bg-blue-700 px-3 py-1.5 text-xs font-medium text-white"
            >
              {next.id === 'documents' ? t('onboarding.uploadPhoto') : t('onboarding.addDetails')}
            </button>
          )}
          <button type="button" onClick={dismiss} className="text-xs text-slate-500 underline">
            {t('onboarding.hide')}
          </button>
        </div>
      )}

      {steps.find((s) => s.id === 'documents')?.done === false && <UnusableNotice t={t} />}
    </section>
  );
}

/**
 * Named separately because it is the one message here that is not encouragement.
 * A stored-but-unusable document looks like progress in every other view.
 */
function UnusableNotice({ t }: { t: Translate }) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    void readSetupFacts().then((facts) => setCount(facts.unusableDocuments));
  }, []);

  if (count === 0) return null;

  return (
    <p role="status" className="mt-3 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
      {count === 1 ? t('onboarding.unusable.one') : t('onboarding.unusable.many', { count })}
    </p>
  );
}
