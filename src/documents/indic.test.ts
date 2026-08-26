import { describe, expect, it } from 'vitest';

import {
  INDIC_SCRIPTS,
  SCHEDULED_LANGUAGES,
  coverageOf,
  detectScripts,
  normaliseDigits,
  scriptsForLanguage,
  type IndicScript,
} from './indic';

/**
 * Scripts, not languages (§ document extraction).
 *
 * The request was "English or any of the 22 important languages of India". OCR
 * does not work on languages, it works on scripts, and the mapping is not
 * one to one in either direction: Devanagari alone carries Hindi, Marathi,
 * Konkani, Maithili, Bodo, Dogri, Sanskrit and Nepali, while Kashmiri is
 * written in two different scripts depending on who is writing it.
 *
 * So this module is the honest middle layer, and its tests are mostly about
 * *not overclaiming*: which of the 22 we can actually read, which we can only
 * read because they share a script with something better supported, and which
 * we cannot read at all. A feature that silently returns nothing for Santali is
 * worse than one that says it cannot read Santali.
 */

describe('the twenty-two, and what we can honestly do with each', () => {
  it('lists all twenty-two scheduled languages', () => {
    expect(SCHEDULED_LANGUAGES).toHaveLength(22);
  });

  it('gives every language a script and a coverage verdict', () => {
    for (const language of SCHEDULED_LANGUAGES) {
      expect(language.scripts.length, language.name).toBeGreaterThan(0);
      expect(['good', 'shared', 'none'], language.name).toContain(language.coverage);
    }
  });

  it('says plainly which three we cannot read', () => {
    // Ol Chiki and Meitei Mayek have no usable trained data, and Kashmiri's
    // Perso-Arabic orthography is not the same as the Urdu model. Claiming
    // otherwise would mean shipping a feature that returns empty and blames
    // the user's photo.
    const unreadable = SCHEDULED_LANGUAGES.filter((l) => l.coverage === 'none').map((l) => l.name);
    expect(unreadable.sort()).toEqual(['Kashmiri', 'Manipuri', 'Santali']);
  });

  it('reads most of them through Devanagari', () => {
    const devanagari = SCHEDULED_LANGUAGES.filter((l) => l.scripts.includes('Devanagari'));
    expect(devanagari.length).toBeGreaterThanOrEqual(6);
  });

  it('records the two scripts Kashmiri is actually written in', () => {
    const kashmiri = SCHEDULED_LANGUAGES.find((l) => l.name === 'Kashmiri')!;
    expect(kashmiri.scripts.length).toBeGreaterThan(1);
  });

  it('maps a language name to its scripts', () => {
    expect(scriptsForLanguage('Marathi')).toContain('Devanagari');
    expect(scriptsForLanguage('Tamil')).toContain('Tamil');
    expect(scriptsForLanguage('Not A Language')).toEqual([]);
  });

  it('reports coverage per language, for the UI to show rather than guess', () => {
    expect(coverageOf('Hindi')).toBe('good');
    expect(coverageOf('Konkani')).toBe('shared');
    expect(coverageOf('Santali')).toBe('none');
    expect(coverageOf('Klingon')).toBe('none');
  });

  it('names a script for every script a language claims', () => {
    for (const language of SCHEDULED_LANGUAGES) {
      for (const script of language.scripts) {
        expect(INDIC_SCRIPTS[script], `${language.name} -> ${script}`).toBeDefined();
      }
    }
  });
});

describe('digits, which are the whole point for an ID card', () => {
  /**
   * An Aadhaar number printed on a Hindi card is written in Devanagari digits.
   * Every downstream check — the Verhoeff checksum, the length, the storage
   * format — needs ASCII. This conversion is the difference between the feature
   * working on a Hindi card and only working on an English one.
   */
  const cases: Array<[IndicScript | 'Latin', string, string]> = [
    ['Latin', '2345 6789 0123', '2345 6789 0123'],
    ['Devanagari', '२३४५ ६७८९ ०१२३', '2345 6789 0123'],
    ['Bengali', '২৩৪৫ ৬৭৮৯ ০১২৩', '2345 6789 0123'],
    ['Gurmukhi', '੨੩੪੫ ੬੭੮੯ ੦੧੨੩', '2345 6789 0123'],
    ['Gujarati', '૨૩૪૫ ૬૭૮૯ ૦૧૨૩', '2345 6789 0123'],
    ['Odia', '୨୩୪୫ ୬୭୮୯ ୦୧୨୩', '2345 6789 0123'],
    ['Tamil', '௨௩௪௫ ௬௭௮௯ ௦௧௨௩', '2345 6789 0123'],
    ['Telugu', '౨౩౪౫ ౬౭౮౯ ౦౧౨౩', '2345 6789 0123'],
    ['Kannada', '೨೩೪೫ ೬೭೮೯ ೦೧೨೩', '2345 6789 0123'],
    ['Malayalam', '൨൩൪൫ ൬൭൮൯ ൦൧൨൩', '2345 6789 0123'],
  ];

  it.each(cases)('converts %s digits to ASCII', (_script, input, expected) => {
    expect(normaliseDigits(input)).toBe(expected);
  });

  it('leaves letters alone while converting the digits beside them', () => {
    expect(normaliseDigits('जन्म तिथि: ०१/०२/१९९५')).toBe('जन्म तिथि: 01/02/1995');
  });

  it('handles a mixed-script line, which is what a real card looks like', () => {
    // Aadhaar cards print the number once; the labels around it are bilingual.
    expect(normaliseDigits('आधार संख्या / Aadhaar No: २३४५ 6789 ०१२३')).toBe(
      'आधार संख्या / Aadhaar No: 2345 6789 0123',
    );
  });

  it('is idempotent', () => {
    const once = normaliseDigits('२३४५');
    expect(normaliseDigits(once)).toBe(once);
  });

  it('returns an empty string unchanged rather than throwing', () => {
    expect(normaliseDigits('')).toBe('');
  });
});

describe('working out which script a scan is in', () => {
  it('spots Devanagari', () => {
    expect(detectScripts('भारत सरकार')).toContain('Devanagari');
  });

  it('spots Tamil', () => {
    expect(detectScripts('இந்திய அரசு')).toContain('Tamil');
  });

  it('reports every script present, because cards are bilingual', () => {
    // Almost every Indian ID card carries English alongside a regional script.
    const found = detectScripts('भारत सरकार / Government of India');
    expect(found).toContain('Devanagari');
    expect(found).toContain('Latin');
  });

  it('reports Latin for plain English', () => {
    expect(detectScripts('Government of India')).toEqual(['Latin']);
  });

  it('finds nothing in digits and punctuation alone', () => {
    expect(detectScripts('1234 5678 //')).toEqual([]);
  });

  it('does not claim a script from a single stray character', () => {
    // One misrecognised glyph in a page of English must not switch the whole
    // document to another script and re-run OCR with the wrong model.
    expect(detectScripts(`${'Government of India '.repeat(20)}क`)).toEqual(['Latin']);
  });
});
