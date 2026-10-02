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
import type { DocumentMeta } from '@/shared/types';
import type { KdfParams, SealedRecord } from './crypto';

export const DB_NAME = 'autofill-vault';
export const DB_VERSION = 3;

/** Where a stored value came from — surfaced in the review screen (Phase 7). */
/**
 * Where a stored value came from.
 *
 * `extracted` is kept distinct from `user` deliberately: a value read off a
 * scanned card and confirmed by the user is not the same as one they typed,
 * and if a misread ever does get through, this is what makes it findable
 * afterwards rather than indistinguishable from everything else.
 */
export type ProvenanceSource = 'user' | 'imported' | 'corrected' | 'extracted';

/** A profile row as it sits on disk: key in the clear, value sealed. */
export interface StoredProfileRecord {
  key: FieldKey;
  sealed: SealedRecord;
  verifiedAt: string;
  source: ProvenanceSource;
}

/** Vault metadata. Not secret — the salt and iteration count are public inputs. */
/** A setting whose value is a secret — sealed under the vault key. */
export interface StoredSetting {
  name: string;
  sealed: SealedRecord;
  updatedAt: string;
}

export interface VaultMeta {
  id: 'vault';
  schemaVersion: number;
  kdf: KdfParams;
  /** Known plaintext sealed under the vault key; used to check a passphrase. */
  verifier: SealedRecord;
  createdAt: string;
  updatedAt: string;
}

/**
 * A stored document master. `meta` is plaintext (dimensions and byte counts are
 * not secrets and are needed to plan a derivation without unlocking); `sealed`
 * holds the encrypted file bytes.
 */
export interface StoredDocument {
  id: string;
  key: FieldKey;
  /** User-facing name. Deliberately NOT the original filename — see note below. */
  label: string;
  meta: DocumentMeta;
  sealed: SealedRecord;
  /**
   * The password a locked PDF opens with, sealed like the bytes. Absent for
   * everything else. Optional, so no migration: a record without it is a
   * document that needs none.
   */
  sealedPassword?: SealedRecord;
  createdAt: string;
}

/** A derived variant, cached under hash(masterId + constraint). */
export interface StoredVariant {
  id: string;
  masterId: string;
  key: FieldKey;
  /** Canonical constraint string this variant satisfies. */
  constraint: string;
  meta: DocumentMeta;
  sealed: SealedRecord;
  createdAt: string;
}

interface VaultSchema extends DBSchema {
  meta: { key: 'vault'; value: VaultMeta };
  settings: { key: string; value: StoredSetting };
  profile: { key: FieldKey; value: StoredProfileRecord };
  documents: { key: string; value: StoredDocument; indexes: { byKey: FieldKey } };
  variants: { key: string; value: StoredVariant; indexes: { byMaster: string } };
}

export type VaultDb = IDBPDatabase<VaultSchema>;

let handle: Promise<VaultDb> | null = null;

export function openVaultDb(): Promise<VaultDb> {
  handle ??= openDB<VaultSchema>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      // v1 — the profile vault (Phase 1).
      if (oldVersion < 1) {
        db.createObjectStore('meta', { keyPath: 'id' });
        db.createObjectStore('profile', { keyPath: 'key' });
      }
      // v2 — document masters and their derived variants (Phase 2).
      if (oldVersion < 2) {
        const documents = db.createObjectStore('documents', { keyPath: 'id' });
        documents.createIndex('byKey', 'key');
        const variants = db.createObjectStore('variants', { keyPath: 'id' });
        variants.createIndex('byMaster', 'masterId');
      }
      // v3 — sealed settings (Phase 8). The API key lives here rather than in
      // chrome.storage.local so that a copy of the profile directory does not
      // hand over a working credential: it is encrypted under the vault key,
      // which means the model can only be used while the vault is unlocked.
      // That is the right coupling anyway — the LLM exists to help fill, and
      // filling needs the vault open.
      if (oldVersion < 3) {
        db.createObjectStore('settings', { keyPath: 'name' });
      }
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
  const tx = db.transaction(['meta', 'profile', 'documents', 'variants'], 'readwrite');
  await Promise.all([
    tx.objectStore('meta').clear(),
    tx.objectStore('profile').clear(),
    tx.objectStore('documents').clear(),
    tx.objectStore('variants').clear(),
    tx.done,
  ]);
}
