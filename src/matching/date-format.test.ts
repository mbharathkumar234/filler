import { describe, expect, it } from 'vitest';

import { dateAsAsked } from './date-format';

/**
 * A date as the box asks for it.
 *
 * The vault keeps dates one way (2024-03-14); Indian forms ask for them in
 * text boxes that say how — "DD/MM/YYYY" in the placeholder, "(dd-mm-yyyy)" in
 * the label — and reject anything else. A box that says nothing gets the date
 * as kept, and a native date picker is never asked (it wants it as kept).
 */
describe('a date as the box asks for it', () => {
  it.each([
    ['DD/MM/YYYY', '14/03/2024'],
    ['dd-mm-yyyy', '14-03-2024'],
    ['Date of Issue (DD.MM.YYYY)', '14.03.2024'],
    ['Date of Birth dd/mm/yyyy', '14/03/2024'],
    ['MM/DD/YYYY', '03/14/2024'],
    ['YYYY/MM/DD', '2024/03/14'],
    ['YYYY-MM-DD', '2024-03-14'],
  ])('writes it as "%s" shows', (hint, written) => {
    expect(dateAsAsked('2024-03-14', hint)).toBe(written);
  });

  it('leaves it as kept when the box says nothing of a format', () => {
    expect(dateAsAsked('2024-03-14', 'Date of Issue')).toBe('2024-03-14');
    expect(dateAsAsked('2024-03-14', '')).toBe('2024-03-14');
  });

  it('touches nothing that is not a date', () => {
    for (const value of ['RD0987654321012', 'TAHSILDAR, SAMPLEPURA TALUK', '2024', '14/03/2024']) {
      expect(dateAsAsked(value, 'DD/MM/YYYY')).toBe(value);
    }
  });
});
