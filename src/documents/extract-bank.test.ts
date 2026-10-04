import { describe, expect, it } from 'vitest';

import { isFieldKey, type FieldKey } from '@/matching/taxonomy';
import { extractFromText } from './extract';

/**
 * A bank passbook (§ reading a document).
 *
 * The account number and the IFSC were already read, because both have a shape.
 * The rest of the page is words — the bank, the branch, the name the account is
 * held in — and a scholarship form asks for all three. The name on the passbook
 * is worth reading separately from the applicant's own: they are usually the
 * same person and occasionally are not, and a scholarship paid into the wrong
 * name is the sort of mistake that takes a term to undo.
 */

const PASSBOOK = `
STATE BANK OF INDIA
Branch : MALLESHWARAM, BENGALURU
IFSC : SBIN0040567
Account Holder : PRIYA S
Account Number : 30123456789
Account Type : SAVINGS
`;

const CANARA = `
CANARA BANK
BRANCH NAME : TUMKUR MAIN
Name of Account Holder : SURESH KUMAR
A/C No : 0492101012345
IFS Code : CNRB0000492
`;

function valueOf(text: string, key: string, documentKey?: FieldKey) {
  const hint = documentKey === undefined ? {} : { documentKey };
  return extractFromText(text, hint).candidates.find((c) => c.key === key)?.value;
}

describe('a bank passbook', () => {
  it('reads the bank’s name, printed as a heading rather than labelled', () => {
    expect(valueOf(PASSBOOK, 'bank.bank_name', 'doc.bank_passbook')).toBe('STATE BANK OF INDIA');
    expect(valueOf(CANARA, 'bank.bank_name', 'doc.bank_passbook')).toBe('CANARA BANK');
  });

  it('reads the branch', () => {
    expect(valueOf(PASSBOOK, 'bank.branch', 'doc.bank_passbook')).toBe('MALLESHWARAM, BENGALURU');
    expect(valueOf(CANARA, 'bank.branch', 'doc.bank_passbook')).toBe('TUMKUR MAIN');
  });

  it('reads the name the account is held in, whichever way it is labelled', () => {
    expect(valueOf(PASSBOOK, 'bank.account_holder', 'doc.bank_passbook')).toBe('PRIYA S');
    expect(valueOf(CANARA, 'bank.account_holder', 'doc.bank_passbook')).toBe('SURESH KUMAR');
  });

  it('reads the kind of account, in the word a form offers', () => {
    expect(valueOf(PASSBOOK, 'bank.account_type', 'doc.bank_passbook')).toBe('Savings');
  });

  it('still reads the number and the code, as it always did', () => {
    expect(valueOf(PASSBOOK, 'bank.account_number', 'doc.bank_passbook')).toBe('30123456789');
    expect(valueOf(PASSBOOK, 'bank.ifsc', 'doc.bank_passbook')).toBe('SBIN0040567');
  });
});

