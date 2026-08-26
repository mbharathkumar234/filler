import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';

import {
  ARGON2_ITERATIONS,
  ARGON2_MEMORY_KIB,
  createVerifier,
  deriveKey,
  KDF_ITERATIONS,
  legacyKdfParams,
  needsRehash,
  newKdfParams,
  verifyPassphrase,
  type Argon2Params,
} from './crypto';
import { closeVaultDb, openVaultDb, readMeta, writeMeta } from './db';
import { createVault, kdfStatus, lockVault, unlockVault, __resetSessionForTests } from './session';
import { getField, setField } from './profile-store';
import type { FieldKey } from '@/matching/taxonomy';

/**
 * The KDF upgrade (§ Phase 10).
 *
 * Two things are being tested and they pull in opposite directions:
 *
 *  - A new vault must get Argon2id, and an old one must still open.
 *  - The migration must never be able to lose somebody's data. A re-key means
 *    re-encrypting every record, in a service worker that can be suspended
 *    mid-write, so it happens only when there is nothing to lose.
 */

const PASSPHRASE = 'correct horse battery staple 42';

beforeEach(async () => {
  __resetSessionForTests();
  await closeVaultDb();
  indexedDB.deleteDatabase('autofill-vault');
  await new Promise((resolve) => setTimeout(resolve, 0));
});

describe('what a new vault gets', () => {
  it('is Argon2id, at the shipped parameters', async () => {
    await createVault(PASSPHRASE);

    const meta = await readMeta(await openVaultDb());
    expect(meta?.kdf.name).toBe('Argon2id');
    expect(meta?.kdf).toMatchObject({
      memoryKiB: ARGON2_MEMORY_KIB,
      iterations: ARGON2_ITERATIONS,
    });
  });

  it('is memory-hard, which is the whole reason for the change', async () => {
    // 64 MiB per guess is what makes a stolen laptop expensive to attack.
    // PBKDF2 needs almost none, which is why a GPU eats it.
    expect(ARGON2_MEMORY_KIB).toBeGreaterThanOrEqual(19 * 1024);
  });

  it('does not need rehashing', async () => {
    await createVault(PASSPHRASE);
    const meta = await readMeta(await openVaultDb());
    expect(needsRehash(meta!.kdf)).toBe(false);
  });
});

describe('needsRehash', () => {
  it('is true for every PBKDF2 vault, however many iterations', () => {
    expect(needsRehash({ name: 'PBKDF2-SHA256', iterations: 10_000_000, salt: new Uint8Array(16) })).toBe(
      true,
    );
    expect(KDF_ITERATIONS).toBe(600_000);
  });

  it('is true for Argon2id parameters weaker than what we ship', () => {
    const weak: Argon2Params = {
      name: 'Argon2id',
      memoryKiB: 8 * 1024,
      iterations: 1,
      parallelism: 1,
      salt: new Uint8Array(16),
    };
    expect(needsRehash(weak)).toBe(true);
  });

  it('is false for the current parameters', () => {
    expect(needsRehash(newKdfParams())).toBe(false);
  });
});

