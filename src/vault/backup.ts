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

import {
  fromBase64,
  toBase64,
  verifyPassphrase,
  deriveKey,
  type KdfParams,
  type SealedRecord,
} from './crypto';
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
  READABLE_BACKUP_VERSIONS,
  type BackupFile,
  type ImportResult,
  type SerializedDocument,
  type SerializedSealed,
  type SerializedSetting,
} from './backup-format';
import type { StoredDocument, StoredSetting } from './db';
import type { DocumentMeta } from '@/shared/types';
import { isDocumentKey } from '@/matching/taxonomy';

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
  /*
   * The masters, not the variants.
   *
   * A variant is a copy of a master resized to one portal's requirement; it is
   * a cache, it rebuilds from the master in a second, and including it would
   * multiply the size of the backup by however many portals the user has
   * visited.
   */
  const documents = await db.getAll('documents');
  // Sealed, like everything else here. This is what carries the academic path
  // the vault is laid out from, so a restored vault comes back arranged the
  // way its owner left it rather than as a hundred unexplained slots.
  const settings = await db.getAll('settings');

  const file: BackupFile = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    kdf: {
      name: meta.kdf.name,
      iterations: meta.kdf.iterations,
      salt: toBase64(meta.kdf.salt),
      ...(meta.kdf.name === 'Argon2id'
        ? { memoryKiB: meta.kdf.memoryKiB, parallelism: meta.kdf.parallelism }
        : {}),
    },
    verifier: seal(meta.verifier),
    records: records.map((r) => ({
      key: r.key,
      ...seal(r.sealed),
      verifiedAt: r.verifiedAt,
      source: r.source,
    })),
    documents: documents.map((d) => ({
      id: d.id,
      key: d.key,
      label: d.label,
      meta: d.meta,
      createdAt: d.createdAt,
      ...seal(d.sealed),
      // A locked PDF travels with what opens it, or it is restored unopenable.
      ...(d.sealedPassword === undefined ? {} : { password: seal(d.sealedPassword) }),
    })),
    settings: settings.map((setting) => ({
      name: setting.name,
      updatedAt: setting.updatedAt,
      ...seal(setting.sealed),
    })),
  };

  return JSON.stringify(file, null, 2);
}

/**
 * Read the KDF a backup was sealed under.
 *
 * Both shapes are accepted, and that is the whole point: a backup written by a
 * build before Phase 10 uses PBKDF2, and one written after uses Argon2id. A
 * backup that stopped opening because the *application* moved on would be a
 * backup in name only — the file is the user's last copy, and its job is to
 * outlive the software that wrote it.
 *
 * Returns null for anything else, so an unknown KDF is refused rather than
 * guessed at.
 */
export function kdfFromBackup(kdf: BackupFile['kdf']): KdfParams | null {
  if (kdf.name === 'PBKDF2-SHA256') {
    return {
      name: 'PBKDF2-SHA256',
      iterations: kdf.iterations,
      salt: fromBase64(kdf.salt),
    };
  }

  if (kdf.name === 'Argon2id') {
    // Written by an older or newer build; the file's own parameters are what
    // the ciphertext was sealed under, so they are used verbatim rather than
    // being replaced with today's defaults.
    return {
      name: 'Argon2id',
      iterations: kdf.iterations,
      memoryKiB: kdf.memoryKiB ?? 0,
      parallelism: kdf.parallelism ?? 1,
      salt: fromBase64(kdf.salt),
    };
  }

  return null;
}

/**
 * Is this entry shaped like a document?
 *
 * A backup is a file the user picked off a disk, so it is untrusted input in
 * the same way an imported site profile is (`profile-transfer.ts`). `meta` is
 * plaintext, and the panel plans a derivation from it without unlocking:
 * width, height and a byte count that are not numbers would put the editor
 * into arithmetic on `undefined`. An entry that is not shaped right is
 * dropped, never repaired into something plausible.
 */
/** The same untrusted-input rule as a document: shaped like one, or dropped. */
function looksLikeSetting(row: SerializedSetting): boolean {
  return (
    typeof row.name === 'string' &&
    row.name !== '' &&
    typeof row.updatedAt === 'string' &&
    typeof row.iv === 'string' &&
    typeof row.ct === 'string'
  );
}

/** A sealed value as a backup carries it: base64 IV and ciphertext. */
function looksSealed(value: unknown): value is SerializedSealed {
  const sealed = value as Partial<SerializedSealed> | undefined;
  return (
    typeof sealed === 'object' &&
    sealed !== null &&
    typeof sealed.iv === 'string' &&
    typeof sealed.ct === 'string' &&
    typeof sealed.v === 'number'
  );
}

function looksLikeDocument(row: SerializedDocument): boolean {
  const meta = row.meta as Partial<DocumentMeta> | undefined;
  return (
    typeof row.id === 'string' &&
    row.id !== '' &&
    typeof row.label === 'string' &&
    typeof row.createdAt === 'string' &&
    typeof row.iv === 'string' &&
    typeof row.ct === 'string' &&
    typeof meta === 'object' &&
    meta !== null &&
    typeof meta.mime === 'string' &&
    typeof meta.bytes === 'number' &&
    typeof meta.width === 'number' &&
    typeof meta.height === 'number'
  );
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
  if (typeof file.version !== 'number' || !READABLE_BACKUP_VERSIONS.includes(file.version)) {
    // A file's job is to outlive the build that wrote it, in both directions:
    // version 1 is read as a backup that simply had no documents in it.
    throw new BackupFormatError(
      `This backup is version ${String(file.version)}; this build reads ` +
        `${READABLE_BACKUP_VERSIONS.join(' and ')}.`,
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

  const kdf = kdfFromBackup(file.kdf);
  if (!kdf) {
    throw new BackupFormatError(`Unsupported key derivation: ${file.kdf.name}.`);
  }

  const verifier = unseal(file.verifier);
  const key = await deriveKey(passphrase, kdf);
  if (!(await verifyPassphrase(key, verifier))) {
    return null;
  }

  const skippedKeys: string[] = [];
  const documents: StoredDocument[] = [];
  for (const row of file.documents ?? []) {
    if (!isFieldKey(row.key) || !isDocumentKey(row.key)) {
      skippedKeys.push(row.key);
      continue;
    }
    if (!looksLikeDocument(row)) continue;
    documents.push({
      id: row.id,
      key: row.key as FieldKey,
      label: row.label,
      meta: { ...row.meta, key: row.key as FieldKey },
      sealed: unseal(row),
      ...(looksSealed(row.password) ? { sealedPassword: unseal(row.password) } : {}),
      createdAt: row.createdAt,
    });
  }

  const settings: StoredSetting[] = [];
  for (const row of file.settings ?? []) {
    if (!looksLikeSetting(row)) continue;
    settings.push({ name: row.name, sealed: unseal(row), updatedAt: row.updatedAt });
  }

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

  const docTx = db.transaction('documents', 'readwrite');
  await Promise.all([...documents.map((d) => docTx.store.put(d)), docTx.done]);

  /*
   * Settings are replaced, not merged.
   *
   * `clearVault` leaves them alone — they outlive a vault being re-created on
   * purpose — but a *restore* is the user saying "this file is my vault now",
   * and a leftover API key or an old academic path from the vault being
   * replaced would be the one thing in there they did not choose.
   */
  if (file.settings !== undefined) {
    const settingsTx = db.transaction('settings', 'readwrite');
    await settingsTx.store.clear();
    await Promise.all([...settings.map((s) => settingsTx.store.put(s)), settingsTx.done]);
  }

  return { imported: records.length, documents: documents.length, skippedKeys };
}
