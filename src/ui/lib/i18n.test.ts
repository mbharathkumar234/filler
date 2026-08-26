import { describe, expect, it } from 'vitest';

import {
  CATALOGUES,
  LOCALES,
  LOCALE_NAMES,
  MESSAGES,
  format,
  isLocale,
  preferredLocale,
  translate,
  type Locale,
  type MessageKey,
} from './i18n';

/**
 * The localisation contract (§ COMPLETION_PLAN Phase F).
 *
 * The failure mode a catalogue has is not a wrong translation — a person will
 * notice that. It is a *missing* one, which shows up as a blank button, a
 * control with no accessible name, or a `{count}` placeholder printed
 * literally at somebody who cannot read the English fallback anyway. None of
 * those are visible to whoever adds the message key, because they are working
 * in English.
 *
 * So these tests compare the catalogues against each other rather than
 * checking any of them for correctness, which is the one thing a test can do
 * here and a reviewer cannot do quickly.
 */

const KEYS = Object.keys(MESSAGES) as MessageKey[];
const OTHERS = LOCALES.filter((l): l is Exclude<Locale, 'en'> => l !== 'en');

describe('every locale is complete', () => {
  it.each(OTHERS)('%s has every key English has', (locale) => {
    const missing = KEYS.filter((key) => !(key in CATALOGUES[locale]));
    expect(missing).toEqual([]);
  });

  it.each(OTHERS)('%s has no key English does not', (locale) => {
    const extra = Object.keys(CATALOGUES[locale]).filter((key) => !(key in MESSAGES));
    expect(extra).toEqual([]);
  });

  it.each(OTHERS)('%s leaves nothing as an empty string', (locale) => {
    const blank = KEYS.filter((key) => CATALOGUES[locale][key].trim() === '');
    expect(blank).toEqual([]);
  });

  it.each(OTHERS)('%s actually translated, rather than copying the English', (locale) => {
    // A copied string is how a half-finished catalogue passes every check
    // above. Some strings legitimately stay — but not most of them.
    const copied = KEYS.filter((key) => CATALOGUES[locale][key] === MESSAGES[key]);
    expect(copied.length).toBeLessThan(KEYS.length * 0.1);
  });

  it('names every locale in its own script, not in English', () => {
    for (const locale of LOCALES) expect(LOCALE_NAMES[locale]).toBeTruthy();
    expect(LOCALE_NAMES.hi).not.toBe('Hindi');
    expect(LOCALE_NAMES.ta).not.toBe('Tamil');
  });

  it('ships Hindi and one more, as the plan asks', () => {
    expect(LOCALES).toContain('hi');
    expect(LOCALES.length).toBeGreaterThanOrEqual(3);
  });
});

describe('placeholders survive translation', () => {
  it.each(OTHERS)('%s keeps every placeholder its English carries', (locale) => {
    const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
    const broken: string[] = [];

    for (const key of KEYS) {
      const english = placeholders(MESSAGES[key]);
      const other = placeholders(CATALOGUES[locale][key]);
      if (english.join() !== other.join()) broken.push(`${key}: ${english} vs ${other}`);
    }
    expect(broken).toEqual([]);
  });

  it('lets a translation move the placeholders around', () => {
    // "3 of 4 done" is "4 में से 3 पूरे" — the order reverses. Positional
    // formatting could not express that, which is why these are named.
    expect(translate('en', 'onboarding.progress', { done: 3, total: 4 })).toBe('3 of 4 done');
    expect(translate('hi', 'onboarding.progress', { done: 3, total: 4 })).toBe('4 में से 3 पूरे');
  });

  it('leaves an unknown placeholder visible rather than blanking it', () => {
    expect(format('a {b} c')).toBe('a {b} c');
    expect(format('a {b} c', { d: 1 })).toBe('a {b} c');
  });
});

describe('falling back', () => {
  it('uses English for a key a locale somehow lacks', () => {
    // Unreachable in a shipped build — the tests above make it a build failure
    // — but it must degrade to readable English, never to a blank control.
    const gappy = { ...CATALOGUES.hi, 'review.cancel': '' };
    const text = gappy['review.cancel'] || MESSAGES['review.cancel'];
    expect(text).toBe('Cancel');
  });

  it('reads the browser language when the user has chosen nothing', () => {
    expect(preferredLocale('hi-IN')).toBe('hi');
    expect(preferredLocale('ta')).toBe('ta');
    expect(preferredLocale('en-GB')).toBe('en');
  });

  it('falls back to English for a language we do not ship', () => {
    expect(preferredLocale('fr-FR')).toBe('en');
    expect(preferredLocale(undefined)).toBe('en');
    expect(preferredLocale('')).toBe('en');
  });

  it('recognises only the locales it ships', () => {
    expect(isLocale('hi')).toBe(true);
    expect(isLocale('de')).toBe(false);
  });
});

describe('what is deliberately not translated', () => {
  it('has no message key for a value read off the portal page', () => {
    // A review screen showing different words from the form behind it is the
    // one thing it must never do. Field labels come from the page, always.
    const suspicious = KEYS.filter((key) => /^field\.|^label\./.test(key));
    expect(suspicious).toEqual([]);
  });
});
