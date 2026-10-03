import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteDB } from 'idb';
import { DB_NAME, DB_VERSION, closeVaultDb, openVaultDb, type VaultDb } from './db';
import { deriveKey, newSalt, type KdfParams } from './crypto';
import {
  clearVariants,
  countVariants,
  deleteMaster,
  getCachedVariant,
  getMaster,
  getMasterByKey,
  listMasters,
  putMaster,
  putVariant,
  VARIANT_RECIPE,
  variantId,
} from './document-store';
import { parseConstraint } from '@/documents/constraints';

/**
 * Cheap Argon2id parameters for setup.
 *
 * Not `{ ...newKdfParams(), iterations: 1_000 }`. That spread was correct while
 * the default KDF was PBKDF2, where a thousand iterations is fast; when Phase
 * 10 made Argon2id the default it silently became a thousand passes over
 * 64 MiB — minutes per key, and enough to kill the test worker. The shipped
 * parameters are asserted in `kdf-migration.test.ts`; these exist only so the
 * suite is not itself a proof-of-work.
 */
const TEST_KDF = {
  name: 'Argon2id',
  memoryKiB: 1_024,
  iterations: 1,
  parallelism: 1,
} as const;

let db: VaultDb;
let key: CryptoKey;
let kdf: KdfParams;

const PHOTO = new Uint8Array(2048).fill(0x42);
const META = { mime: 'image/jpeg', bytes: 2048, width: 3024, height: 4032, capturedAt: '2026-08-25T00:00:00Z' };

beforeEach(async () => {
  await closeVaultDb();
  await deleteDB(DB_NAME);
  db = await openVaultDb();
  kdf = { ...TEST_KDF, salt: newSalt() };
  key = await deriveKey('correct horse battery staple', kdf);
});

afterEach(async () => {
  await closeVaultDb();
});

describe('schema migration', () => {
  it('opens at the current version with every store present', () => {
    // v1 profile + meta, v2 documents + variants, v3 sealed settings (the
    // Phase 8 API key). Listed in full so a migration that forgets a store
    // fails here rather than at the first read.
    expect(db.version).toBe(DB_VERSION);
    expect([...db.objectStoreNames].sort()).toEqual([
      'documents',
      'meta',
      'profile',
      'settings',
      'variants',
    ]);
  });
});

describe('masters', () => {
  it('stores and reads back a master', async () => {
    const summary = await putMaster(db, key, {
      key: 'doc.photo',
      label: 'Passport photo',
      bytes: PHOTO,
      meta: META,
    });

    const loaded = await getMaster(db, key, summary.id);
    expect(loaded?.bytes).toEqual(PHOTO);
    expect(loaded?.meta.width).toBe(3024);
    expect(loaded?.meta.key).toBe('doc.photo');
  });

  it('looks a master up by taxonomy key', async () => {
    await putMaster(db, key, { key: 'doc.signature', label: 'Signature', bytes: PHOTO, meta: META });
    const found = await getMasterByKey(db, key, 'doc.signature');
    expect(found?.label).toBe('Signature');
  });

  it('refuses a non-document taxonomy key', async () => {
    await expect(
      putMaster(db, key, {
        key: 'identity.full_name',
        label: 'nope',
        bytes: PHOTO,
        meta: META,
      }),
    ).rejects.toThrow(/not a document key/i);
  });

  it('keeps one master per key, replacing the old one', async () => {
    await putMaster(db, key, { key: 'doc.photo', label: 'First', bytes: PHOTO, meta: META });
    await putMaster(db, key, { key: 'doc.photo', label: 'Second', bytes: PHOTO, meta: META });

    const masters = await listMasters(db);
    expect(masters).toHaveLength(1);
    expect(masters[0]?.label).toBe('Second');
  });

  it('lists masters in a stable order', async () => {
    await putMaster(db, key, { key: 'doc.signature', label: 'Sig', bytes: PHOTO, meta: META });
    await putMaster(db, key, { key: 'doc.photo', label: 'Photo', bytes: PHOTO, meta: META });
    expect((await listMasters(db)).map((m) => m.key)).toEqual(['doc.photo', 'doc.signature']);
  });

  it('stores no plaintext bytes and no filename at rest', async () => {
    const marker = new TextEncoder().encode('DOCUMENT-CANARY-PAYLOAD');
    await putMaster(db, key, {
      key: 'doc.aadhaar_card',
      label: 'Aadhaar card',
      bytes: marker,
      meta: { ...META, bytes: marker.length },
    });

    const raw = JSON.stringify(await db.getAll('documents'), (_k, v: unknown) =>
      v instanceof Uint8Array ? Array.from(v) : v,
    );
    expect(raw).not.toContain('DOCUMENT-CANARY-PAYLOAD');
    // The schema has no filename field at all — nothing to leak.
    expect(raw).not.toMatch(/\.jpg|\.jpeg|\.pdf|filename/i);
  });
});

