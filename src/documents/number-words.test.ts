import { describe, expect, it } from 'vitest';

import { amountInWords } from './number-words';

/**
 * An amount written out in words (§ reading a document).
 *
 * An income certificate prints its figure twice: "45000 ( Rs. forty five thousand
 * only.)". On the user's own certificate the recogniser dropped the bold digits
 * and kept the words — so the words are a second way to the same number, and
 * the only one that survived.
 *
 * Indian counting: thousand, lakh, crore.
 */

describe('an amount in words', () => {
  it('reads thousands', () => {
    expect(amountInWords('forty five thousand')).toBe(45000);
    expect(amountInWords('forty five thousand five hundred')).toBe(45500);
  });

  it('reads lakhs and crores, as an Indian certificate counts', () => {
    expect(amountInWords('one lakh twenty thousand')).toBe(120000);
    expect(amountInWords('two lakhs fifty thousand')).toBe(250000);
    expect(amountInWords('one crore')).toBe(10000000);
  });

  it('skips the words around the number', () => {
    expect(amountInWords('Rupees forty five thousand only')).toBe(45000);
    expect(amountInWords('one lakh and five thousand only.')).toBe(105000);
  });

  it('reads a word the recogniser clipped, when only one word fits', () => {
    // As read from the user's certificate: "thousand" came back as "thousn".
    expect(amountInWords('forty five thousn')).toBe(45000);
  });

  it('refuses a clipped word that could be two different numbers', () => {
    // "thirt" is the start of both thirty and thirteen. A guess here is a
    // wrong income on an application.
    expect(amountInWords('thirt thousand')).toBeNull();
  });

  it('reads nothing from words that are not a number', () => {
    expect(amountInWords('only')).toBeNull();
    expect(amountInWords('Deputy Tahsildar')).toBeNull();
    expect(amountInWords('')).toBeNull();
  });
});
