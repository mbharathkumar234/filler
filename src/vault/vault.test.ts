import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteDB } from 'idb';
import {
  DB_NAME,
  clearVault,
  closeVaultDb,
  openVaultDb,
  readMeta,
  vaultExists,
  writeMeta,
  type VaultDb,
  type VaultMeta,
} from './db';
import { createVerifier, deriveKey, newSalt, type KdfParams } from './crypto';
import {
  completeness,
  deleteField,
  getAllFields,
  getField,
  setField,
  setFields,
  storedKeys,
} from './profile-store';
import { BackupFormatError, exportVault, importVault, parseBackup } from './backup';
import { estimateStrength, MINIMUM_BITS, MINIMUM_LENGTH } from './passphrase';

const PASSPHRASE = 'correct horse battery staple';
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

async function seedVault(): Promise<VaultMeta> {
  const meta: VaultMeta = {
    id: 'vault',
    schemaVersion: 1,
    kdf,
    verifier: await createVerifier(key),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeMeta(db, meta);
  return meta;
}

beforeEach(async () => {
  await closeVaultDb();
  await deleteDB(DB_NAME);
  db = await openVaultDb();
  kdf = { ...TEST_KDF, salt: newSalt() };
  key = await deriveKey(PASSPHRASE, kdf);
});

afterEach(async () => {
  await closeVaultDb();
});

describe('vault database', () => {
  it('reports no vault before one is created', async () => {
    await expect(vaultExists(db)).resolves.toBe(false);
  });

  it('round-trips vault metadata', async () => {
    const meta = await seedVault();
    await expect(vaultExists(db)).resolves.toBe(true);
    const read = await readMeta(db);
    expect(read?.kdf.iterations).toBe(meta.kdf.iterations);
  });

  it('clears both stores on reset', async () => {
    await seedVault();
    await setField(db, key, 'identity.full_name', 'Ravi Kumar');
    await clearVault(db);
    await expect(vaultExists(db)).resolves.toBe(false);
    await expect(storedKeys(db)).resolves.toEqual([]);
  });
});

describe('profile store', () => {
  beforeEach(seedVault);

  it('stores and reads back a value', async () => {
    await setField(db, key, 'identity.full_name', 'Ravi Kumar');
    const entry = await getField(db, key, 'identity.full_name');
    expect(entry?.value).toBe('Ravi Kumar');
    expect(entry?.source).toBe('user');
    expect(entry?.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns undefined for a key that was never set', async () => {
    await expect(getField(db, key, 'id.pan')).resolves.toBeUndefined();
  });

  it('overwrites an existing value and refreshes provenance', async () => {
    await setField(db, key, 'contact.mobile', '9876543210', 'user');
    await setField(db, key, 'contact.mobile', '9000000000', 'corrected');
    const entry = await getField(db, key, 'contact.mobile');
    expect(entry?.value).toBe('9000000000');
    expect(entry?.source).toBe('corrected');
  });

  it('treats an empty value as a deletion rather than storing a blank', async () => {
    await setField(db, key, 'contact.email', 'a@example.com');
    await setField(db, key, 'contact.email', '');
    await expect(getField(db, key, 'contact.email')).resolves.toBeUndefined();
    await expect(storedKeys(db)).resolves.not.toContain('contact.email');
  });

  it('deletes a field', async () => {
    await setField(db, key, 'id.pan', 'ABCPE1234F');
    await deleteField(db, 'id.pan');
    await expect(getField(db, key, 'id.pan')).resolves.toBeUndefined();
  });

  it('refuses a key that is not in the taxonomy', async () => {
    await expect(
      // @ts-expect-error deliberately passing a key outside the taxonomy
      setField(db, key, 'identity.favourite_colour', 'blue'),
    ).rejects.toThrow(/unknown taxonomy key/i);
  });

  it('returns all fields in stable taxonomy order, not insertion order', async () => {
    await setField(db, key, 'bank.ifsc', 'SBIN0001234');
    await setField(db, key, 'identity.full_name', 'Ravi Kumar');
    await setField(db, key, 'contact.email', 'ravi@example.com');

    const keys = (await getAllFields(db, key)).map((e) => e.key);
    expect(keys).toEqual(['identity.full_name', 'contact.email', 'bank.ifsc']);
  });

  it('writes many fields in one transaction', async () => {
    await setFields(db, key, [
      { key: 'identity.given_name', value: 'Ravi' },
      { key: 'identity.surname', value: 'Kumar' },
      { key: 'address.permanent.pincode', value: '560001' },
    ]);
    await expect(storedKeys(db)).resolves.toHaveLength(3);
    const entry = await getField(db, key, 'identity.surname');
    expect(entry?.value).toBe('Kumar');
    expect(entry?.source).toBe('imported');
  });

  it('measures completeness over non-document keys only', async () => {
    const empty = await completeness(db);
    expect(empty.filled).toBe(0);
    expect(empty.ratio).toBe(0);
    expect(empty.total).toBeGreaterThan(40);

    await setField(db, key, 'identity.full_name', 'Ravi Kumar');
    const one = await completeness(db);
    expect(one.filled).toBe(1);
    expect(one.total).toBe(empty.total);

    // A stored document must not move the meter.
    await setField(db, key, 'doc.photo', 'blob-ref');
    await expect(completeness(db)).resolves.toMatchObject({ filled: 1 });
  });
});

/**
 * The plan's Phase 1 Verify step: "Inspect IndexedDB in DevTools — you must see
 * only ciphertext." This asserts it against the raw stored rows instead.
 */
describe('at-rest inspection', () => {
  beforeEach(seedVault);

  it('stores no plaintext value anywhere in the profile store', async () => {
    const secrets = {
      'identity.full_name': 'RAVIKUMAR-CANARY',
      'id.aadhaar': '234567890124',
      'bank.account_number': 'ACCTNUM-CANARY-99887766',
      'contact.email': 'canary@example.com',
    } as const;

    for (const [k, v] of Object.entries(secrets)) {
      await setField(db, key, k as keyof typeof secrets, v);
    }

    const raw = JSON.stringify(await db.getAll('profile'), (_k, v: unknown) =>
      v instanceof Uint8Array ? Array.from(v) : v,
    );

    for (const value of Object.values(secrets)) {
      expect(raw, `plaintext "${value}" found at rest`).not.toContain(value);
    }
  });

  it('leaves field names readable, which is the documented tradeoff', async () => {
    await setField(db, key, 'id.aadhaar', '234567890124');
    const rows = await db.getAll('profile');
    expect(rows[0]?.key).toBe('id.aadhaar');
  });

  it('fails cleanly under the wrong key without leaking a partial value', async () => {
    await setField(db, key, 'identity.full_name', 'RAVIKUMAR-CANARY');

    const wrongKey = await deriveKey('a completely different passphrase', kdf);
    const err = await getField(db, wrongKey, 'identity.full_name').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toContain('RAVIKUMAR');
  });
});

describe('backup export / import', () => {
  it('exports a parseable file containing no plaintext', async () => {
    const meta = await seedVault();
    await setField(db, key, 'identity.full_name', 'RAVIKUMAR-CANARY');
    await setField(db, key, 'id.aadhaar', '234567890124');

    const text = await exportVault(db, meta);
    expect(text).not.toContain('RAVIKUMAR-CANARY');
    expect(text).not.toContain('234567890124');

    const file = parseBackup(text);
    expect(file.format).toBe('afvault');
    expect(file.records).toHaveLength(2);
  });

  it('round-trips a vault through export and import', async () => {
    const meta = await seedVault();
    await setField(db, key, 'identity.full_name', 'Ravi Kumar');
    await setField(db, key, 'bank.ifsc', 'SBIN0001234');
    const text = await exportVault(db, meta);

    await clearVault(db);
    await expect(vaultExists(db)).resolves.toBe(false);

    const result = await importVault(db, text, PASSPHRASE);
    expect(result).not.toBeNull();
    expect(result?.imported).toBe(2);

    const restoredMeta = await readMeta(db);
    expect(restoredMeta).toBeDefined();
    const restoredKey = await deriveKey(PASSPHRASE, restoredMeta!.kdf);
    await expect(getField(db, restoredKey, 'identity.full_name')).resolves.toMatchObject({
      value: 'Ravi Kumar',
    });
  });

  it('returns null on a wrong passphrase and writes nothing', async () => {
    const meta = await seedVault();
    await setField(db, key, 'identity.full_name', 'Ravi Kumar');
    const text = await exportVault(db, meta);

    await clearVault(db);
    await expect(importVault(db, text, 'not the passphrase')).resolves.toBeNull();
    await expect(vaultExists(db)).resolves.toBe(false);
    await expect(storedKeys(db)).resolves.toEqual([]);
  });

  it('replaces rather than merges into an existing vault', async () => {
    const meta = await seedVault();
    await setField(db, key, 'identity.full_name', 'Ravi Kumar');
    const text = await exportVault(db, meta);

    await setField(db, key, 'contact.email', 'later@example.com');
    await importVault(db, text, PASSPHRASE);

    const keys = await storedKeys(db);
    expect(keys).toEqual(['identity.full_name']);
  });

  it('skips keys that are not in this build of the taxonomy', async () => {
    const meta = await seedVault();
    await setField(db, key, 'identity.full_name', 'Ravi Kumar');
    const file = parseBackup(await exportVault(db, meta));
    file.records.push({ ...file.records[0]!, key: 'identity.from_the_future' });

    await clearVault(db);
    const result = await importVault(db, JSON.stringify(file), PASSPHRASE);
    expect(result?.imported).toBe(1);
    expect(result?.skippedKeys).toEqual(['identity.from_the_future']);
  });

  it('rejects a file that is not a backup', async () => {
    expect(() => parseBackup('{"hello":"world"}')).toThrow(BackupFormatError);
    expect(() => parseBackup('not json at all')).toThrow(BackupFormatError);
  });

  it('rejects a backup written by a future format version', async () => {
    const meta = await seedVault();
    const file = parseBackup(await exportVault(db, meta));
    file.version = 99;
    expect(() => parseBackup(JSON.stringify(file))).toThrow(/version 99/);
  });
});

describe('passphrase strength', () => {
  it('refuses anything under the length floor', () => {
    expect(estimateStrength('Sh0rt!').acceptable).toBe(false);
    expect(estimateStrength('a'.repeat(MINIMUM_LENGTH - 1)).acceptable).toBe(false);
  });

  it('refuses the classic weak passwords even at length', () => {
    expect(estimateStrength('password1234').acceptable).toBe(false);
    expect(estimateStrength('123456789012345').acceptable).toBe(false);
    expect(estimateStrength('aaaaaaaaaaaaaaaa').acceptable).toBe(false);
    expect(estimateStrength('qwertyuiop123').acceptable).toBe(false);
  });

  it('accepts a genuine passphrase', () => {
    const result = estimateStrength('correct horse battery staple');
    expect(result.acceptable).toBe(true);
    expect(result.bits).toBeGreaterThanOrEqual(MINIMUM_BITS);
    expect(result.label).toMatch(/strong|excellent|fair/);
  });

  it('scores a longer passphrase at least as high as a shorter one', () => {
    const short = estimateStrength('Tr0ub4dour&3x');
    const long = estimateStrength('Tr0ub4dour&3x-plus-a-lot-more-length');
    expect(long.bits).toBeGreaterThan(short.bits);
  });

  it('never echoes the passphrase in its feedback', () => {
    const secret = 'MySecretPassphrase99!';
    for (const line of estimateStrength(secret).feedback) {
      expect(line).not.toContain(secret);
    }
  });

  it('gives actionable feedback on an empty input', () => {
    const result = estimateStrength('');
    expect(result.acceptable).toBe(false);
    expect(result.feedback.length).toBeGreaterThan(0);
  });
});
