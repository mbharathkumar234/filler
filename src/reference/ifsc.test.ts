import { describe, expect, it } from 'vitest';

import { compactIfsc, formerBanks, ifscRecord, isIfsc, mergedBank, nearCodes, type RawBranch } from './ifsc';
import { canonicalState, placeName } from './places';

/*
 * Rows as razorpay/ifsc publishes them (`by-bank/<BANK>.json`), cut down to
 * the fields read here. The two State Bank branches are real public branch
 * codes — an IFSC is the address of a bank branch, not anyone's detail.
 */
const SBIN: Record<string, RawBranch> = {
  SBIN0000001: {
    BANK: 'State Bank of India',
    IFSC: 'SBIN0000001',
    MICR: '700002021',
    BRANCH: 'KOLKATA MAIN',
    ADDRESS: 'SAMRIDDHI BHAWAN, 1 STRAND ROAD, KOLKATA 700 001',
    CITY: 'KOLKATA',
    DISTRICT: 'KOLKATA',
    STATE: 'WEST BENGAL',
  },
  SBIN0000002: {
    BANK: 'State Bank of India',
    IFSC: 'SBIN0000002',
    MICR: null,
    BRANCH: 'SAMPLE ROAD',
    ADDRESS: '2 SAMPLE ROAD',
    CITY: 'SAMPLEPURA',
    DISTRICT: 'SAMPLEPURA',
    // As the published data spells it, once.
    STATE: 'ODHISA',
  },
};
const ZZZZ: Record<string, RawBranch> = {
  ZZZZ0ABC123: {
    BANK: 'Sample Co-operative Bank',
    IFSC: 'ZZZZ0ABC123',
    MICR: '560999001',
    BRANCH: 'MAIN',
    ADDRESS: '1 MAIN ROAD',
    CITY: 'BENGALURU',
    DISTRICT: 'BENGALURU URBAN',
    STATE: 'KARNATAKA',
  },
};

describe('the shape of an IFSC', () => {
  it('is four letters, a zero, then six letters or digits', () => {
    expect(isIfsc('SBIN0000001')).toBe(true);
    expect(isIfsc('ZZZZ0ABC123')).toBe(true);
    for (const code of ['SBIN1000001', 'SBI00000001', 'sbin0000001', 'SBIN000001', 'SBIN00000011', '']) {
      expect(isIfsc(code), code).toBe(false);
    }
  });
});

describe('RBI’s list, packed for the extension', () => {
  const { index, shards } = compactIfsc({ SBIN, ZZZZ }, 'razorpay/ifsc v2.0.62');

  it('names every bank once, and packs each bank’s branches apart', () => {
    expect(index.banks).toEqual({ SBIN: 'State Bank of India', ZZZZ: 'Sample Co-operative Bank' });
    expect(index.source).toBe('razorpay/ifsc v2.0.62');
    expect(Object.keys(shards).sort()).toEqual(['SBIN', 'ZZZZ']);
    expect(Object.keys(shards.SBIN!).sort()).toEqual(['000001', '000002']);
  });

  it('gives back a branch whole from its code', () => {
    expect(ifscRecord(index, shards.SBIN!, 'SBIN0000001')).toEqual({
      ifsc: 'SBIN0000001',
      bank: 'State Bank of India',
      branch: 'KOLKATA MAIN',
      address: 'SAMRIDDHI BHAWAN, 1 STRAND ROAD, KOLKATA 700 001',
      city: 'Kolkata',
      district: 'Kolkata',
      state: 'West Bengal',
      micr: '700002021',
    });
  });

  it('puts right the published data’s own misspellings, and leaves a missing MICR empty', () => {
    const branch = ifscRecord(index, shards.SBIN!, 'SBIN0000002')!;
    expect(branch.state).toBe('Odisha');
    expect(branch.micr).toBe('');
  });

  it('finds nothing for a code that is not in the list, or not an IFSC at all', () => {
    expect(ifscRecord(index, shards.SBIN!, 'SBIN0999999')).toBeNull();
    expect(ifscRecord(index, shards.SBIN!, 'ZZZZ0ABC123')).toBeNull();
    expect(ifscRecord(index, shards.SBIN!, 'not an ifsc')).toBeNull();
  });

  it('keeps none of the list’s placeholders: "NA" is no address and "Na" no district', () => {
    const packed = compactIfsc(
      { ZZZZ: { ZZZZ0000IMP: { BANK: 'Sample Bank', BRANCH: 'Sample Bank IMPS', ADDRESS: 'NA', CITY: 'Mumbai', DISTRICT: 'Na', STATE: 'N/A', MICR: 'NA' } } },
      'test',
    );
    expect(ifscRecord(packed.index, packed.shards.ZZZZ!, 'ZZZZ0000IMP')).toMatchObject({ address: '', district: '', state: '', micr: '' });
  });
});