describe('a passbook that prints its holder as a block', () => {
  /*
   * Found on the user's own passbook, read off a phone photo: the reading held
   * nearly every detail, and the panel offered two — one of them "& Address",
   * the rest of an empty box's heading. Its layout, with made-up values and the
   * reader's own slips kept: the bank's heading twice with the branch stamped
   * under the second, the account number after "A/C No.", the holder's name,
   * relation and address under one label ("ADORESS"), and the codes on the last
   * line — the IFSC a character short and its label half read ("SC COd").
   */
  const BLOCK = `
MOBILE : SMS Seal on it
SAVINGS BANK A/C No.: 1234500100067890 : Business Hours, Weekly Holidays, Telephone Nos.
Sample Bank Ltd.
FACILITIES FOR SB ACCOUNT HOLDERS
specified in the Cheque Collection Policy.
FREE DEBIT INTERNET MOBILE SMS
Conditions apply
Sample Bank Ltd.
SAMPLEPURT-NIHRUNAGAR
Branch Name & Address
SAVINGS BANK A/C No.: 1234500100067890 Business Hours, Weekly Holidays, Telephone Nos.
NAME AND ADORESS OF THE ACCOUNT HOLDER/S:
1.MEHTA R ARJUN KUMAR
S/0 R RAMAPPA,
SAMPLEPURA
572101 INDIA
Customer-id: 1)123456789
Operational Instructions: SELF
Nomination Registration No: 117
SC COd: ZZZZ000123 MICR CODE:572052123 P.BRANCH MANAGER
`;
  const read = (text = BLOCK) => extractFromText(text, { documentKey: 'doc.bank_passbook' });

  it('reads the account number printed after “A/C No.”', () => {
    expect(valueOf(BLOCK, 'bank.account_number', 'doc.bank_passbook')).toBe('1234500100067890');
  });

  it('reads the holder’s name from the block, without the number before it', () => {
    expect(valueOf(BLOCK, 'bank.account_holder', 'doc.bank_passbook')).toBe('MEHTA R ARJUN KUMAR');
  });

  it('reads the father’s name from “S/O”, the O read as a nought', () => {
    expect(valueOf(BLOCK, 'family.father_name', 'doc.bank_passbook')).toBe('R RAMAPPA');
  });

  it('reads the holder’s own address and PIN from the block', () => {
    expect(valueOf(BLOCK, 'address.permanent.line1', 'doc.bank_passbook')).toBe('SAMPLEPURA');
    expect(valueOf(BLOCK, 'address.permanent.pincode', 'doc.bank_passbook')).toBe('572101');
  });

  it('reads the town printed before the PIN, when the reader caught it', () => {
    const fuller = BLOCK.replace('572101 INDIA', 'TUMAKURU 572101 INDIA');
    expect(valueOf(fuller, 'address.permanent.city', 'doc.bank_passbook')).toBe('Tumakuru');
    expect(valueOf(fuller, 'address.permanent.line1', 'doc.bank_passbook')).toBe('SAMPLEPURA');
  });

  it('reads the MICR code printed beside the IFSC', () => {
    expect(valueOf(BLOCK, 'bank.micr', 'doc.bank_passbook')).toBe('572052123');
  });

  it('takes no box’s heading for a value: “Branch Name & Address” names no branch', () => {
    expect(valueOf(BLOCK, 'bank.branch', 'doc.bank_passbook')).toBeUndefined();
    expect(read().candidates.map((c) => c.value)).not.toContain('& Address');
  });

  it('offers no IFSC a character short, and keeps it for RBI’s list to put right', () => {
    const result = read();
    expect(result.candidates.find((c) => c.key === 'bank.ifsc')).toBeUndefined();
    expect(result.nearMisses).toEqual([
      {
        key: 'bank.ifsc',
        read: 'ZZZZ000123',
        line: result.nearMisses![0]!.line,
        // The half-read label is tidied away as a fragment; the MICR code beside it says what it is.
        evidence: 'ZZZZ000123 MICR CODE:572052123 P.BRANCH MANAGER',
      },
    ]);
  });

  it('keeps no near miss when the IFSC was read whole', () => {
    const whole = read(BLOCK.replace('SC COd: ZZZZ000123', 'IFSC Code: ZZZZ0000123'));
    expect(whole.candidates.find((c) => c.key === 'bank.ifsc')?.value).toBe('ZZZZ0000123');
    expect(whole.nearMisses ?? []).toEqual([]);
  });

  it('never reads the branch’s address as the holder’s', () => {
    const branchBox = BLOCK.replace('Branch Name & Address', 'Branch Name & Address\nMG ROAD, SAMPLEPURA 572102');
    expect(valueOf(branchBox, 'address.permanent.pincode', 'doc.bank_passbook')).toBe('572101');
  });

  it('reads no holder’s block off a document that is not a bank’s', () => {
    const keys = extractFromText(BLOCK, { documentKey: 'doc.marksheet_10' }).candidates.map((c) => c.key);
    expect(keys).not.toContain('address.permanent.pincode');
    expect(keys).not.toContain('bank.micr');
  });
});

