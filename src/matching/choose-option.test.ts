import { describe, expect, it } from 'vitest';

import { chooseOption, type ChoiceOption } from './choose-option';

/**
 * Choosing the option a saved value means (§ choice questions).
 *
 * A form asks "What is your current field of study or major?" and offers
 * "Computer Science / IT", "Electronics / Communication" and the rest; the vault
 * holds "Computer Science and Engineering". No option says that, and every
 * option is the wrong answer to a letter-by-letter comparison. The person
 * filling it by hand picks "Computer Science / IT" without a thought — that is
 * the judgement made here, in tested rules: the same words; the same meaning
 * ("M" is "Male", "CBSE" is the Central Board…); the same family of course; the
 * band a number falls in; and, when nothing fits, "Other" with the answer typed.
 * When it is unsure it says so, and the review screen asks the person to look.
 */

const opts = (...texts: string[]): ChoiceOption[] => texts.map((text) => ({ text }));
const chosen = (value: string, options: ChoiceOption[]) => {
  const choice = chooseOption(value, options);
  return choice.kind === 'none' ? null : options[choice.index]!.text;
};

describe('the options that are not answers', () => {
  it('never chooses the placeholder a dropdown starts on', () => {
    for (const placeholder of ['Choose', '-- Select --', 'Select one', 'Please select', '']) {
      const options = opts(placeholder, 'Male', 'Female');
      expect(chosen('Choose', options), placeholder).toBe(null);
    }
  });
});

describe('the same words', () => {
  it('chooses the option that says the value, whatever its case and stops', () => {
    expect(chooseOption('KARNATAKA', opts('Choose', 'Kerala', 'Karnataka', 'Goa'))).toEqual({
      kind: 'option',
      index: 2,
      how: 'exact',
      sure: true,
    });
    expect(chosen('B.E.', opts('BE', 'B.Sc', 'BA'))).toBe('BE');
  });

  it('matches an option by its value as well as its words', () => {
    expect(chosen('KA', [{ text: 'Karnataka', value: 'KA' }, { text: 'Kerala', value: 'KL' }])).toBe('Karnataka');
  });
});

describe('the same meaning', () => {
  it('reads a gender however the form writes it', () => {
    expect(chosen('Male', opts('M', 'F', 'Other'))).toBe('M');
    expect(chosen('F', opts('Male', 'Female', 'Transgender'))).toBe('Female');
    expect(chooseOption('MALE', opts('Boy', 'Girl'))).toMatchObject({ kind: 'option', how: 'meaning', sure: true });
  });

  it('reads a reservation category in its usual spellings', () => {
    expect(chosen('GM', opts('General / Unreserved', 'OBC', 'SC', 'ST', 'EWS'))).toBe('General / Unreserved');
    expect(chosen('Scheduled Tribe', opts('GEN', 'OBC', 'SC', 'ST'))).toBe('ST');
    expect(chosen('OBC', opts('General', 'Other Backward Classes', 'Scheduled Caste'))).toBe('Other Backward Classes');
  });

  it('reads yes and no, and a blood group', () => {
    expect(chosen('Yes', opts('Y', 'N'))).toBe('Y');
    expect(chosen('B+', opts('A Positive', 'B Positive', 'B Negative', 'O Positive'))).toBe('B Positive');
    expect(chosen('O -ve', opts('O+', 'O-', 'AB+'))).toBe('O-');
  });

  it('reads a board or university from its initials', () => {
    expect(chosen('CENTRAL BOARD OF SECONDARY EDUCATION', opts('CBSE', 'ICSE', 'State Board', 'Other'))).toBe('CBSE');
    expect(chosen('Visvesvaraya Technological University', opts('VTU', 'Bangalore University', 'Mysore University'))).toBe(
      'VTU',
    );
  });

  it('reads an unmarried person as single', () => {
    expect(chosen('Unmarried', opts('Single', 'Married', 'Divorced'))).toBe('Single');
  });

  it('files a state’s own board under "State Board"', () => {
    const boards = opts('CBSE', 'ICSE', 'State Board', 'Other');
    expect(chosen('KARNATAKA SECONDARY EDUCATION EXAMINATION BOARD', boards)).toBe('State Board');
    expect(chosen('Department of Pre-University Education, Karnataka', boards)).toBe('State Board');
    expect(chosen('KSEEB', boards)).toBe('State Board');
    expect(chosen('ISC', boards)).toBe('ICSE');
  });

  it('knows a city by its old name and its new one', () => {
    expect(chosen('Bengaluru Urban', opts('Bangalore Rural', 'Bangalore Urban', 'Mysore'))).toBe('Bangalore Urban');
    expect(chosen('Mysore', opts('Bengaluru', 'Mysuru', 'Mangaluru'))).toBe('Mysuru');
  });

  it('reads a month or a day however it is numbered', () => {
    expect(chosen('03', opts('January', 'February', 'March', 'April'))).toBe('March');
    expect(chosen('March', opts('01', '02', '03', '04'))).toBe('03');
    expect(chosen('07', opts('Day', '5', '6', '7', '8'))).toBe('7');
  });
});

