import { describe, expect, it } from 'vitest';

import type { FieldKey } from '@/matching/taxonomy';
import type { IfscRecord } from '@/reference/ifsc';
import type { PinRecord } from '@/reference/pincode';
import type { Candidate, ExtractionResult } from './extract';
import { checkAgainstReference, codesIn, lookUp, type ReferenceFinds } from './reference-check';

const read = (key: FieldKey, value: string, line = 3): Candidate => ({
  key,
  value,
  confidence: 0.8,
  evidence: `${key} line`,
  line,
  verified: false,
  confirmed: false,
  suggestChecked: false,
});

const reading = (...candidates: Candidate[]): ExtractionResult => ({
  documentType: 'bank_passbook',
  candidates,
  scripts: ['Latin'],
  warnings: [],
  notes: [],
});

/* A real public branch code: an IFSC is a branch's address, not anyone's detail. */
const KOLKATA_MAIN: IfscRecord = {
  ifsc: 'SBIN0000001',
  bank: 'State Bank of India',
  branch: 'KOLKATA MAIN',
  address: 'SAMRIDDHI BHAWAN, 1 STRAND ROAD, KOLKATA 700 001',
  city: 'Kolkata',
  district: 'Kolkata',
  state: 'West Bengal',
  micr: '700002021',
};

/** A made-up branch in Bengaluru, with the list's own spellings of its town. */
const branch = (code: string, name: string, bank = 'State Bank of India'): IfscRecord => ({
  ifsc: code,
  bank,
  branch: name,
  address: `1 ${name} ROAD`,
  city: 'Bangalore',
  district: 'Bangalore Urban',
  state: 'Karnataka',
  micr: '560002999',
});

const GPO: PinRecord = { pin: '560001', states: ['Karnataka'], districts: ['Bengaluru'], offices: ['Bangalore G.P.O.'] };

const finds = (ifsc: Array<[string, IfscRecord | null]> = [], pins: Array<[string, PinRecord | null]> = []): ReferenceFinds => ({
  ifsc: new Map(ifsc),
  pins: new Map(pins),
});

const value = (result: ExtractionResult, key: string) => result.candidates.find((c) => c.key === key);

/** A passbook reading of one code and the branch printed beside it, checked against one record. */
const checked = (record: IfscRecord, printedBranch: string, printedBank?: string) =>
  checkAgainstReference(
    reading(
      read('bank.ifsc', record.ifsc),
      read('bank.branch', printedBranch),
      ...(printedBank === undefined ? [] : [read('bank.bank_name', printedBank)]),
    ),
    finds([[record.ifsc, record]]),
  );

describe('which codes a reading is checked for', () => {
  it('takes every IFSC and every PIN it read, and nothing else', () => {
    const result = reading(
      read('bank.ifsc', 'SBIN0000001'),
      read('address.permanent.pincode', '560001'),
      read('address.correspondence.pincode', '515631'),
      read('bank.account_number', '12345678901'),
    );
    expect(codesIn(result)).toEqual({ ifscs: ['SBIN0000001'], near: [], pins: ['560001', '515631'] });
  });

  it('asks the lists once for each code', async () => {
    const asked: string[] = [];
    const found = await lookUp(reading(read('bank.ifsc', 'SBIN0000001'), read('address.permanent.pincode', '560001')), {
      ifsc: async (code) => {
        asked.push(code);
        return KOLKATA_MAIN;
      },
      pincode: async (pin) => {
        asked.push(pin);
        return null;
      },
    });
    expect(asked).toEqual(['SBIN0000001', '560001']);
    expect(found.ifsc.get('SBIN0000001')).toEqual(KOLKATA_MAIN);
    expect(found.pins.get('560001')).toBeNull();
  });

  it('leaves a code unchecked, not "not in the list", when the lookup fails', async () => {
    const result = reading(read('bank.ifsc', 'SBIN0000001'), read('address.permanent.pincode', '560001'));
    const found = await lookUp(result, {
      ifsc: async () => {
        throw new Error('missing from this build');
      },
      pincode: async () => GPO,
    });
    expect(found.ifsc.has('SBIN0000001')).toBe(false);
    expect(found.pins.get('560001')).toEqual(GPO);
    expect(checkAgainstReference(result, found).warnings).toEqual([]);
  });
});

