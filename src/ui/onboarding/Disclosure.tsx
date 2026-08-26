/**
 * In-product disclosure (§ Phase 10 Must).
 *
 *   "Clear in-product disclosure: what the extension does, what leaves the
 *    device, what the user is responsible for verifying, and that they remain
 *    responsible for the accuracy of anything submitted."
 *
 * Shown once before the vault is created, and reachable from the panel
 * afterwards. It is deliberately not a wall of legal text with an "I agree" —
 * that trains people to click past exactly the sentences that matter. Four
 * short sections, the last of which is the one nobody can be allowed to miss.
 *
 * The wording here and in `docs/PRIVACY.md` must not drift apart. If the
 * behaviour changes, both change.
 */

import { useT } from '@/ui/lib/LocaleProvider';

const SEEN_KEY = 'disclosure:seen';

export function hasSeenDisclosure(): Promise<boolean> {
  return chrome.storage.local
    .get(SEEN_KEY)
    .then((items) => items[SEEN_KEY] === true)
    .catch(() => false);
}

export function markDisclosureSeen(): Promise<void> {
  return chrome.storage.local.set({ [SEEN_KEY]: true }).catch(() => {});
}

export function Disclosure({ onAccept }: { onAccept?: () => void }) {
  const t = useT();

  return (
    <section className="p-4 text-slate-900">
      <h2 className="text-base font-semibold">{t('disclosure.heading')}</h2>

      <div className="mt-3 space-y-3 text-xs leading-relaxed">
        <div>
          <h3 className="text-sm font-medium">{t('disclosure.what.heading')}</h3>
          <p className="mt-0.5 text-slate-700">{t('disclosure.what.body')}</p>
        </div>

        <div>
          <h3 className="text-sm font-medium">{t('disclosure.leaves.heading')}</h3>
          <p className="mt-0.5 text-slate-700">{t('disclosure.leaves.body')}</p>
        </div>

        <div>
          <h3 className="text-sm font-medium">{t('disclosure.wont.heading')}</h3>
          <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-slate-700">
            <li>{t('disclosure.wont.submit')}</li>
            <li>{t('disclosure.wont.captcha')}</li>
            <li>{t('disclosure.wont.sign')}</li>
            <li>{t('disclosure.wont.password')}</li>
          </ul>
          <p className="mt-0.5 text-slate-700">{t('disclosure.wont.body')}</p>
        </div>

        <div className="rounded border border-amber-300 bg-amber-50 p-2">
          <h3 className="text-sm font-medium text-amber-900">
            {t('disclosure.responsible.heading')}
          </h3>
          <p className="mt-0.5 text-amber-900">
            <strong>{t('disclosure.responsible.lead')}</strong>{' '}
            {t('disclosure.responsible.body')}
          </p>
          <p className="mt-1 text-amber-900">{t('disclosure.responsible.recovery')}</p>
        </div>
      </div>

      {onAccept && (
        <button
          type="button"
          onClick={() => {
            void markDisclosureSeen().then(onAccept);
          }}
          className="mt-4 w-full rounded bg-slate-900 px-3 py-2 text-sm text-white"
        >
          {t('disclosure.accept')}
        </button>
      )}
    </section>
  );
}
