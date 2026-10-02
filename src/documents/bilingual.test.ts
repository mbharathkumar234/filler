import { describe, expect, it } from 'vitest';

import { latinise, trimNoise } from './bilingual';

/**
 * Reading a document that is printed twice (§ reading a document).
 *
 * Every document a Karnataka student holds except a CBSE marks card prints each
 * heading in Kannada and again in English, usually on the same line, separated
 * by a slash or nothing at all. The values — a name, a register number, a date —
 * are printed once, in whichever script the office felt like.
 *
 * The rules that fill this vault are anchored to labels at the start of a line,
 * so "ಹೆಸರು / Student Name : PRIYA S" matches nothing at all: the line does not
 * begin with "Student". This module is the pass that makes those lines look like
 * what they say.
 */

describe('a line printed in two alphabets', () => {
  it('keeps the English half when both are there', () => {
    expect(latinise('ವಿದ್ಯಾರ್ಥಿಯ ಹೆಸರು / Student Name : PRIYA S')).toBe('Student Name : PRIYA S');
  });

  it('keeps the English value when the value is the half that is doubled', () => {
    expect(latinise('PRIYA S / ಪ್ರಿಯಾ ಎಸ್')).toBe('PRIYA S');
  });

  it('translates a label printed only in Kannada, so it still anchors a rule', () => {
    expect(latinise('ಹೆಸರು : PRIYA S')).toBe('Name : PRIYA S');
    expect(latinise('ತಂದೆಯ ಹೆಸರು : SURESH KUMAR')).toBe('Father Name : SURESH KUMAR');
    expect(latinise('ಜನ್ಮ ದಿನಾಂಕ : 12-03-2007')).toBe('Date of Birth : 12-03-2007');
    expect(latinise('ನೋಂದಣಿ ಸಂಖ್ಯೆ : 1234567')).toBe('Registration Number : 1234567');
  });

  it('does the same for the Devanagari an Aadhaar card prints', () => {
    expect(latinise('नाम / Name : RAVI KUMAR')).toBe('Name : RAVI KUMAR');
    expect(latinise('पता : 12 4TH CROSS')).toBe('Address : 12 4TH CROSS');
  });

  it('leaves an English line exactly as it was', () => {
    const line = 'REGISTER NUMBER : 1234567';
    expect(latinise(line)).toBe(line);
  });

  it('keeps a value that is printed in one script only', () => {
    // Nothing on this line says the same thing twice, so there is nothing to
    // drop. An Aadhaar card whose holder's name is printed only in Devanagari
    // has always been read that way, and a card that names itself only in its
    // own script is how the card is recognised at all.
    expect(latinise('ಕರ್ನಾಟಕ ಸರ್ಕಾರ')).toBe('ಕರ್ನಾಟಕ ಸರ್ಕಾರ');
    expect(latinise('नाम : अनिता शर्मा')).toBe('Name : अनिता शर्मा');
  });

  it('keeps the digits on a line whose words were all Kannada', () => {
    expect(latinise('ಒಟ್ಟು : 525')).toBe('Total : 525');
  });
});

describe('the fragments a misread leaves behind', () => {
  /*
   * The real line this was written for. A 2nd PUC marks card read without the
   * Kannada model: the English survived, and the Kannada came back as short
   * broken tokens on either side of it — which then became the value offered
   * for "Board or university".
   */
  it('strips the broken fragments from the ends of a line', () => {
    expect(trimNoise('a. E Shb zn DEPARTMENT OF PRE-UNIVERSITY EDUCATION fe” |')).toBe(
      'DEPARTMENT OF PRE-UNIVERSITY EDUCATION',
    );
  });

  it('leaves a line of real words alone, short ones included', () => {
    expect(trimNoise('BOARD OF SECONDARY EDUCATION')).toBe('BOARD OF SECONDARY EDUCATION');
    expect(trimNoise('S.S.L.C. MARKS CARD')).toBe('S.S.L.C. MARKS CARD');
  });

  it('never eats a value, however short', () => {
    expect(trimNoise('Roll No. 12345678')).toBe('Roll No. 12345678');
    expect(trimNoise('RESULT : PASS')).toBe('RESULT : PASS');
    expect(trimNoise('PRIYA S')).toBe('PRIYA S');
  });

  it('never trims the value side of a label, however short the value', () => {
    // "Om" is two letters and looks exactly like a fragment. On the far side of
    // a colon it is somebody's name, and the label says so.
    expect(trimNoise('Name : Om')).toBe('Name : Om');
    expect(trimNoise('ee Sw Name : Om')).toBe('Name : Om');
  });

  it('gives back nothing for a line that was nothing but fragments', () => {
    expect(trimNoise('Bl oor wx ori) Sr, lin')).toBe('');
  });

  it('keeps a long word with a mark inside it: that is a damaged word, not a fragment', () => {
    // Off a real 2nd PUC card, where the H of MATHEMATICS is broken in print.
    // A misread rarely invents eleven letters; it was the subject's name, and
    // stripping it left a row of marks belonging to nothing.
    expect(trimNoise('MAT!JEMATICS 800001 APR2022 100 88 88 EIGHT EIGHT')).toBe(
      'MAT!JEMATICS 800001 APR2022 100 88 88 EIGHT EIGHT',
    );
    // A short one is still what it always was.
    expect(trimNoise('f|e DEPARTMENT OF PRE-UNIVERSITY EDUCATION')).toBe(
      'DEPARTMENT OF PRE-UNIVERSITY EDUCATION',
    );
  });
});
