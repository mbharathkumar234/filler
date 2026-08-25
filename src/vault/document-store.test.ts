import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteDB } from 'idb';
import { DB_NAME, DB_VERSION, closeVaultDb, openVaultDb, type VaultDb } from './db';
import { deriveKey, newKdfParams, type KdfParams } from './crypto';
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
  variantId,
} from './document-store';
import { parseConstraint } from '@/documents/constraints';

const TEST_ITERATIONS = 1_000;

let db: VaultDb;
let key: CryptoKey;
let kdf: KdfParams;

const PHOTO = new Uint8Array(2048).fill(0x42);
const META = { mime: 'image/jpeg', bytes: 2048, width: 3024, height: 4032, capturedAt: '2026-08-25T00:00:00Z' };

beforeEach(async () => {
  await closeVaultDb();
  await deleteDB(DB_NAME);
  db = await openVaultDb();
  kdf = { ...newKdfParams(), iterations: TEST_ITERATIONS };
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
