import { describe, expect, it } from 'vitest';

import type { FieldKey } from '@/matching/taxonomy';
import type { IfscRecord } from '@/reference/ifsc';
import type { PinRecord } from '@/reference/pincode';
import { codeToLookUp, offerFor } from './reference-offer';

/* A real public branch code and a real public PIN: neither is anyone's detail. */
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
const GPO: PinRecord = { pin: '560001', states: ['Karnataka'], districts: ['Bengaluru'], offices: ['Bangalore G.P.O.'] };

const vault = (...entries: Array<[FieldKey, string]>) => new Map<FieldKey, string>(entries);

describe('which saved values are looked up', () => {
  it('an IFSC, however it was typed', () => {
    expect(codeToLookUp('bank.ifsc', ' sbin0000001 ')).toEqual({ list: 'ifsc', code: 'SBIN0000001' });
  });

  it('a PIN, with or without its space', () => {
    expect(codeToLookUp('address.permanent.pincode', '560 001')).toEqual({ list: 'pincode', code: '560001' });
    expect(codeToLookUp('address.correspondence.pincode', '560001')).toEqual({ list: 'pincode', code: '560001' });
  });

  it('nothing else, and nothing that is not a code', () => {
    expect(codeToLookUp('bank.account_number', '30123456789')).toBeNull();
    expect(codeToLookUp('bank.ifsc', 'SBIN000001')).toBeNull();
    expect(codeToLookUp('address.permanent.pincode', '')).toBeNull();
  });
});

describe('an IFSC the list has', () => {
  const looked = { list: 'ifsc', key: 'bank.ifsc', code: 'SBIN0000001', record: KOLKATA_MAIN } as const;

  it('says which branch it is, and offers its bank, branch, MICR code and address', () => {
    const offer = offerFor(looked, vault(['bank.ifsc', 'SBIN0000001']));
    expect(offer.message).toBe('RBI’s list has SBIN0000001 as State Bank of India’s KOLKATA MAIN branch, in Kolkata.');
    expect(offer.found).toBe(true);
    expect(offer.fills).toEqual([
      ['bank.bank_name', 'State Bank of India'],
      ['bank.branch', 'KOLKATA MAIN'],
      ['bank.micr', '700002021'],
      ['bank.branch_address', 'SAMRIDDHI BHAWAN, 1 STRAND ROAD, KOLKATA 700 001'],
    ]);
  });

  it('never offers over anything the user typed', () => {
    const offer = offerFor(looked, vault(['bank.bank_name', 'SBI'], ['bank.branch', 'Kolkata Main']));
    expect(offer.fills.map(([key]) => key)).toEqual(['bank.micr', 'bank.branch_address']);
  });

  it('offers no MICR code the list does not have', () => {
    const offer = offerFor({ ...looked, record: { ...KOLKATA_MAIN, micr: '' } }, vault());
    expect(offer.fills.map(([key]) => key)).not.toContain('bank.micr');
  });
});

describe('an IFSC the list does not have', () => {
  it('says so, and offers nothing', () => {
    const offer = offerFor({ list: 'ifsc', key: 'bank.ifsc', code: 'SBIN0999999', record: null }, vault());
    expect(offer).toEqual({
      message: 'SBIN0999999 is not in RBI’s list of IFSC codes. Check it against your passbook or a cheque.',
      found: false,
      fills: [],
    });
  });

  it('says an old bank’s code is out of date, not mistyped', () => {
    const offer = offerFor({ list: 'ifsc', key: 'bank.ifsc', code: 'SYNB0001234', record: null }, vault());
    expect(offer.message).toMatch(/^SYNB0001234 is a Syndicate Bank code\. Syndicate Bank merged into Canara Bank/);
  });
});

describe('a PIN the directory has', () => {
  const looked = { list: 'pincode', key: 'address.permanent.pincode', code: '560001', record: GPO } as const;

  it('says where it is, and offers the district and state beside it', () => {
    const offer = offerFor(looked, vault());
    expect(offer.message).toBe('India Post’s PIN directory has 560001 in Bengaluru, Karnataka.');
    expect(offer.fills).toEqual([
      ['address.permanent.district', 'Bengaluru'],
      ['address.permanent.state', 'Karnataka'],
    ]);
  });

  it('fills the address the PIN was saved in, not the other one', () => {
    const offer = offerFor({ ...looked, key: 'address.correspondence.pincode' }, vault());
    expect(offer.fills.map(([key]) => key)).toEqual(['address.correspondence.district', 'address.correspondence.state']);
  });

  it('says so when the state already saved is another one', () => {
    const offer = offerFor(looked, vault(['address.permanent.state', 'Tamil Nadu']));
    expect(offer.message).toBe(
      'India Post’s PIN directory has 560001 in Bengaluru, Karnataka. The state saved here is “Tamil Nadu” — one of the two is wrong.',
    );
    expect(offer.fills).toEqual([['address.permanent.district', 'Bengaluru']]);
  });

  it('leaves the district to the user when the PIN covers two', () => {
    const border: PinRecord = { pin: '560999', states: ['Karnataka'], districts: ['Bengaluru Urban', 'Ramanagara'], offices: [] };
    const offer = offerFor({ ...looked, code: '560999', record: border }, vault());
    expect(offer.message).toBe('India Post’s PIN directory has 560999 in Bengaluru Urban and Ramanagara, Karnataka — choose the district yourself.');
    expect(offer.fills).toEqual([['address.permanent.state', 'Karnataka']]);
  });
});

describe('a PIN the directory does not have', () => {
  it('says so, and offers nothing', () => {
    const offer = offerFor({ list: 'pincode', key: 'address.permanent.pincode', code: '560002', record: null }, vault());
    expect(offer).toEqual({
      message: 'PIN 560002 is not in India Post’s PIN directory of 2020. Check it against a letter sent to this address.',
      found: false,
      fills: [],
    });
  });
});
