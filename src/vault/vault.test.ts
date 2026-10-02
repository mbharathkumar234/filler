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
import { createVerifier, deriveKey, newSalt, toBase64, type KdfParams } from './crypto';
import { countVariants, getMasterByKey, listMasters, putMaster, putVariant } from './document-store';
import { getSetting, putSetting } from './settings-store';
import type { DocumentMeta } from '@/shared/types';
import {
  completeness,
  deleteField,
  getAllFields,
  getField,
  setField,
  setFields,
  storedKeys,
} from './profile-store';
import {
  BackupFormatError,
  chunkBackup,
  exportVault,
  importVault,
  parseBackup,
} from './backup';
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

  it('leaves the level-less education block out until something is in it', async () => {
    // Nobody fills it any more — a form that names no qualification is
    // answered from the most recent one — so counting its fifteen fields
    // against everybody would put 100% out of reach.
    const before = await completeness(db);
    await setField(db, key, 'education[].roll_number', 'old entry');
    const after = await completeness(db);
    expect(after.total).toBeGreaterThan(before.total);
    expect(after.filled).toBe(1);
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

  /**
   * Documents in the backup (§ Phase 1 export, extended).
   *
   * A backup that held only the text fields was a backup of the easy half: the
   * photo, the signature and forty scans — the part that takes an afternoon
   * and a scanner to replace — stayed on the old device. The bytes are
   * already sealed in the vault, so they travel as ciphertext exactly as the
   * profile records do, and export still never decrypts anything.
   */
  describe('documents', () => {
    const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x99]);

    async function seedWithDocument(): Promise<VaultMeta> {
      const meta = await seedVault();
      await putMaster(db, key, {
        key: 'doc.marksheet_10',
        label: 'Class 10 marks card',
        bytes: PDF,
        meta: {
          mime: 'application/pdf',
          bytes: PDF.length,
          width: 0,
          height: 0,
          capturedAt: '2026-01-01T00:00:00.000Z',
        },
      });
      return meta;
    }

    it('carries the file, still sealed', async () => {
      const meta = await seedWithDocument();

      const text = await exportVault(db, meta);
      const file = parseBackup(text);

      expect(file.documents).toHaveLength(1);
      expect(file.documents?.[0]).toMatchObject({
        key: 'doc.marksheet_10',
        label: 'Class 10 marks card',
        meta: { mime: 'application/pdf' },
      });
      // The bytes are in there as ciphertext and nowhere as themselves.
      expect(text).not.toContain('%PDF-1.4');
      expect(text).not.toContain(toBase64(PDF));
    });

    it('round-trips the file itself, byte for byte', async () => {
      const meta = await seedWithDocument();
      const text = await exportVault(db, meta);

      await clearVault(db);
      const result = await importVault(db, text, PASSPHRASE);
      expect(result?.documents).toBe(1);

      const restoredKey = await deriveKey(PASSPHRASE, (await readMeta(db))!.kdf);
      const restored = await getMasterByKey(db, restoredKey, 'doc.marksheet_10');
      expect(restored?.label).toBe('Class 10 marks card');
      expect([...(restored?.bytes ?? [])]).toEqual([...PDF]);
    });

    it('carries the password a locked PDF opens with, sealed, and restores it', async () => {
      // Without it a restored e-Aadhaar is a file the vault holds and cannot open.
      const meta = await seedVault();
      await putMaster(db, key, {
        key: 'doc.aadhaar_card',
        label: 'Aadhaar card',
        bytes: PDF,
        meta: { mime: 'application/pdf', bytes: PDF.length, width: 0, height: 0, capturedAt: '2026-01-01T00:00:00.000Z' },
        password: 'PASSWORD-CANARY-1998',
      });

      const text = await exportVault(db, meta);
      expect(text).not.toContain('PASSWORD-CANARY');
      expect(parseBackup(text).documents?.[0]?.password).toMatchObject({ iv: expect.any(String), ct: expect.any(String) });

      await clearVault(db);
      await importVault(db, text, PASSPHRASE);
      const restoredKey = await deriveKey(PASSPHRASE, (await readMeta(db))!.kdf);
      const restored = await getMasterByKey(db, restoredKey, 'doc.aadhaar_card');
      expect(restored?.password).toBe('PASSWORD-CANARY-1998');
      expect(restored?.locked).toBe(true);
    });

    it('skips a document whose key this build does not have', async () => {
      const meta = await seedWithDocument();
      const file = parseBackup(await exportVault(db, meta));
      file.documents!.push({ ...file.documents![0]!, id: 'x', key: 'doc.from_the_future' });

      await clearVault(db);
      const result = await importVault(db, JSON.stringify(file), PASSPHRASE);
      expect(result?.documents).toBe(1);
      expect(result?.skippedKeys).toContain('doc.from_the_future');
    });

    it('refuses a document entry that is not shaped like one, rather than storing it', async () => {
      const meta = await seedWithDocument();
      const file = parseBackup(await exportVault(db, meta));
      file.documents!.push({
        ...file.documents![0]!,
        id: 'broken',
        meta: { mime: 'application/pdf' } as unknown as DocumentMeta,
      });

      await clearVault(db);
      const result = await importVault(db, JSON.stringify(file), PASSPHRASE);
      expect(result?.documents).toBe(1);
    });

    it('leaves the derived-variant cache out: it is a cache, and it rebuilds', async () => {
      const meta = await seedWithDocument();
      const [master] = await listMasters(db);
      await putVariant(db, key, master!.id, 'doc.marksheet_10', { mime: ['application/pdf'] }, PDF, {
        mime: 'application/pdf',
        bytes: PDF.length,
        width: 0,
        height: 0,
        capturedAt: '2026-01-01T00:00:00.000Z',
      });

      const file = parseBackup(await exportVault(db, meta));
      expect(JSON.stringify(file)).not.toContain('variant');
      expect(await countVariants(db)).toBe(1);
    });

    it('carries the settings, so a restored vault is laid out as it was left', async () => {
      const meta = await seedWithDocument();
      await putSetting(db, key, 'vault.path', '{"version":1,"board10":"cbse"}');

      const text = await exportVault(db, meta);
      expect(text).not.toContain('cbse');

      await clearVault(db);
      await importVault(db, text, PASSPHRASE);

      const restoredKey = await deriveKey(PASSPHRASE, (await readMeta(db))!.kdf);
      await expect(getSetting(db, restoredKey, 'vault.path')).resolves.toBe(
        '{"version":1,"board10":"cbse"}',
      );
    });

    it('replaces the settings it finds rather than leaving one behind', async () => {
      // A restore is "this file is my vault now". A leftover key or an old
      // academic path would be the one thing in there nobody chose.
      const meta = await seedVault();
      const text = await exportVault(db, meta);
      await putSetting(db, key, 'llm.apiKey', 'from-the-vault-being-replaced');

      await importVault(db, text, PASSPHRASE);

      const restoredKey = await deriveKey(PASSPHRASE, (await readMeta(db))!.kdf);
      await expect(getSetting(db, restoredKey, 'llm.apiKey')).resolves.toBeNull();
    });

    it('still opens a backup written before documents were carried', async () => {
      // A version 1 file: the format this build wrote until now.
      const meta = await seedVault();
      await setField(db, key, 'identity.full_name', 'Ravi Kumar');
      const file = parseBackup(await exportVault(db, meta));
      const old = { ...file, version: 1 };
      delete (old as { documents?: unknown }).documents;

      await clearVault(db);
      const result = await importVault(db, JSON.stringify(old), PASSPHRASE);
      expect(result?.imported).toBe(1);
      expect(result?.documents).toBe(0);
    });
  });

  describe('cutting a backup up to send it', () => {
    it('joins back to exactly the file that went in', () => {
      const text = JSON.stringify({ hello: 'world', padding: 'x'.repeat(5_000) });
      expect(chunkBackup(text, 512).join('')).toBe(text);
      expect(chunkBackup(text, 512).length).toBeGreaterThan(1);
    });

    it('never cuts a character in half', () => {
      // A document labelled in Kannada, or with an emoji: both are pairs in a
      // JavaScript string, and half a pair in each of two messages is a label
      // that comes back broken.
      const text = `${'a'.repeat(9)}\u{1F600}${'b'.repeat(10)}`;
      const pieces = chunkBackup(text, 10);

      expect(pieces.join('')).toBe(text);
      for (const piece of pieces) {
        expect(piece).not.toMatch(/[\uD800-\uDBFF]$/);
      }
    });

    it('answers with nothing for an empty file', () => {
      expect(chunkBackup('', 10)).toEqual([]);
    });
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