describe('the same family of course', () => {
  // The options on the user's own screenshot.
  const FIELDS = opts(
    'Choose',
    'Computer Science / IT',
    'Electronics / Communication',
    'Mechanical / Civil Engineering',
    'Commerce / Business Administration',
    'Arts / Humanities',
    'Science / Pure Sciences',
    'Other',
  );

  it('files a branch under the family it belongs to', () => {
    expect(chosen('Computer Science and Engineering', FIELDS)).toBe('Computer Science / IT');
    expect(chosen('Information Science', FIELDS)).toBe('Computer Science / IT');
    expect(chosen('Artificial Intelligence & Machine Learning', FIELDS)).toBe('Computer Science / IT');
    expect(chosen('Electronics and Communication Engineering', FIELDS)).toBe('Electronics / Communication');
    expect(chosen('Civil Engineering', FIELDS)).toBe('Mechanical / Civil Engineering');
    expect(chosen('B.Com', FIELDS)).toBe('Commerce / Business Administration');
    expect(chosen('BA History', FIELDS)).toBe('Arts / Humanities');
    expect(chosen('B.Sc Physics', FIELDS)).toBe('Science / Pure Sciences');
  });

  it('never files Computer Science under Science, nor Political Science', () => {
    expect(chosen('Computer Science', FIELDS)).toBe('Computer Science / IT');
    expect(chosen('Political Science', FIELDS)).toBe('Arts / Humanities');
  });

  it('asks for a look, because a family is an inference', () => {
    expect(chooseOption('Computer Science and Engineering', FIELDS)).toMatchObject({ how: 'family', sure: false });
  });

  it('does not decide on "engineering" alone, which every branch shares', () => {
    expect(chooseOption('Engineering', opts('Computer Science / IT', 'Mechanical / Civil Engineering'))).toEqual({
      kind: 'none',
      reason: expect.stringMatching(/none of the 2 options/i),
    });
  });

  it('chooses Other for a course in no family offered, with the course as the answer', () => {
    expect(chooseOption('MBBS', FIELDS)).toEqual({ kind: 'other', index: 7, text: 'MBBS' });
  });
});

