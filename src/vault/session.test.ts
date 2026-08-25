import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteDB } from 'idb';
import { DB_NAME, closeVaultDb, openVaultDb } from './db';
import {
  IDLE_LOCK_MS,
  VaultLockedError,
  WeakPassphraseError,
  __resetSessionForTests,
  createVault,
  getStatus,
  isUnlocked,
  lockVault,
  requireKey,
  touch,
  unlockVault,
  withKey,
} from './session';
import { getField, setField } from './profile-store';

const PASSPHRASE = 'correct horse battery staple';

/**
 * These tests exercise the real KDF at its shipping iteration count, so they
 * are deliberately slower than the rest of the suite. That cost is the point:
 * it is the only place the 600k-iteration path is proven to actually run.
 */
beforeEach(async () => {
  __resetSessionForTests();
  await closeVaultDb();
  await deleteDB(DB_NAME);
});

afterEach(async () => {
  vi.useRealTimers();
  __resetSessionForTests();
  await closeVaultDb();
});

describe('vault creation', () => {
  it('creates a vault and leaves it unlocked', async () => {
    await createVault(PASSPHRASE);
    expect(isUnlocked()).toBe(true);
    await expect(getStatus()).resolves.toMatchObject({ exists: true, unlocked: true });
  });

  it('refuses a weak passphrase and creates nothing', async () => {
    await expect(createVault('password123')).rejects.toThrow(WeakPassphraseError);
    await expect(getStatus()).resolves.toMatchObject({ exists: false, unlocked: false });
  });

  it('surfaces actionable feedback when it refuses', async () => {
    const err = await createVault('short').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WeakPassphraseError);
    expect((err as WeakPassphraseError).feedback.length).toBeGreaterThan(0);
  });

  it('refuses to create a second vault over an existing one', async () => {
    await createVault(PASSPHRASE);
    await expect(createVault(PASSPHRASE)).rejects.toThrow(/already exists/i);
  });
});

describe('unlock', () => {
  it('unlocks with the correct passphrase', async () => {
    await createVault(PASSPHRASE);
    lockVault();
    expect(isUnlocked()).toBe(false);

    await expect(unlockVault(PASSPHRASE)).resolves.toBe(true);
    expect(isUnlocked()).toBe(true);
  });

  it('returns false on a wrong passphrase and stays locked', async () => {
    await createVault(PASSPHRASE);
    lockVault();

    await expect(unlockVault('not the passphrase')).resolves.toBe(false);
    expect(isUnlocked()).toBe(false);
  });

  it('throws when there is no vault to unlock', async () => {
    await expect(unlockVault(PASSPHRASE)).rejects.toThrow(/no vault/i);
  });

  it('survives a simulated browser restart — data intact after re-unlock', async () => {
    await createVault(PASSPHRASE);
    await withKey((db, key) => setField(db, key, 'identity.full_name', 'Ravi Kumar'));

    // Browser close: the service worker dies, the key reference goes with it.
    // IndexedDB persists.
    __resetSessionForTests();
    expect(isUnlocked()).toBe(false);

    await expect(unlockVault(PASSPHRASE)).resolves.toBe(true);
    const entry = await withKey((db, key) => getField(db, key, 'identity.full_name'));
    expect(entry?.value).toBe('Ravi Kumar');
  });
});

describe('key access', () => {
  it('throws VaultLockedError when locked', () => {
    expect(() => requireKey()).toThrow(VaultLockedError);
  });

  it('hands out the key when unlocked', async () => {
    await createVault(PASSPHRASE);
    expect(requireKey()).toBeDefined();
  });

  it('never exposes extractable key material', async () => {
    await createVault(PASSPHRASE);
    const key = requireKey();
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });

  it('rejects withKey while locked', async () => {
    await createVault(PASSPHRASE);
    lockVault();
    await expect(withKey(async () => 'unreachable')).rejects.toThrow(VaultLockedError);
  });
});

describe('auto-lock', () => {
  it('locks once the idle deadline passes', async () => {
    await createVault(PASSPHRASE);
    expect(isUnlocked()).toBe(true);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + IDLE_LOCK_MS + 1);

    expect(isUnlocked()).toBe(false);
    expect(() => requireKey()).toThrow(VaultLockedError);
  });

  it('stays unlocked just before the deadline', async () => {
    await createVault(PASSPHRASE);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + IDLE_LOCK_MS - 1000);

    expect(isUnlocked()).toBe(true);
  });

  it('defers the deadline on activity', async () => {
    await createVault(PASSPHRASE);
    const start = Date.now();

    vi.useFakeTimers();
    vi.setSystemTime(start + IDLE_LOCK_MS - 1000);
    touch();

    // Past the ORIGINAL deadline, but only 1s past the refreshed one.
    vi.setSystemTime(start + IDLE_LOCK_MS + 1000);
    expect(isUnlocked()).toBe(true);
  });

  it('locks even if the timer never fired — the deadline is checked on access', async () => {
    await createVault(PASSPHRASE);

    // Simulates the service worker being suspended: no timer callback runs,
    // wall-clock time still passes.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + IDLE_LOCK_MS * 4);

    expect(isUnlocked()).toBe(false);
  });

  it('reports time remaining until auto-lock', async () => {
    await createVault(PASSPHRASE);
    const status = await getStatus();
    expect(status.locksInMs).toBeGreaterThan(IDLE_LOCK_MS - 5_000);
    expect(status.locksInMs).toBeLessThanOrEqual(IDLE_LOCK_MS);
  });

  it('reports no lock countdown while locked', async () => {
    await createVault(PASSPHRASE);
    lockVault();
    await expect(getStatus()).resolves.toMatchObject({ unlocked: false, locksInMs: null });
  });
});

describe('lock', () => {
  it('is idempotent', async () => {
    await createVault(PASSPHRASE);
    lockVault();
    expect(() => lockVault()).not.toThrow();
    expect(isUnlocked()).toBe(false);
  });

  it('leaves stored data intact', async () => {
    await createVault(PASSPHRASE);
    await withKey((db, key) => setField(db, key, 'contact.email', 'ravi@example.com'));
    lockVault();

    const db = await openVaultDb();
    await expect(db.getAllKeys('profile')).resolves.toContain('contact.email');
  });
});