describe('an IFSC read a character short or long', () => {
  /*
   * On the user's own passbook an IFSC with four noughts in a row was read a
   * nought short, too small in the photo to tell apart. Of the bank's thousand
   * branches, one became that when a character was dropped.
   */
  const { index, shards } = compactIfsc(
    {
      ZZZZ: {
        ZZZZ0000123: { BANK: 'Sample Bank', BRANCH: 'NEHRU NAGAR', CITY: 'SAMPLEPURA', DISTRICT: 'SAMPLEPURA', STATE: 'KARNATAKA' },
        ZZZZ0000124: { BANK: 'Sample Bank', BRANCH: 'MAIN ROAD', CITY: 'SAMPLEPURA', DISTRICT: 'SAMPLEPURA', STATE: 'KARNATAKA' },
        ZZZZ0001230: { BANK: 'Sample Bank', BRANCH: 'STATION ROAD', CITY: 'SAMPLEPURA', DISTRICT: 'SAMPLEPURA', STATE: 'KARNATAKA' },
      },
    },
    'test',
  );
  const near = (read: string) => nearCodes(index, shards.ZZZZ!, read).map((record) => record.ifsc);

  it('finds the one branch a dropped character leaves', () => {
    expect(near('ZZZZ000124')).toEqual(['ZZZZ0000124']);
  });

  it('finds every branch it could be, and leaves the choosing to whoever asks', () => {
    expect(near('ZZZZ000123').sort()).toEqual(['ZZZZ0000123', 'ZZZZ0001230']);
  });

  it('finds the branch a character too many leaves too', () => {
    expect(near('ZZZZ00001244')).toEqual(['ZZZZ0000124']);
  });

  it('finds nothing two characters away, nor for another bank', () => {
    expect(near('ZZZZ00024')).toEqual([]);
    expect(near('YYYY000124')).toEqual([]);
    expect(near('not a code')).toEqual([]);
  });
});

describe('banks that merged into others', () => {
  it('names the bank an old code belonged to, and the bank that took it over', () => {
    expect(mergedBank('SYNB0001234')).toEqual({ name: 'Syndicate Bank', into: 'Canara Bank', intoCode: 'CNRB' });
    expect(mergedBank('SBMY0040123')).toEqual({ name: 'State Bank of Mysore', into: 'State Bank of India', intoCode: 'SBIN' });
    expect(mergedBank('BKDN0110001')).toEqual({ name: 'Dena Bank', into: 'Bank of Baroda', intoCode: 'BARB' });
  });

  it('knows nothing of a bank that still has its own codes', () => {
    expect(mergedBank('SBIN0000001')).toBeNull();
    expect(mergedBank('CNRB0000492')).toBeNull();
    expect(mergedBank('not an ifsc')).toBeNull();
  });

  it('knows the names a bank’s passbooks were printed under before a merger', () => {
    expect(formerBanks('CNRB0000492')).toEqual(['Syndicate Bank']);
    expect(formerBanks('UBIN0531234')).toEqual(['Andhra Bank', 'Corporation Bank']);
    expect(formerBanks('KARB0000001')).toEqual([]);
  });
});

describe('place names', () => {
  it.each([
    ['WEST BENGAL', 'West Bengal'],
    ['ODHISA', 'Odisha'],
    ['ORISSA', 'Odisha'],
    ['MADHY PRADESH', 'Madhya Pradesh'],
    ['DADAR AND NAGAR HAVELI', 'Dadra and Nagar Haveli and Daman and Diu'],
    ['DAMAN AND DIU', 'Dadra and Nagar Haveli and Daman and Diu'],
    ['JAMMU & KASHMIR', 'Jammu and Kashmir'],
    ['PONDICHERRY', 'Puducherry'],
    ['NCT OF DELHI', 'Delhi'],
    ['UTTARKHAND', 'Uttarakhand'],
    ['THE DADRA AND NAGAR HAVELI AND DAMAN AND DIU', 'Dadra and Nagar Haveli and Daman and Diu'],
    // A city and a district printed where the state belongs, in RBI's list.
    ['LUDHIANA', 'Punjab'],
    ['DAKSHIN KANNAD', 'Karnataka'],
  ])('writes the state %s as %s', (raw, canonical) => {
    expect(canonicalState(raw)).toBe(canonical);
  });

  it('leaves an unknown state as printed rather than guess', () => {
    expect(canonicalState('SAMPLE STATE')).toBe('SAMPLE STATE');
    expect(canonicalState('')).toBe('');
  });

  it('writes a district in capitals and small letters, its initials as printed', () => {
    expect(placeName('BENGALURU URBAN')).toBe('Bengaluru Urban');
    expect(placeName('Y.S.R.')).toBe('Y.S.R.');
    expect(placeName('SRI POTTI SRIRAMULU NELLORE')).toBe('Sri Potti Sriramulu Nellore');
    expect(placeName('DAKSHIN BASTAR DANTEWADA')).toBe('Dakshin Bastar Dantewada');
  });
});
