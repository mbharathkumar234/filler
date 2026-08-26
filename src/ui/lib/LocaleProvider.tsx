/**
 * Locale context for the panel (§ Phase F).
 *
 * A provider rather than a module-level global, so a test can render one screen
 * in Tamil without leaking that choice into the next test — and so switching
 * language re-renders the panel instead of needing a reload.
 *
 * The chosen locale lives in `chrome.storage.local`, not in the vault: it is
 * not personal data, and a locked vault must still show a readable unlock
 * screen. Reading it is a promise, so the first paint uses the browser's UI
 * language and is corrected once storage answers. That flicker is deliberate —
 * the alternative is a blank panel until storage resolves, and a blank panel
 * is worse than one that briefly guesses English.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import {
  isLocale,
  preferredLocale,
  translate,
  type Locale,
  type MessageKey,
} from './i18n';

const STORAGE_KEY = 'ui:locale';

export type Translate = (key: MessageKey, vars?: Readonly<Record<string, string | number>>) => string;

interface LocaleContextValue {
  locale: Locale;
  t: Translate;
  setLocale: (locale: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

function browserLocale(): Locale {
  try {
    return preferredLocale(chrome.i18n?.getUILanguage?.());
  } catch {
    return 'en';
  }
}

export function LocaleProvider({ children, initial }: { children: ReactNode; initial?: Locale }) {
  const [locale, setLocaleState] = useState<Locale>(initial ?? browserLocale());

  useEffect(() => {
    if (initial !== undefined) return; // A test or a caller has pinned it.
    void chrome.storage?.local
      ?.get(STORAGE_KEY)
      .then((items) => {
        const stored = items[STORAGE_KEY];
        if (typeof stored === 'string' && isLocale(stored)) setLocaleState(stored);
      })
      .catch(() => {});
  }, [initial]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    void chrome.storage?.local?.set({ [STORAGE_KEY]: next }).catch(() => {});
  }, []);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key, vars) => translate(locale, key, vars),
    }),
    [locale, setLocale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/**
 * Read the current locale and translator.
 *
 * Works outside a provider, in English. A component rendered in a test without
 * the provider wrapped around it should show its words, not throw — the cost of
 * a strict version is that every existing test grows a wrapper for no benefit.
 */
export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext);
  return (
    context ?? {
      locale: 'en',
      setLocale: () => {},
      t: (key, vars) => translate('en', key, vars),
    }
  );
}

/** Just the translator, which is what most components want. */
export function useT(): Translate {
  return useLocale().t;
}