describe('a PDF that opens with a password', () => {
  /*
   * An e-Aadhaar is downloaded locked. The user types its password once, when
   * they save it; it is kept with the document, sealed like the document, so
   * every later reading and every portal copy can open it without asking again.
   * The vault's own passphrase guards both: the key is kept in the same safe as
   * the box it opens, never beside it in the clear.
   */
  const LOCKED = new TextEncoder().encode('%PDF-1.7 locked stand-in');
  const PDF_META = { mime: 'application/pdf', bytes: LOCKED.length, width: 0, height: 0, capturedAt: '2026-08-25T00:00:00Z' };
  const save = (password?: string) =>
    putMaster(db, key, {
      key: 'doc.aadhaar_card',
      label: 'Aadhaar card',
      bytes: LOCKED,
      meta: PDF_META,
      ...(password === undefined ? {} : { password }),
    });

  it('gives the password back with the document', async () => {
    const summary = await save('RAVI1998');
    expect((await getMaster(db, key, summary.id))?.password).toBe('RAVI1998');
    expect((await getMasterByKey(db, key, 'doc.aadhaar_card'))?.password).toBe('RAVI1998');
  });

  it('says the document is locked, without saying with what', async () => {
    const summary = await save('RAVI1998');
    expect(summary.locked).toBe(true);
    expect((await listMasters(db))[0]?.locked).toBe(true);
    expect(JSON.stringify(await listMasters(db))).not.toContain('RAVI1998');
  });

  it('never keeps the password in the clear', async () => {
    await save('PASSWORD-CANARY-1998');
    const raw = JSON.stringify(await db.getAll('documents'), (_k, v: unknown) =>
      v instanceof Uint8Array ? new TextDecoder().decode(v) + Array.from(v).join(',') : v,
    );
    expect(raw).not.toContain('PASSWORD-CANARY');
  });

  it('forgets the password when the slot gets a document that needs none', async () => {
    await save('RAVI1998');
    const replaced = await putMaster(db, key, {
      key: 'doc.aadhaar_card',
      label: 'Aadhaar card',
      bytes: PHOTO,
      meta: META,
    });
    expect(replaced.locked).toBeUndefined();
    expect((await getMaster(db, key, replaced.id))?.password).toBeUndefined();
  });

  it('says nothing about a password for a document that never had one', async () => {
    const summary = await putMaster(db, key, { key: 'doc.photo', label: 'Photo', bytes: PHOTO, meta: META });
    expect(summary.locked).toBeUndefined();
    expect((await getMaster(db, key, summary.id))?.password).toBeUndefined();
  });
});

