/**
 * IndexedDB handle (§ Phase 1).
 *
 * **This database stores ciphertext only.** Field *names* are plaintext because
 * they are the lookup keys; field *values* are always sealed records. The
 * threat model's "stolen laptop" row depends on that being true, and the
 * `db.test.ts` inspection test asserts it against the raw store.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { FieldKey } from '@/matching/taxonomy';
import type { KdfParams, SealedRecord } from './crypto';

export const DB_NAME = 'autofill-vault';
export const DB_VERSION = 1;

/** Where a stored value came from — surfaced in the review screen (Phase 7). */
export type ProvenanceSource = 'user' | 'imported' | 'corrected';

/** A profile row as it sits on disk: key in the clear, value sealed. */
export interface StoredProfileRecord {
  key: FieldKey;
  sealed: SealedRecord;
  verifiedAt: string;
  source: ProvenanceSource;
}

/** Vault metadata. Not secret — the salt and iteration count are public inputs. */
export interface VaultMeta {
  id: 'vault';
  schemaVersion: number;
  kdf: KdfParams;
  /** Known plaintext sealed under the vault key; used to check a passphrase. */
  verifier: SealedRecord;
  createdAt: string;
  updatedAt: string;
}

interface VaultSchema extends DBSchema {
  meta: { key: 'vault'; value: VaultMeta };
  profile: { key: FieldKey; value: StoredProfileRecord };
}

export type VaultDb = IDBPDatabase<VaultSchema>;

let handle: Promise<VaultDb> | null = null;

export function openVaultDb(): Promise<VaultDb> {
  handle ??= openDB<VaultSchema>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('profile')) {
        db.createObjectStore('profile', { keyPath: 'key' });
      }
      // Document blobs get their own store in Phase 2, behind a version bump.
    },
  });
  return handle;
}

/** Test seam — drops the cached handle so a fresh DB can be opened. */
export function resetVaultDbHandle(): void {
  handle = null;
}

/**
 * Close the cached connection and drop the handle.
 *
 * An open connection blocks `deleteDB`, so anything that deletes or recreates
 * the database must close first — tests, and the "reset vault" path.
 */
export async function closeVaultDb(): Promise<void> {
  const current = handle;
  handle = null;
  if (!current) return;
  try {
    (await current).close();
  } catch {
    // Already closed, or never finished opening. Nothing to release.
  }
}

export async function readMeta(db: VaultDb): Promise<VaultMeta | undefined> {
  return db.get('meta', 'vault');
}

export async function writeMeta(db: VaultDb, meta: VaultMeta): Promise<void> {
  await db.put('meta', meta);
}

export async function vaultExists(db: VaultDb): Promise<boolean> {
  return (await readMeta(db)) !== undefined;
}

/**
 * Delete everything. Used by "reset vault" and by import, which replaces the
 * whole profile rather than merging into a half-populated one.
 */
export async function clearVault(db: VaultDb): Promise<void> {
  const tx = db.transaction(['meta', 'profile'], 'readwrite');
  await Promise.all([tx.objectStore('meta').clear(), tx.objectStore('profile').clear(), tx.done]);
}
