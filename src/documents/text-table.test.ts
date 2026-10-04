import { describe, expect, it } from 'vitest';

import { tablesFromText, type TextFragment } from './text-table';

/**
 * Tables in a PDF's own text (§ reading a document).
 *
 * A grade card downloaded from a university portal is a PDF with real text in
 * it: read exactly, never recognised, and with no picture for a table model —
 * only where each piece of text sits. These fragments are laid out as pdf.js
 * reports the made-up `fixtures/pdf/grade-card.pdf`: PDF points, the origin at
 * the bottom left, one fragment per cell, and a fragment of spaces between
 * cells whose width means nothing.
 */

const at = (text: string, x: number, y: number, width: number, height = 15): TextFragment => ({
  text,
  x,
  y,
  width,
  height,
});

/** A row of cells at one baseline, each at its column's x, with the spaces Chromium writes between them. */
function row(y: number, cells: Array<[string, number, number]>): TextFragment[] {
  return cells.flatMap(([text, x, width], index) =>
    index === 0 ? [at(text, x, y, width)] : [at(' ', x - 40, y, 120, 0), at(text, x, y, width)],
  );
}

const COLUMNS = [44.2, 192, 492.7, 584, 678.7, 780.1, 848.4];
const course = (y: number, cells: string[]) =>
  row(
    y,
    cells.map((text, index) => [text, COLUMNS[index]!, text.length * 7.5] as [string, number, number]),
  );

const CARD: TextFragment[] = [
  at('SAMPLE TECHNOLOGICAL UNIVERSITY', 274.5, 536.4, 408, 21),
  at('PROVISIONAL GRADE CARD — SAMPLE', 348.2, 516.1, 260.6, 13.5),
  ...row(482.4, [['Name of the Student', 36, 145.8], ['ARJUN MEHTA', 240, 105.6]]),
  ...row(459.1, [['University Seat Number', 36, 169.2], ['1SA21CS042', 240, 90.9]]),
  ...row(435.9, [['Semester', 36, 67.5], ['III', 240, 12.5]]),
  ...course(396.9, ['Course Code', 'Course Title', 'Credits', 'Internal', 'External', 'Total', 'Grade']),
  ...course(366.9, ['21MAT31', 'Transform Calculus, Fourier Series and', '3', '45', '52', '97', 'A']),
  // The title's second line, inside the same cell: 17 points down, where a row is 30.
  at('Numerical Techniques', 192, 349.6, 147.3),
  ...course(319.6, ['21CS32', 'Data Structures and Applications', '4', '47', '58', '105', 'A+']),
  ...course(289.6, ['21CS33', 'Analog and Digital Electronics', '4', '42', '49', '91', 'A']),
  ...row(170, [['SGPA', 36, 36], ['8.45', 240, 30]]),
  ...row(147, [['CGPA', 36, 36], ['8.21', 240, 30]]),
];

const EXPECTED = [
  ['Course Code', 'Course Title', 'Credits', 'Internal', 'External', 'Total', 'Grade'],
  ['21MAT31', 'Transform Calculus, Fourier Series and Numerical Techniques', '3', '45', '52', '97', 'A'],
  ['21CS32', 'Data Structures and Applications', '4', '47', '58', '105', 'A+'],
  ['21CS33', 'Analog and Digital Electronics', '4', '42', '49', '91', 'A'],
];

describe('a table in a PDF’s own text', () => {
  it('reads the grid: one row per course, one column per heading, a wrapped title in one cell', () => {
    expect(tablesFromText(CARD)).toEqual([{ rows: EXPECTED }]);
  });

  it('leaves the label rows above and below it out of it', () => {
    const cells = tablesFromText(CARD)[0]!.rows.flat();
    for (const text of ['ARJUN MEHTA', 'Semester', 'SGPA', '8.45']) expect(cells).not.toContain(text);
  });

  it('joins a PDF that writes a word, or a letter, at a time back into its cells', () => {
    // Some report generators place every word — or every letter — on its own.
    const split = CARD.flatMap((fragment) => {
      if (fragment.text.trim() === '' || !fragment.text.includes(' ')) return [fragment];
      let x = fragment.x;
      return fragment.text.split(' ').map((word) => {
        const piece = at(word, x, fragment.y, word.length * 7.5, fragment.height);
        x += (word.length + 1) * 7.5;
        return piece;
      });
    });
    expect(tablesFromText(split)).toEqual([{ rows: EXPECTED }]);
    const letters = CARD.flatMap((fragment) =>
      fragment.text.length > 1 && fragment.text === '105'
        ? [...fragment.text].map((letter, index) => at(letter, fragment.x + index * 8.3, fragment.y, 8.3))
        : [fragment],
    );
    expect(tablesFromText(letters)[0]!.rows[2]![5]).toBe('105');
  });

  it('keeps a column every row leaves empty, where its heading is', () => {
    // No course has a grade yet: the column is there, and empty.
    const ungraded = CARD.filter((fragment) => !(fragment.x === 848.4 && fragment.y < 390));
    expect(tablesFromText(ungraded)[0]!.rows.map((cells) => cells[6])).toEqual(['Grade', '', '', '']);
  });

  it('finds no table on a page of labels and sentences', () => {
    const letter = [
      at('This is to certify that Sri ARJUN MEHTA is a student of this university.', 36, 500, 520),
      ...row(470, [['Date', 36, 30], ['14/03/2024', 240, 70]]),
      ...row(450, [['Place', 36, 36], ['Samplepura', 240, 80]]),
    ];
    expect(tablesFromText(letter)).toEqual([]);
  });
});