describe('variant cache', () => {
  const { constraint } = parseConstraint('JPEG, 20 KB to 50 KB, 3.5 cm × 4.5 cm');
  const VARIANT = new Uint8Array(30 * 1024).fill(0x7f);
  const VARIANT_META = { mime: 'image/jpeg', bytes: VARIANT.length, width: 276, height: 354, capturedAt: '2026-08-25T00:00:00Z' };

  it('misses before anything is cached', async () => {
    const master = await putMaster(db, key, {
      key: 'doc.photo',
      label: 'Photo',
      bytes: PHOTO,
      meta: META,
    });
    await expect(getCachedVariant(db, key, master.id, constraint)).resolves.toBeUndefined();
  });

  it('hits after a variant is stored', async () => {
    const master = await putMaster(db, key, {
      key: 'doc.photo',
      label: 'Photo',
      bytes: PHOTO,
      meta: META,
    });
    await putVariant(db, key, master.id, 'doc.photo', constraint, VARIANT, VARIANT_META);

    const hit = await getCachedVariant(db, key, master.id, constraint);
    expect(hit?.bytes).toEqual(VARIANT);
    expect(hit?.meta.width).toBe(276);
  });

  it('shares a cache entry between portals that state the same rules differently', async () => {
    const a = parseConstraint('Photograph must be JPEG/JPG, 20 KB to 50 KB, 3.5 cm × 4.5 cm.');
    const b = parseConstraint('Photo: JPG, file size 20KB-50KB, width 3.5 cm, height 4.5 cm');

    expect(await variantId('m1', a.constraint)).toBe(await variantId('m1', b.constraint));
  });

  it('does not share a cache entry across different constraints', async () => {
    const a = parseConstraint('JPEG, 20 KB to 50 KB, 3.5 cm × 4.5 cm');
    const b = parseConstraint('JPEG, 20 KB to 50 KB, 3.5 cm × 4.5 cm, 300 dpi');
    expect(await variantId('m1', a.constraint)).not.toBe(await variantId('m1', b.constraint));
  });

  it('does not share a cache entry across different masters', async () => {
    expect(await variantId('m1', constraint)).not.toBe(await variantId('m2', constraint));
  });

  it('never serves a copy made the way copies used to be made', async () => {
    // Until documents were padded to a portal's shape, a bank passbook asked for
    // at 3.5 x 4.5 cm was cut down the middle to it — and that copy was cached
    // under the same key a new one would use. Copies are keyed by how they were
    // made as well, so one made the old way is never handed out again.
    expect(VARIANT_RECIPE).toBeGreaterThanOrEqual(2);
    const master = await putMaster(db, key, { key: 'doc.bank_passbook', label: 'Passbook', bytes: PHOTO, meta: META });
    await db.put('variants', {
      id: await variantId(master.id, constraint, 1),
      masterId: master.id,
      key: 'doc.bank_passbook',
      constraint: 'old',
      meta: { ...VARIANT_META, key: 'doc.bank_passbook' },
      sealed: (await db.getAll('documents'))[0]!.sealed,
      createdAt: '2026-08-25T00:00:00Z',
    });
    await expect(getCachedVariant(db, key, master.id, constraint)).resolves.toBeUndefined();
  });

  it('stores no plaintext variant bytes at rest', async () => {
    const master = await putMaster(db, key, {
      key: 'doc.photo',
      label: 'Photo',
      bytes: PHOTO,
      meta: META,
    });
    const marker = new TextEncoder().encode('VARIANT-CANARY-PAYLOAD');
    await putVariant(db, key, master.id, 'doc.photo', constraint, marker, {
      ...VARIANT_META,
      bytes: marker.length,
    });

    const raw = JSON.stringify(await db.getAll('variants'), (_k, v: unknown) =>
      v instanceof Uint8Array ? Array.from(v) : v,
    );
    expect(raw).not.toContain('VARIANT-CANARY-PAYLOAD');
  });

  it('evicts variants when their master is deleted', async () => {
    const master = await putMaster(db, key, {
      key: 'doc.photo',
      label: 'Photo',
      bytes: PHOTO,
      meta: META,
    });
    await putVariant(db, key, master.id, 'doc.photo', constraint, VARIANT, VARIANT_META);
    expect(await countVariants(db)).toBe(1);

    await deleteMaster(db, master.id);
    expect(await countVariants(db)).toBe(0);
  });

  it('evicts variants when a master is replaced — a new photo must not serve old crops', async () => {
    const first = await putMaster(db, key, {
      key: 'doc.photo',
      label: 'First',
      bytes: PHOTO,
      meta: META,
    });
    await putVariant(db, key, first.id, 'doc.photo', constraint, VARIANT, VARIANT_META);
    expect(await countVariants(db)).toBe(1);

    await putMaster(db, key, { key: 'doc.photo', label: 'Second', bytes: PHOTO, meta: META });
    expect(await countVariants(db)).toBe(0);
  });

  it('clears the whole cache without touching masters', async () => {
    const master = await putMaster(db, key, {
      key: 'doc.photo',
      label: 'Photo',
      bytes: PHOTO,
      meta: META,
    });
    await putVariant(db, key, master.id, 'doc.photo', constraint, VARIANT, VARIANT_META);

    await clearVariants(db);
    expect(await countVariants(db)).toBe(0);
    expect(await listMasters(db)).toHaveLength(1);
  });
});