describe('the band a number falls in', () => {
  it('finds an income in rupee bands, Indian commas and all', () => {
    const bands = opts('Below ₹1,00,000', '₹1,00,001 – ₹2,50,000', '₹2,50,001 – ₹5,00,000', 'Above ₹5,00,000');
    expect(chosen('30000', bands)).toBe('Below ₹1,00,000');
    expect(chosen('2,75,000', bands)).toBe('₹2,50,001 – ₹5,00,000');
    expect(chooseOption('30000', bands)).toMatchObject({ how: 'range', sure: true });
  });

  it('finds an income in lakh bands', () => {
    const bands = opts('Below 1 Lakh', '1 - 2.5 Lakh', '2.5 - 5 Lakh', 'Above 5 Lakh');
    expect(chosen('120000', bands)).toBe('1 - 2.5 Lakh');
    expect(chosen('Rs. 6.5 lakh', bands)).toBe('Above 5 Lakh');
  });

  it('finds marks in percentage bands', () => {
    expect(chosen('85.17', opts('Below 60%', '60% - 75%', 'Above 75%'))).toBe('Above 75%');
  });

  it('is unsure on a boundary two bands share', () => {
    expect(chooseOption('250000', opts('Up to 2.5 lakh', '2.5 lakh to 5 lakh'))).toMatchObject({ sure: false });
  });

  it('reads no band into a value that is not a number', () => {
    expect(chosen('Karnataka', opts('Below 1 Lakh', 'Above 1 Lakh'))).toBe(null);
  });
});

describe('the words most of an option shares', () => {
  it('chooses the option a longer value contains', () => {
    expect(chooseOption('Bangalore University, Bengaluru', opts('Bangalore University', 'Mysore University'))).toMatchObject({
      kind: 'option',
      index: 0,
      sure: false,
    });
  });
});

describe('the wrong answers it must never give', () => {
  it('never reads Female as Male, nor Male as Female', () => {
    expect(chosen('Female', opts('Male', 'Female'))).toBe('Female');
    expect(chosen('Female', opts('Male', 'Transgender'))).toBe(null);
    expect(chosen('Male', opts('Female', 'Transgender'))).toBe(null);
  });

  it('never takes Other Backward Classes for "Other"', () => {
    expect(chosen('OBC', opts('General', 'Other Backward Classes', 'Other'))).toBe('Other Backward Classes');
    expect(chosen('Other Backward Classes', opts('GM', 'OBC', 'SC', 'Other'))).toBe('OBC');
  });

  it('never puts an income into percentage bands, nor marks into rupee bands', () => {
    expect(chosen('30000', opts('Below 60%', '60% - 75%', 'Above 75%'))).toBe(null);
    expect(chosen('85%', opts('Below 1 Lakh', 'Above 1 Lakh'))).toBe(null);
  });

  it('never chooses between two options a value fits equally', () => {
    expect(chosen('Bangalore', opts('Bangalore Urban', 'Bangalore Rural'))).toBe(null);
  });

  it('never chooses a nearby spelling of a different place', () => {
    expect(chosen('Kerala', opts('Karnataka', 'Goa'))).toBe(null);
    expect(chosen('Karnatka', opts('Kerala', 'Karnataka', 'Goa'))).toBe('Karnataka');
  });
});

describe('when nothing offered fits', () => {
  it('chooses Other, and gives the value as the answer to type', () => {
    expect(chooseOption('Tumkur University', opts('VTU', 'Bangalore University', 'Others (please specify)'))).toEqual({
      kind: 'other',
      index: 2,
      text: 'Tumkur University',
    });
  });

  it('knows an option marked as Other, whatever its words', () => {
    const options: ChoiceOption[] = [{ text: 'First' }, { text: 'Something else', other: true }];
    expect(chooseOption('Neither', options)).toMatchObject({ kind: 'other', index: 1 });
  });

  it('never chooses Other when an option fits', () => {
    expect(chosen('Male', opts('Male', 'Female', 'Other'))).toBe('Male');
  });

  it('leaves the question for the person when there is no Other', () => {
    const choice = chooseOption('Tumkur University', opts('VTU', 'Bangalore University'));
    expect(choice).toEqual({ kind: 'none', reason: expect.stringMatching(/none of the 2 options.*no "Other"/i) });
    // The reason is shown and logged; the answer itself is not part of it.
    expect(JSON.stringify(choice)).not.toMatch(/Tumkur/);
  });

  it('leaves it when there is no value to give', () => {
    expect(chooseOption('  ', opts('VTU', 'Other'))).toMatchObject({ kind: 'none' });
  });
});
