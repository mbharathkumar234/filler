/**
 * Encrypted backup export/import — the `.afvault` file (§ Phase 1).
 *
 * The file carries **already-sealed records verbatim**, together with the KDF
 * parameters and the verifier. Two consequences worth stating plainly:
 *
 *  1. Export never decrypts anything, so no plaintext value exists in memory
 *     during a backup. There is no window in which a bug can spill the vault.
 *  2. The backup passphrase *is* the vault passphrase. Restoring needs the
 *     passphrase the vault had when the file was written — a backup taken
 *     before a passphrase change opens with the old one.
 *
 * There is no recovery path. A lost passphrase means a lost backup, and the
 * warning text in `backup-format.ts` says so in as many words.
 */

import { fromBase64, toBase64, verifyPassphrase, deriveKey, type SealedRecord } from './crypto';
import { isFieldKey, type FieldKey } from '@/matching/taxonomy';
import {
  clearVault,
  writeMeta,
  type ProvenanceSource,
  type StoredProfileRecord,
  type VaultDb,
  type VaultMeta,
} from './db';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  BackupFormatError,
  type BackupFile,
  type ImportResult,
  type SerializedSealed,
} from './backup-format';

export * from './backup-format';

function seal(record: SealedRecord): SerializedSealed {
  return { v: record.v, iv: toBase64(record.iv), ct: toBase64(record.ct) };
}

function unseal(value: SerializedSealed): SealedRecord {
  return { v: value.v, iv: fromBase64(value.iv), ct: fromBase64(value.ct) };
}

/**
 * Serialise the vault. Requires no key: the records are already ciphertext.
 * Callers still gate this behind an unlocked session as a speed bump.
 */
export async function exportVault(db: VaultDb, meta: VaultMeta): Promise<string> {
  const records = await db.getAll('profile');

  const file: BackupFile = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    kdf: {
      name: meta.kdf.name,
      iterations: meta.kdf.iterations,
      salt: toBase64(meta.kdf.salt),
    },
    verifier: seal(meta.verifier),
    records: records.map((r) => ({
      key: r.key,
      ...seal(r.sealed),
      verifiedAt: r.verifiedAt,
      source: r.source,
    })),
  };

  return JSON.stringify(file, null, 2);
}

export function parseBackup(text: string): BackupFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BackupFormatError('That file is not a valid .afvault backup.');
  }

  const file = parsed as Partial<BackupFile>;
  if (file.format !== BACKUP_FORMAT) {
    throw new BackupFormatError('That file is not an AutoFill Assistant backup.');
  }
  if (file.version !== BACKUP_VERSION) {
    throw new BackupFormatError(
      `This backup is version ${String(file.version)}; this build reads version ${BACKUP_VERSION}.`,
    );
  }
  if (!file.kdf || !file.verifier || !Array.isArray(file.records)) {
    throw new BackupFormatError('That backup is missing required sections.');
  }
  return file as BackupFile;
}

/**
 * Restore a backup, replacing the current vault.
 *
 * Returns null when the passphrase does not open the file — a wrong passphrase
 * is an expected outcome, and nothing is written in that case.
 */
export async function importVault(
  db: VaultDb,
  text: string,
  passphrase: string,
): Promise<ImportResult | null> {
  const file = parseBackup(text);

  if (file.kdf.name !== 'PBKDF2-SHA256') {
    throw new BackupFormatError(`Unsupported key derivation: ${file.kdf.name}.`);
  }

  const kdf = {
    name: 'PBKDF2-SHA256',
    iterations: file.kdf.iterations,
    salt: fromBase64(file.kdf.salt),
  } as const;

  const verifier = unseal(file.verifier);
  const key = await deriveKey(passphrase, kdf);
  if (!(await verifyPassphrase(key, verifier))) {
    return null;
  }

  const skippedKeys: string[] = [];
  const records: StoredProfileRecord[] = [];
  for (const row of file.records) {
    if (!isFieldKey(row.key)) {
      skippedKeys.push(row.key);
      continue;
    }
    records.push({
      key: row.key as FieldKey,
      sealed: unseal(row),
      verifiedAt: row.verifiedAt,
      source: (row.source as ProvenanceSource) ?? 'imported',
    });
  }

  // Replace wholesale. Merging a backup into a populated vault would produce a
  // profile the user never actually reviewed.
  await clearVault(db);

  const now = new Date().toISOString();
  const meta: VaultMeta = {
    id: 'vault',
    schemaVersion: 1,
    kdf,
    verifier,
    createdAt: file.exportedAt,
    updatedAt: now,
  };
  await writeMeta(db, meta);

  const tx = db.transaction('profile', 'readwrite');
  await Promise.all([...records.map((r) => tx.store.put(r)), tx.done]);

  return { imported: records.length, skippedKeys };
}