describe('what a passbook never becomes', () => {
  it('reads no bank name off a document that is not a bank’s', () => {
    const card = `
      KARNATAKA SECONDARY EDUCATION EXAMINATION BOARD
      S.S.L.C. MARKS CARD
      STUDENT NAME : PRIYA S
    `;
    const keys = extractFromText(card, { documentKey: 'doc.marksheet_10' }).candidates.map(
      (c) => c.key,
    );
    expect(keys.filter((key) => key.startsWith('bank.'))).toEqual([]);
  });

  it('offers nothing as already decided', () => {
    for (const text of [PASSBOOK, CANARA]) {
      expect(extractFromText(text).candidates.filter((c) => c.suggestChecked)).toEqual([]);
    }
  });

  it('returns only keys the taxonomy has', () => {
    for (const text of [PASSBOOK, CANARA]) {
      for (const candidate of extractFromText(text).candidates) {
        expect(isFieldKey(candidate.key), candidate.key).toBe(true);
      }
    }
  });
});

describe('a driving licence', () => {
  const LICENCE = `
    KARNATAKA STATE
    DRIVING LICENCE
    DL No : KA05 20200001234
    Name : PRIYA S
    Date of Birth : 12-03-2007
    Valid Till : 11-03-2027
  `;

  it('reads the licence number, labelled, in the shape a state issues', () => {
    expect(valueOf(LICENCE, 'id.driving_licence', 'doc.driving_licence')).toBe('KA0520200001234');
  });

  it('reads no licence number off a document that is not one', () => {
    const card = 'S.S.L.C. MARKS CARD\nREGISTER NUMBER : KA0520200001234\n';
    const keys = extractFromText(card, { documentKey: 'doc.marksheet_10' }).candidates.map(
      (c) => c.key,
    );
    expect(keys).not.toContain('id.driving_licence');
  });
});

describe('a cancelled cheque, which is what a scholarship form asks for', () => {
  /*
   * A cheque prints almost nothing with a label on it. The bank's name is a
   * heading, the branch is an address line, and the account number sits on its
   * own above the MICR band. Read strictly by labels, a cheque yields nothing at
   * all — which is what the user got.
   */
  const CHEQUE = `
    CANARA BANK
    TUMKUR MAIN BRANCH
    PRIYA S
    0492101012345
    IFSC CNRB0000492
    PAY
    RUPEES
  `;

  it('reads an account number printed with no label, on a bank’s own document', () => {
    expect(valueOf(CHEQUE, 'bank.account_number', 'doc.bank_passbook')).toBe('0492101012345');
  });

  it('reads the bank and the code beside it', () => {
    expect(valueOf(CHEQUE, 'bank.bank_name', 'doc.bank_passbook')).toBe('CANARA BANK');
    expect(valueOf(CHEQUE, 'bank.ifsc', 'doc.bank_passbook')).toBe('CNRB0000492');
  });

  it('offers an unlabelled number as a suggestion only, never as decided', () => {
    const found = extractFromText(CHEQUE, { documentKey: 'doc.bank_passbook' }).candidates.find(
      (c) => c.key === 'bank.account_number',
    );
    expect(found?.suggestChecked).toBe(false);
    // Lower than a labelled one: nothing on the cheque said what it is.
    expect(found!.confidence).toBeLessThan(0.8);
  });

  it('reads no bare number as an account number off a document that is not a bank’s', () => {
    const card = 'S.S.L.C. MARKS CARD\n0492101012345\n';
    const keys = extractFromText(card, { documentKey: 'doc.marksheet_10' }).candidates.map(
      (c) => c.key,
    );
    expect(keys).not.toContain('bank.account_number');
  });
});