describe('an IFSC, against RBI’s list', () => {
  it('fills the bank, the branch, its MICR code and its address from the list, beside the IFSC’s own line', () => {
    const result = checkAgainstReference(reading(read('bank.ifsc', 'SBIN0000001', 4)), finds([['SBIN0000001', KOLKATA_MAIN]]));
    const listed = { list: 'ifsc', code: 'SBIN0000001' };
    expect(value(result, 'bank.bank_name')).toMatchObject({ value: 'State Bank of India', line: 4, listed, suggestChecked: false });
    expect(value(result, 'bank.branch')).toMatchObject({ value: 'KOLKATA MAIN', listed });
    expect(value(result, 'bank.micr')).toMatchObject({ value: '700002021', listed });
    expect(value(result, 'bank.branch_address')?.value).toBe('SAMRIDDHI BHAWAN, 1 STRAND ROAD, KOLKATA 700 001');
    expect(value(result, 'bank.micr')?.evidence).toBe('RBI’s list of IFSC codes: SBIN0000001');
    expect(result.notes.join(' ')).toMatch(/SBIN0000001/);
    // Nothing printed to agree with: the IFSC is read, not confirmed.
    expect(value(result, 'bank.ifsc')?.agreement).toBeUndefined();
    expect(value(result, 'bank.ifsc')?.listed).toBeUndefined();
  });

  it('says so when the branch printed beside it is the one the list names — and leaves the ticking to the user', () => {
    const result = checked(KOLKATA_MAIN, 'Kolkata Main Branch', 'STATE BANK OF INDIA');
    expect(value(result, 'bank.ifsc')?.agreement).toBe(
      'RBI’s list has SBIN0000001 as State Bank of India’s KOLKATA MAIN branch, in Kolkata — the branch printed beside it.',
    );
    // Only a checksum pre-ticks a row; two readings that agree are said, not ticked.
    expect(value(result, 'bank.ifsc')).toMatchObject({ verified: false, suggestChecked: false });
    expect(value(result, 'bank.micr')).toMatchObject({ verified: false, suggestChecked: false });
    // What the document printed stays as it printed it.
    expect(value(result, 'bank.branch')).toMatchObject({ value: 'Kolkata Main Branch' });
    expect(value(result, 'bank.branch')?.listed).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it.each([
    ['spelled two ways', 'MALLESWARAM', 'MALLESHWARAM, BENGALURU'],
    ['under the town’s old name', 'MALLESWARAM', 'MALLESWARAM, BANGALORE'],
    ['run together', 'RAJAJINAGAR', 'RAJAJI NAGAR'],
  ])('knows the same branch %s', (_, listed, printed) => {
    const result = checked(branch('SBIN0001234', listed), printed);
    expect(value(result, 'bank.ifsc')?.agreement).toMatch(new RegExp(`${listed} branch, in Bangalore`));
    expect(result.warnings).toEqual([]);
  });

  it('does not take another branch in the same town for this one: a bank has a hundred in Bengaluru', () => {
    const result = checked(branch('SBIN0001234', 'MALLESWARAM'), 'JAYANAGAR, BENGALURU');
    expect(result.warnings.join(' ')).toMatch(/SBIN0001234 is State Bank of India’s MALLESWARAM branch.*"JAYANAGAR, BENGALURU"/);
    expect(value(result, 'bank.micr')).toBeUndefined();
    expect(value(result, 'bank.ifsc')?.agreement).toBeUndefined();
  });

  it('tells Jayanagar from Vijayanagar', () => {
    const result = checked(branch('SBIN0001234', 'VIJAYANAGAR'), 'JAYANAGAR');
    expect(result.warnings).toHaveLength(1);
  });

  it('says which branch the list names when the one printed is only part of its name', () => {
    const result = checked(branch('SBIN0001234', 'JAYANAGAR 4TH BLOCK'), 'JAYANAGAR');
    expect(result.warnings).toEqual([]);
    expect(value(result, 'bank.ifsc')?.agreement).toBeUndefined();
    expect(result.notes.join(' ')).toMatch(/RBI’s list has SBIN0001234 as State Bank of India’s JAYANAGAR 4TH BLOCK branch, in Bangalore; this document reads "JAYANAGAR"/);
    expect(value(result, 'bank.micr')?.value).toBe('560002999');
  });

  it('does not count the town alone as the branch', () => {
    const result = checked(KOLKATA_MAIN, 'KOLKATA');
    expect(value(result, 'bank.ifsc')?.agreement).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it('knows a bank by its initials', () => {
    const result = checkAgainstReference(
      reading(read('bank.ifsc', 'SBIN0000001'), read('bank.bank_name', 'SBI')),
      finds([['SBIN0000001', KOLKATA_MAIN]]),
    );
    expect(result.warnings).toEqual([]);
  });

  it('knows a bank by the name its passbooks had before a merger', () => {
    const result = checkAgainstReference(
      reading(read('bank.ifsc', 'CNRB0001234'), read('bank.bank_name', 'SYNDICATE BANK')),
      finds([['CNRB0001234', branch('CNRB0001234', 'MALLESWARAM', 'Canara Bank')]]),
    );
    expect(result.warnings).toEqual([]);
  });

  it('says so, and adds nothing, when the branch printed is another one', () => {
    const result = checked(KOLKATA_MAIN, 'TUMKUR');
    expect(result.warnings.join(' ')).toMatch(/SBIN0000001 is State Bank of India’s KOLKATA MAIN branch.*"TUMKUR"/);
    expect(value(result, 'bank.micr')).toBeUndefined();
  });

  it('says so when the bank printed is another one', () => {
    const result = checkAgainstReference(
      reading(read('bank.ifsc', 'SBIN0000001'), read('bank.bank_name', 'SAMPLE BANK')),
      finds([['SBIN0000001', KOLKATA_MAIN]]),
    );
    expect(result.warnings.join(' ')).toMatch(/"SAMPLE BANK"/);
  });

  it('warns of a code that is not in the list, and keeps it for the user to check', () => {
    const result = checkAgainstReference(reading(read('bank.ifsc', 'SMPL0001234')), finds([['SMPL0001234', null]]));
    expect(result.warnings).toEqual([
      'SMPL0001234 is not in RBI’s list of IFSC codes. It was probably misread — check it against the passbook or a cheque.',
    ]);
    expect(value(result, 'bank.ifsc')).toMatchObject({ value: 'SMPL0001234', suggestChecked: false });
  });

  it('says an old bank’s code is out of date, not misread', () => {
    const result = checkAgainstReference(reading(read('bank.ifsc', 'SYNB0001234')), finds([['SYNB0001234', null]]));
    expect(result.warnings).toEqual([
      'SYNB0001234 is a Syndicate Bank code. Syndicate Bank merged into Canara Bank, and its branches were given new IFSCs — ' +
        'a form wants the new one, which is on a recent passbook page or cheque.',
    ]);
  });
});

describe('a branch printed with no label, as a passbook stamps it', () => {
  const NEHRU_NAGAR: IfscRecord = {
    ifsc: 'ZZZZ0000123',
    bank: 'Sample Bank',
    branch: 'NEHRU NAGAR',
    address: '1 MG ROAD, NEHRU NAGAR, SAMPLEPURA-572101',
    city: 'Samplepura',
    district: 'Samplepura',
    state: 'Karnataka',
    micr: '572052103',
  };

  it('is found anywhere on the document, read a letter off, and said to agree', () => {
    const result = checkAgainstReference(
      reading(read('bank.ifsc', 'ZZZZ0000123')),
      finds([['ZZZZ0000123', NEHRU_NAGAR]]),
      ['Sample Bank Ltd.', 'SAMPLEPURT-NIHRUNAGAR', 'ZZZZ0000123 MICR CODE:572052103'],
    );
    expect(value(result, 'bank.ifsc')?.agreement).toBe(
      'RBI’s list has ZZZZ0000123 as Sample Bank’s NEHRU NAGAR branch, in Samplepura — the branch printed on this document (“SAMPLEPURT-NIHRUNAGAR”).',
    );
    expect(value(result, 'bank.ifsc')?.suggestChecked).toBe(false);
  });

  it('is not found in a line that only names the bank or the town', () => {
    const result = checkAgainstReference(
      reading(read('bank.ifsc', 'ZZZZ0000123')),
      finds([['ZZZZ0000123', NEHRU_NAGAR]]),
      ['Sample Bank Ltd.', 'SAMPLEPURA 572101 INDIA'],
    );
    expect(value(result, 'bank.ifsc')?.agreement).toBeUndefined();
  });
});

describe('an IFSC read a character short, put right from RBI’s list', () => {
  /*
   * On the user's own passbook an IFSC was read a nought short, its label half
   * read beside it. Of the bank's thousand branches, one was a character from
   * that — and the branch stamped on the passbook was that one.
   */
  const NEHRU_NAGAR: IfscRecord = {
    ifsc: 'ZZZZ0000123',
    bank: 'Sample Bank',
    branch: 'NEHRU NAGAR',
    address: '1 MG ROAD, NEHRU NAGAR, SAMPLEPURA-572101',
    city: 'Samplepura',
    district: 'Samplepura',
    state: 'Karnataka',
    micr: '572052103',
  };
  const STATION_ROAD: IfscRecord = { ...NEHRU_NAGAR, ifsc: 'ZZZZ0001230', branch: 'STATION ROAD', address: '1 STATION ROAD, SAMPLEPURA' };
  const missed = (code = 'ZZZZ000123'): ExtractionResult => ({
    ...reading(read('bank.micr', '572052123', 9)),
    nearMisses: [{ key: 'bank.ifsc', read: code, line: 9, evidence: `${code} MICR CODE:572052123` }],
  });
  const near = (...pairs: Array<[string, IfscRecord[]]>): ReferenceFinds => ({ ifsc: new Map(), pins: new Map(), near: new Map(pairs) });

  it('is put right when the list has one branch it can be, and its row says so', () => {
    const result = checkAgainstReference(missed(), near(['ZZZZ000123', [NEHRU_NAGAR]]));
    const ifsc = value(result, 'bank.ifsc')!;
    expect(ifsc).toMatchObject({ value: 'ZZZZ0000123', line: 9, evidence: 'ZZZZ000123 MICR CODE:572052123', verified: false, suggestChecked: false });
    expect(ifsc.correction).toBe(
      'Read as ZZZZ000123, a character short. RBI’s list has one Sample Bank branch it can be: ZZZZ0000123, its NEHRU NAGAR branch, in Samplepura.',
    );
    // What the list knows comes with it, as for any code the list has.
    expect(value(result, 'bank.branch')).toMatchObject({ value: 'NEHRU NAGAR', listed: { list: 'ifsc', code: 'ZZZZ0000123' } });
    expect(result.warnings).toEqual([]);
  });

  it('chooses among several only by the branch printed on the document', () => {
    const lines = ['Sample Bank Ltd.', 'SAMPLEPURT-NIHRUNAGAR', 'ZZZZ000123 MICR CODE:572052123'];
    const result = checkAgainstReference(missed(), near(['ZZZZ000123', [NEHRU_NAGAR, STATION_ROAD]]), lines);
    expect(value(result, 'bank.ifsc')?.value).toBe('ZZZZ0000123');
    expect(value(result, 'bank.ifsc')?.correction).toBe(
      'Read as ZZZZ000123, a character short. RBI’s list has 2 Sample Bank branches it can be; ZZZZ0000123, its NEHRU NAGAR branch, in Samplepura, is the one printed on this document.',
    );
    expect(value(result, 'bank.ifsc')?.agreement).toMatch(/— the branch printed on this document \(“SAMPLEPURT-NIHRUNAGAR”\)\.$/);
  });

  it('chooses nothing among several the document does not settle, and says why', () => {
    const result = checkAgainstReference(missed(), near(['ZZZZ000123', [NEHRU_NAGAR, STATION_ROAD]]));
    expect(value(result, 'bank.ifsc')).toBeUndefined();
    expect(result.warnings).toEqual([
      'The IFSC was read as ZZZZ000123, a character short, and RBI’s list has 2 Sample Bank branches it could be. Check it against the passbook or a cheque, and type it in.',
    ]);
  });

  it('says the code read is a character short when the list has nothing it can be, or was not asked', () => {
    expect(checkAgainstReference(missed(), near(['ZZZZ000123', []])).warnings).toEqual([
      'The IFSC was read as ZZZZ000123, a character short, and RBI’s list has no branch it can be. Check it against the passbook or a cheque, and type it in.',
    ]);
    expect(checkAgainstReference(missed(), near()).warnings).toEqual([
      'The IFSC was read as ZZZZ000123, a character short. Check it against the passbook or a cheque, and type it in.',
    ]);
  });

  it('says when the MICR code printed is not the one RBI’s list gives the branch, and keeps the printed one', () => {
    const result = checkAgainstReference(missed(), near(['ZZZZ000123', [NEHRU_NAGAR]]));
    expect(result.notes).toContain('RBI’s list gives ZZZZ0000123 the MICR code 572052103; this document prints 572052123.');
    expect(value(result, 'bank.micr')?.value).toBe('572052123');
  });

  it('asks the list for the codes a near miss can be', async () => {
    const asked: string[] = [];
    const found = await lookUp(missed(), {
      ifsc: async () => null,
      ifscNear: async (code) => {
        asked.push(code);
        return [NEHRU_NAGAR];
      },
      pincode: async () => null,
    });
    expect(asked).toEqual(['ZZZZ000123']);
    expect(found.near?.get('ZZZZ000123')).toEqual([NEHRU_NAGAR]);
  });
});

describe('a PIN, against India Post’s directory', () => {
  it('fills the district and state a form asks beside it', () => {
    const result = checkAgainstReference(reading(read('address.permanent.pincode', '560001', 7)), finds([], [['560001', GPO]]));
    const listed = { list: 'pincode', code: '560001' };
    expect(value(result, 'address.permanent.district')).toMatchObject({ value: 'Bengaluru', line: 7, listed, suggestChecked: false });
    expect(value(result, 'address.permanent.state')).toMatchObject({ value: 'Karnataka', listed });
    expect(value(result, 'address.permanent.state')?.evidence).toBe('India Post’s PIN directory: 560001');
  });

  it('never ticks a PIN or says it agrees: a PIN misread in its last digit is its neighbour, in the same district', () => {
    const result = checkAgainstReference(
      reading(read('address.permanent.pincode', '560001'), read('address.permanent.district', 'Bengaluru Urban'), read('address.permanent.state', 'KARNATAKA')),
      finds([], [['560001', GPO]]),
    );
    expect(value(result, 'address.permanent.pincode')).toMatchObject({ verified: false, suggestChecked: false });
    expect(value(result, 'address.permanent.pincode')?.agreement).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it('warns when the state printed is another one, and adds nothing', () => {
    const result = checkAgainstReference(
      reading(read('address.permanent.pincode', '560001'), read('address.permanent.state', 'Tamil Nadu')),
      finds([], [['560001', GPO]]),
    );
    expect(result.warnings.join(' ')).toMatch(/560001 is in Karnataka.*"Tamil Nadu"/);
    expect(value(result, 'address.permanent.district')).toBeUndefined();
  });

  it('chooses no district for a PIN that covers two, and says which', () => {
    const border: PinRecord = { pin: '560999', states: ['Karnataka'], districts: ['Bengaluru Urban', 'Ramanagara'], offices: [] };
    const result = checkAgainstReference(reading(read('address.permanent.pincode', '560999')), finds([], [['560999', border]]));
    expect(value(result, 'address.permanent.district')).toBeUndefined();
    expect(value(result, 'address.permanent.state')?.value).toBe('Karnataka');
    expect(result.notes.join(' ')).toMatch(/Bengaluru Urban and Ramanagara/);
  });

  it('warns of a PIN the directory does not have', () => {
    const result = checkAgainstReference(reading(read('address.correspondence.pincode', '560002')), finds([], [['560002', null]]));
    expect(result.warnings.join(' ')).toMatch(/560002 is not in India Post’s PIN directory/);
  });
});

describe('a reading with nothing to check', () => {
  it('comes back as it went in', () => {
    const plain = reading(read('identity.full_name', 'ARJUN MEHTA'));
    expect(checkAgainstReference(plain, finds())).toEqual(plain);
  });
});
