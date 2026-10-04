import { describe, expect, it } from 'vitest';

import { compactPincodes, parseCsv, pinRecord } from './pincode';

/*
 * The directory as India Post publishes it on data.gov.in, a few rows of it.
 * Two offices share one PIN; one PIN spans two districts, as a few do.
 */
const CSV = [
  '"CircleName","RegionName","DivisionName","OfficeName","Pincode","OfficeType","Delivery","District","StateName","Latitude","Longitude"',
  '"Andhra Pradesh Circle","Kurnool Region","Hindupur Division","Peddakotla B.O","515631","BO","Delivery","ANANTAPUR","ANDHRA PRADESH","14.5689","77.85624"',
  '"Andhra Pradesh Circle","Kurnool Region","Hindupur Division","Pinnadhari B.O","515631","BO","Delivery","ANANTAPUR","ANDHRA PRADESH","14.5281","77.857014"',
  '"Karnataka Circle","Bangalore HQ Region","Bangalore GPO Division","Bangalore G.P.O.","560001","HO","Delivery","BENGALURU","KARNATAKA","12.98","77.59"',
  '"Karnataka Circle","Bangalore HQ Region","Sample Division","Border S.O","560999","SO","Delivery","BENGALURU URBAN","KARNATAKA","",""',
  '"Karnataka Circle","Bangalore HQ Region","Sample Division","Border, East B.O","560999","BO","Non-Delivery","RAMANAGARA","KARNATAKA","",""',
].join('\n');

describe('reading India Post’s CSV', () => {
  it('splits rows and cells, quotes and commas inside them included', () => {
    const rows = parseCsv(CSV);
    expect(rows).toHaveLength(6);
    expect(rows[5]![3]).toBe('Border, East B.O');
    expect(rows[1]![4]).toBe('515631');
  });
});

describe('the PIN directory, packed for the extension', () => {
  const table = compactPincodes(CSV, 'data.gov.in, October 2026');

  it('gives a PIN its state, its districts and its post offices', () => {
    expect(pinRecord(table, '515631')).toEqual({
      pin: '515631',
      states: ['Andhra Pradesh'],
      districts: ['Anantapur'],
      offices: ['Peddakotla B.O', 'Pinnadhari B.O'],
    });
  });

  it('keeps both districts of a PIN that spans two', () => {
    expect(pinRecord(table, '560999')!.districts).toEqual(['Bengaluru Urban', 'Ramanagara']);
  });

  it('finds nothing for a PIN the directory does not have, or a value that is not a PIN', () => {
    expect(pinRecord(table, '560002')).toBeNull();
    expect(pinRecord(table, '56001')).toBeNull();
    expect(pinRecord(table, '060001')).toBeNull();
  });

  it('says where it came from', () => {
    expect(table.source).toBe('data.gov.in, October 2026');
  });

  it('refuses a file that is not the directory, rather than pack nothing', () => {
    expect(() => compactPincodes('"Name","Value"\n"a","b"', 'x')).toThrow(/Pincode/);
  });
});