describe('a vault created before Phase 10', () => {
  /** Build a PBKDF2 vault the way Phase 1 would have. */
  async function createLegacyVault(): Promise<void> {
    const db = await openVaultDb();
    const kdf = legacyKdfParams();
    const key = await deriveKey(PASSPHRASE, kdf);
    const now = new Date().toISOString();
    await writeMeta(db, {
      id: 'vault',
      schemaVersion: 1,
      kdf,
      verifier: await createVerifier(key),
      createdAt: now,
      updatedAt: now,
    });
  }

  it('still opens', async () => {
    // The one that matters most. A user who upgrades the extension must not
    // find their vault unopenable.
    await createLegacyVault();
    expect(await unlockVault(PASSPHRASE)).toBe(true);
  });

  it('still refuses a wrong passphrase', async () => {
    await createLegacyVault();
    expect(await unlockVault('not the passphrase')).toBe(false);
  });

  it('is upgraded to Argon2id when the vault holds nothing yet', async () => {
    await createLegacyVault();
    await unlockVault(PASSPHRASE);

    const meta = await readMeta(await openVaultDb());
    expect(meta?.kdf.name).toBe('Argon2id');

    // And the upgraded vault opens on the same passphrase.
    lockVault();
    expect(await unlockVault(PASSPHRASE)).toBe(true);
  });

  /**
   * A legacy vault that already holds a record.
   *
   * The data goes in *before* any unlock, on purpose: unlocking an empty
   * legacy vault migrates it, so adding data afterwards would leave an
   * Argon2id vault and test nothing.
   */
  async function createLegacyVaultWithData(): Promise<void> {
    await createLegacyVault();
    const db = await openVaultDb();
    const key = await deriveKey(PASSPHRASE, (await readMeta(db))!.kdf);
    await setField(db, key, 'identity.full_name' as FieldKey, 'Ravi Kumar');
  }

  it('is LEFT ALONE when the vault holds data', async () => {
    // The conservative half. Re-keying means re-encrypting every record, and
    // an interrupted re-encrypt in a suspendable worker is a worse outcome
    // than a strong-but-older KDF. PBKDF2 at 600k is not weak, only weaker.
    await createLegacyVaultWithData();

    await unlockVault(PASSPHRASE);

    expect((await readMeta(await openVaultDb()))?.kdf.name).toBe('PBKDF2-SHA256');
  });

  it('and the data is still readable after that unlock', async () => {
    await createLegacyVaultWithData();

    expect(await unlockVault(PASSPHRASE)).toBe(true);

    const db = await openVaultDb();
    const key = await deriveKey(PASSPHRASE, (await readMeta(db))!.kdf);
    expect(await getField(db, key, 'identity.full_name' as FieldKey)).toMatchObject({
      value: 'Ravi Kumar',
    });
  });
});

describe('what the panel is told', () => {
  it('reports a modern vault as needing nothing', async () => {
    await createVault(PASSPHRASE);
    expect(await kdfStatus()).toMatchObject({ name: 'Argon2id', upgradable: false });
  });

  it('reports a legacy vault with data as upgradable but blocked', async () => {
    // So the offer is explicit — the user can re-create from a backup — rather
    // than the extension silently deciding either way.
    const db = await openVaultDb();
    const kdf = legacyKdfParams();
    const key = await deriveKey(PASSPHRASE, kdf);
    const now = new Date().toISOString();
    await writeMeta(db, {
      id: 'vault',
      schemaVersion: 1,
      kdf,
      verifier: await createVerifier(key),
      createdAt: now,
      updatedAt: now,
    });
    await setField(db, key, 'identity.full_name' as FieldKey, 'Ravi Kumar');

    expect(await kdfStatus()).toMatchObject({
      name: 'PBKDF2-SHA256',
      upgradable: true,
      blockedByData: true,
    });
  });

  it('reports nothing at all when there is no vault', async () => {
    expect(await kdfStatus()).toMatchObject({ name: 'none', upgradable: false });
  });
});

describe('Argon2id itself', () => {
  it('derives a key that decrypts what it encrypted', async () => {
    const params = newKdfParams();
    const key = await deriveKey(PASSPHRASE, params);
    const verifier = await createVerifier(key);

    expect(await verifyPassphrase(key, verifier)).toBe(true);
  });

  it('derives a different key from a different passphrase', async () => {
    const params = newKdfParams();
    const right = await deriveKey(PASSPHRASE, params);
    const wrong = await deriveKey('something else entirely', params);

    expect(await verifyPassphrase(wrong, await createVerifier(right))).toBe(false);
  });

  it('derives a different key from a different salt', async () => {
    const a = await deriveKey(PASSPHRASE, newKdfParams());
    const b = await deriveKey(PASSPHRASE, newKdfParams());

    expect(await verifyPassphrase(b, await createVerifier(a))).toBe(false);
  });

  it('is deterministic for the same passphrase and salt', async () => {
    const params = newKdfParams();
    const first = await deriveKey(PASSPHRASE, params);
    const second = await deriveKey(PASSPHRASE, params);

    expect(await verifyPassphrase(second, await createVerifier(first))).toBe(true);
  });

  it('produces a non-extractable key', async () => {
    // Same guarantee PBKDF2 gave: even our own code cannot read the bytes
    // back out, so a stray log or a serialisation bug cannot leak it.
    const key = await deriveKey(PASSPHRASE, newKdfParams());
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });
});
