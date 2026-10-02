import { describe, expect, it } from 'vitest';

import { layoutLines, layoutText, SCRIPT_MISREAD_BELOW } from './layout';
import type { ReadItem } from './paddle-reader';

/**
 * From boxes on a page to lines the field rules can read (§ reading a document).
 *
 * PaddleOCR returns one box per piece of text, with where it sits. The field
 * rules read lines — "Register No. : 800417" — so this puts boxes back into
 * lines, and does the one thing a row-by-row join gets wrong: a label printed
 * on two lines (Kannada over English) with its value between them, where the
 * value's row and the label's row are not the same row at all.
 *
 * The geometry below is the measured geometry of the user's own cards, with
 * the words changed.
 */

let next = 0;
const item = (text: string, x0: number, y0: number, x1: number, y1: number, score = 0.98): ReadItem => {
  next += 1;
  return { text, score, box: { x0, y0, x1, y1 } };
};

describe('what the English model read out of another alphabet', () => {
  it('is dropped below the measured cut-off', () => {
    // Measured on the PUC card and the Aadhaar letter: every real English line
    // read at 0.87 or above; every Kannada word the English model guessed at
    // read between 0.22 and 0.62.
    expect(SCRIPT_MISREAD_BELOW).toBeGreaterThan(0.62);
    expect(SCRIPT_MISREAD_BELOW).toBeLessThan(0.87);

    const text = layoutText([
      item('F a', 10, 100, 40, 115, 0.58),
      item('Candidate’s Name', 10, 120, 120, 134),
      item('socoted rou', 10, 160, 80, 175, 0.42),
    ]);
    expect(text).not.toMatch(/F a|socoted/);
    expect(text).toContain('Candidate’s Name');
  });
});

describe('putting a page back into lines', () => {
  it('joins the boxes of one line, left to right', () => {
    const text = layoutText([
      item('18315726', 265, 650, 380, 672),
      item('Roll No.', 110, 652, 200, 674),
    ]);
    expect(text.split('\n')).toContain('Roll No. 18315726');
  });

  it('keeps lines in reading order, top to bottom', () => {
    const lines = layoutText([
      item('MARKS STATEMENT', 440, 420, 1000, 445),
      item('CENTRAL BOARD OF SECONDARY EDUCATION', 330, 330, 1110, 365),
    ]).split('\n');
    expect(lines.indexOf('CENTRAL BOARD OF SECONDARY EDUCATION')).toBeLessThan(
      lines.indexOf('MARKS STATEMENT'),
    );
  });

  it('keeps two panels apart, rather than splicing their lines together', () => {
    // The e-Aadhaar letter: the address block on the left, an information
    // panel on the right, their lines at the same heights.
    const lines = layoutText([
      item('VTC: Hosahalli,', 120, 600, 235, 612),
      item('Aadhaar helps you avail of benefits.', 600, 600, 990, 612),
    ]).split('\n');
    expect(lines).toContain('VTC: Hosahalli,');
    expect(lines).toContain('Aadhaar helps you avail of benefits.');
  });
});

describe('a label printed on two lines, with its value between them', () => {
  /*
   * The 2nd PUC card, measured: "ಅಭ್ಯರ್ಥಿಯ ಹೆಸರು" above "Candidate's Name",
   * and "M KIRAN KUMAR" to the right, centred between the two. A row join
   * puts the value on neither label's line, and the rule that reads a label's
   * value finds the wrong one.
   */
  const card = [
    item('F a', 75, 402, 150, 416, 0.58), // the Kannada half, misread
    item('} M KIRAN KUMAR', 172, 408, 330, 425),
    item('Candidate’s Name', 75, 419, 165, 433),
    item('Month/Year', 590, 414, 640, 428),
    item('APRIL 2022', 700, 406, 790, 422),
  ];

  it('pairs the value with its label', () => {
    expect(layoutText(card).split('\n')).toContain('Candidate’s Name : M KIRAN KUMAR');
  });

  it('pairs the right-hand column with its own label, not the left-hand one', () => {
    const lines = layoutText(card).split('\n');
    expect(lines).toContain('Month/Year : APRIL 2022');
    expect(lines).not.toContain('Candidate’s Name : APRIL 2022');
  });

  it('strips the brace the card prints between a label and its value', () => {
    expect(layoutText(card)).not.toMatch(/: \}/);
  });

  it('puts the paired lines first, so a rule that takes the first match takes them', () => {
    const lines = layoutText(card).split('\n');
    expect(lines[0]).toContain(' : ');
  });
});

describe('a label with several values on its line', () => {
  it('pairs the label with the whole of the rest of the line', () => {
    // "Total Marks 600 509 509": three numbers, one label. Pairing each number
    // on its own would give "Total Marks : 600" first — the maximum, read as
    // the marks obtained.
    const lines = layoutText([
      item('Total Marks', 80, 900, 180, 915),
      item('600', 440, 898, 470, 914),
      item('509', 490, 896, 540, 916),
      item('509', 575, 896, 630, 916),
    ]).split('\n');
    expect(lines).toContain('Total Marks : 600 509 509');
    expect(lines).not.toContain('Total Marks : 600');
  });

  it('does not treat a row of table data as a label', () => {
    const text = layoutText([
      item('KANNADA', 80, 620, 160, 636),
      item('800417', 260, 620, 320, 636),
      item('APR2022', 350, 620, 415, 636),
      item('91', 470, 620, 490, 636),
    ]);
    expect(text).not.toContain(' : ');
    expect(text.split('\n')).toContain('KANNADA 800417 APR2022 91');
  });
});

describe('what it is given nothing to work with', () => {
  it('returns nothing for a page with nothing on it', () => {
    expect(layoutText([])).toBe('');
  });

  it('returns nothing for a page it could only misread', () => {
    expect(layoutText([item('socoted rou', 10, 10, 90, 25, 0.42)])).toBe('');
  });
});

void next;

describe('where on the page each line came from', () => {
  /*
   * The suggestion screen shows the piece of the card a value was read from, so
   * the user checks the pixels rather than the reading. For that, a line has
   * to remember where it sat.
   */
  it('gives every line the box that holds all of its pieces', () => {
    const lines = layoutLines([
      item('Roll No.', 110, 652, 200, 674),
      item('18315726', 265, 650, 380, 672),
    ]);
    const paired = lines.find((line) => line.text === 'Roll No. : 18315726')!;
    expect(paired.box).toEqual({ x0: 110, y0: 650, x1: 380, y1: 674 });
  });

  it('says the same thing as the text, line for line', () => {
    const items = [
      item('CENTRAL BOARD OF SECONDARY EDUCATION', 330, 330, 1110, 365),
      item('Roll No.', 110, 652, 200, 674),
      item('18315726', 265, 650, 380, 672),
    ];
    expect(layoutLines(items).map((line) => line.text).join('\n')).toBe(layoutText(items));
  });

  it('never puts a line break inside a line, or the two would fall out of step', () => {
    for (const line of layoutLines([item('Name :', 10, 10, 60, 24), item('PRIYA S', 70, 10, 140, 24)])) {
      expect(line.text).not.toContain('\n');
    }
  });
});
