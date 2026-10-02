import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteDB } from 'idb';
import type { AcademicPath } from '@/matching/pathway';

/**
 * Storing the academic path (§ vault structure).
 *
 * It decides which blocks and document slots the editor offers, and it names a
 * reservation category, so it is sealed like every other setting rather than
 * left in `chrome.storage.local` where a locked vault would still give it up.
 *
 * What is tested here is the worker's half: that a path survives the round
 * trip through real encryption, and that anything else that ends up in that
 * setting is read as "no path" instead of shaping the editor.
 */

const session = { unlocked: true };
let vaultKey: CryptoKey;
let vaultDb: unknown;

vi.mock('@/vault/session', () => ({
  isUnlocked: () => session.unlocked,
  lockVault: () => {
    session.unlocked = false;
  },
  touch: () => {},
  withKey: async <T>(run: (db: unknown, key: CryptoKey) => Promise<T> | T): Promise<T> => {
    if (!session.unlocked) throw new Error('The vault is locked.');
    return run(vaultDb, vaultKey);
  },
  createVault: async () => {},
  unlockVault: async () => false,
  getStatus: async () => ({ exists: true, unlocked: session.unlocked }),
  VaultLockedError: class VaultLockedError extends Error {
    constructor() {
      super('The vault is locked.');
    }
  },
  WeakPassphraseError: class WeakPassphraseError extends Error {},
}));

const { handleVaultRequest, isVaultRequest } = await import('./vault-service');
const { DB_NAME, closeVaultDb, openVaultDb } = await import('@/vault/db');
const { deriveKey, newSalt } = await import('@/vault/crypto');
const { PATH_SETTING, putSetting } = await import('@/vault/settings-store');
const { defaultPath } = await import('@/matching/pathway');

const STUDENT: AcademicPath = {
  version: 1,
  state: 'karnataka',
  board10: 'cbse',
  afterTen: 'puc',
  stream: 'pcmb',
  now: 'undergraduate',
  degreeFamily: 'engineering',
  course: 'B.E. / B.Tech',
  branch: 'Computer Science Engineering',
  entrance: ['kcet'],
  category: 'st',
  claims: ['371j', 'income'],
};

/** Cheap on purpose; the shipped parameters are asserted in `kdf-migration.test.ts`. */
const TEST_KDF = { name: 'Argon2id', memoryKiB: 1_024, iterations: 1, parallelism: 1 } as const;

async function get(): Promise<AcademicPath | null> {
  const result = await handleVaultRequest({ type: 'vault:path' });
  if (!result.ok) throw new Error(result.error);
  return result.data as AcademicPath | null;
}

beforeEach(async () => {
  session.unlocked = true;
  await closeVaultDb();
  await deleteDB(DB_NAME);
  vaultDb = await openVaultDb();
  vaultKey = await deriveKey('correct horse battery staple', { ...TEST_KDF, salt: newSalt() });
});

describe('the path a vault is laid out from', () => {
  it('is routed to this handler at all', () => {
    /*
     * The bug this exists for: the messages were called `path:get` and
     * `path:set`, the handler below was written and tested, and the worker
     * routed neither — it dispatches on the `vault:` prefix, so the panel was
     * answered "Unhandled request: path:get" by a router that never reached
     * any of the tests above.
     */
    expect(isVaultRequest('vault:path')).toBe(true);
    expect(isVaultRequest('vault:set-path')).toBe(true);
    expect(isVaultRequest('path:get')).toBe(false);
  });

  it('is not there until it is answered', async () => {
    await expect(get()).resolves.toBeNull();
  });

  it('comes back exactly as it went in', async () => {
    await handleVaultRequest({ type: 'vault:set-path', path: STUDENT });
    await expect(get()).resolves.toEqual(STUDENT);
  });

  it('is forgotten when it is set to nothing, which means show everything', async () => {
    await handleVaultRequest({ type: 'vault:set-path', path: STUDENT });
    await handleVaultRequest({ type: 'vault:set-path', path: null });
    await expect(get()).resolves.toBeNull();
  });

  it('is stored sealed, not as something a reader could pick the category out of', async () => {
    await handleVaultRequest({ type: 'vault:set-path', path: STUDENT });

    const raw = await (vaultDb as { get(store: string, key: string): Promise<unknown> }).get(
      'settings',
      PATH_SETTING,
    );
    expect(JSON.stringify(raw)).not.toContain('karnataka');
    expect(JSON.stringify(raw)).not.toContain('371j');
  });

  it('reads a setting that is not a path as no path at all', async () => {
    for (const stored of ['not json', '{"version":2}', '{"version":1,"afterTen":"college"}']) {
      await putSetting(
        vaultDb as Parameters<typeof putSetting>[0],
        vaultKey,
        PATH_SETTING,
        stored,
      );
      await expect(get(), stored).resolves.toBeNull();
    }
  });

  it('refuses both halves while the vault is locked', async () => {
    session.unlocked = false;
    const read = await handleVaultRequest({ type: 'vault:path' });
    const write = await handleVaultRequest({ type: 'vault:set-path', path: defaultPath() });
    expect(read.ok).toBe(false);
    expect(write.ok).toBe(false);
  });
});
