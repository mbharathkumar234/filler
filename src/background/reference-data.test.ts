import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { compactIfsc } from '@/reference/ifsc';
import { compactPincodes } from '@/reference/pincode';
import { createReferenceLookup, handleReferenceRequest } from './reference-data';

/**
 * The lists as the build packs them, read back the way the extension reads its
 * own files: one bank at a time, unzipped by the browser, kept once opened.
 */
const { index, shards } = compactIfsc(
  {
    SBIN: {
      SBIN0000001: { BANK: 'State Bank of India', IFSC: 'SBIN0000001', MICR: '700002021', BRANCH: 'KOLKATA MAIN', ADDRESS: '1 STRAND ROAD', CITY: 'KOLKATA', DISTRICT: 'KOLKATA', STATE: 'WEST BENGAL' },
    },
    CNRB: {
      CNRB0000001: { BANK: 'Canara Bank', IFSC: 'CNRB0000001', MICR: '560015001', BRANCH: 'SAMPLE ROAD', ADDRESS: '1 SAMPLE ROAD', CITY: 'BENGALURU', DISTRICT: 'BENGALURU URBAN', STATE: 'KARNATAKA' },
    },
  },
  'test',
);
const PINS = compactPincodes(
  '"OfficeName","Pincode","District","StateName"\n"Bangalore G.P.O.","560001","BENGALURU","KARNATAKA"\n',
  'test',
);

function packaged() {
  const files = new Map<string, Uint8Array>([
    ['ifsc/index.json', new TextEncoder().encode(JSON.stringify(index))],
    ['ifsc/SBIN.json.gz', gzipSync(JSON.stringify(shards.SBIN))],
    ['ifsc/CNRB.json.gz', gzipSync(JSON.stringify(shards.CNRB))],
    ['pincode.json.gz', gzipSync(JSON.stringify(PINS))],
  ]);
  const opened: string[] = [];
  const load = async (path: string) => {
    opened.push(path);
    return files.get(path) ?? null;
  };
  return { load, opened, files };
}

describe('looking a code up in the packaged lists', () => {
  it('finds a branch, opening only its own bank', async () => {
    const { load, opened } = packaged();
    const lookup = createReferenceLookup(load);
    expect(await lookup.ifsc('SBIN0000001')).toMatchObject({ bank: 'State Bank of India', branch: 'KOLKATA MAIN', micr: '700002021' });
    expect(opened).toEqual(['ifsc/index.json', 'ifsc/SBIN.json.gz']);
  });

  it('opens each file once, however often it is asked', async () => {
    const { load, opened } = packaged();
    const lookup = createReferenceLookup(load);
    await lookup.ifsc('SBIN0000001');
    await lookup.ifsc('SBIN0000002');
    await lookup.pincode('560001');
    await lookup.pincode('560002');
    expect(opened).toEqual(['ifsc/index.json', 'ifsc/SBIN.json.gz', 'pincode.json.gz']);
  });

  it('says a code is not in the list: an unknown branch, an unknown bank, or no IFSC at all', async () => {
    const { load, opened } = packaged();
    const lookup = createReferenceLookup(load);
    expect(await lookup.ifsc('SBIN0999999')).toBeNull();
    expect(await lookup.ifsc('ZZZZ0000001')).toBeNull();
    expect(await lookup.ifsc('not an ifsc')).toBeNull();
    // A bank the list does not have is answered from the index alone.
    expect(opened).toEqual(['ifsc/index.json', 'ifsc/SBIN.json.gz']);
  });

  it('finds the branches a code read a character short can be, opening only that bank', async () => {
    const { load, opened } = packaged();
    const lookup = createReferenceLookup(load);
    expect((await lookup.ifscNear!('SBIN000001')).map((record) => record.ifsc)).toEqual(['SBIN0000001']);
    expect(await lookup.ifscNear!('ZZZZ000001')).toEqual([]);
    expect(opened).toEqual(['ifsc/index.json', 'ifsc/SBIN.json.gz']);
  });

  it('finds a PIN’s places, and nothing for a PIN the directory does not have', async () => {
    const lookup = createReferenceLookup(packaged().load);
    expect(await lookup.pincode('560001')).toEqual({
      pin: '560001',
      states: ['Karnataka'],
      districts: ['Bengaluru'],
      offices: ['Bangalore G.P.O.'],
    });
    expect(await lookup.pincode('560002')).toBeNull();
    expect(await lookup.pincode('12345')).toBeNull();
  });

  it('fails, rather than answer "not in the list", when the build has no lists — and tries again next time', async () => {
    const { load, files } = packaged();
    files.delete('ifsc/index.json');
    files.delete('pincode.json.gz');
    const lookup = createReferenceLookup(load);
    await expect(lookup.ifsc('SBIN0000001')).rejects.toThrow(/IFSC list/);
    await expect(lookup.pincode('560001')).rejects.toThrow(/PIN directory/);
    files.set('pincode.json.gz', gzipSync(JSON.stringify(PINS)));
    expect(await lookup.pincode('560001')).not.toBeNull();
  });
});

describe('the vault editor’s lookups', () => {
  it('answers with the branch or the PIN’s places', async () => {
    const lookup = createReferenceLookup(packaged().load);
    expect(await handleReferenceRequest({ type: 'ref:ifsc', code: 'SBIN0000001' }, lookup)).toMatchObject({
      ok: true,
      data: { branch: 'KOLKATA MAIN', micr: '700002021' },
    });
    expect(await handleReferenceRequest({ type: 'ref:pincode', pin: '560001' }, lookup)).toMatchObject({
      ok: true,
      data: { states: ['Karnataka'] },
    });
  });

  it('answers null for a code the list does not have', async () => {
    const lookup = createReferenceLookup(packaged().load);
    expect(await handleReferenceRequest({ type: 'ref:ifsc', code: 'SBIN0999999' }, lookup)).toEqual({ ok: true, data: null });
  });

  it('fails, rather than answer "not listed", when the build has no lists', async () => {
    const lookup = createReferenceLookup(async () => null);
    const answer = await handleReferenceRequest({ type: 'ref:pincode', pin: '560001' }, lookup);
    expect(answer.ok).toBe(false);
  });
});
