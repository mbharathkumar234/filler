/**
 * Language selector (§ Phase F).
 *
 * Placed at the top of the panel rather than inside a settings screen, because
 * somebody who cannot read the panel cannot find the settings screen. It is a
 * plain `<select>` with a real label: a flag-icon dropdown would be both
 * unlabelled and, for a country with two dozen official languages, wrong.
 *
 * Each option is written in its own script, so the choice is legible to the
 * person making it without them first understanding the current language.
 */

import { LOCALES, LOCALE_NAMES, isLocale } from './i18n';
import { useLocale } from './LocaleProvider';

export function LanguagePicker({ className }: { className?: string }) {
  const { locale, setLocale, t } = useLocale();

  return (
    <div className={className ?? 'flex items-center justify-end gap-1.5 px-4 pt-2'}>
      <label htmlFor="ui-locale" className="text-[11px] text-slate-500">
        {t('language.label')}
      </label>
      <select
        id="ui-locale"
        value={locale}
        onChange={(event) => {
          if (isLocale(event.target.value)) setLocale(event.target.value);
        }}
        className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] text-slate-700"
      >
        {LOCALES.map((option) => (
          <option key={option} value={option}>
            {LOCALE_NAMES[option]}
          </option>
        ))}
      </select>
    </div>
  );
}
