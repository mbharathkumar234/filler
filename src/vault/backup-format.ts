/**
 * The `.afvault` file format: constants and types, with **no runtime imports**.
 *
 * Split out from `backup.ts` on purpose. The side panel needs the warning text
 * and the file extension; it must not need `crypto.ts`, `db.ts`, or `idb` to
 * get them. Keeping this module dependency-free is what stops the vault
 * implementation from being pulled into every UI bundle that mentions a backup.
 */

export const BACKUP_FORMAT = 'afvault';
export const BACKUP_VERSION = 1;
export const BACKUP_EXTENSION = '.afvault';

/**
 * Shown verbatim before an export completes. The plan asks for
 * "scary-but-clear", and the point is that the file is exactly as sensitive as
 * the vault it came from.
 */
export const EXPORT_WARNING = [
  'This file contains your entire vault, encrypted with your passphrase.',
  'Anyone who has BOTH this file and your passphrase has your Aadhaar, PAN, bank details, and documents.',
  'There is no recovery. If you forget the passphrase, this file is permanently unreadable — nobody can reset it.',
  'Store it offline. Do not email it to yourself, and do not put it in shared cloud storage.',
] as const;

export const IMPORT_WARNING = [
  'Importing REPLACES the vault currently on this device. Anything not in the backup is lost.',
  'You will need the passphrase that was in use when this backup was created.',
] as const;

export interface SerializedSealed {
  v: number;
  iv: string;
  ct: string;
}

export interface SerializedRecord extends SerializedSealed {
  key: string;
  verifiedAt: string;
  source: string;
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  /**
   * The KDF the backup was sealed under.
   *
   * `memoryKiB`/`parallelism` are present for an Argon2id backup and absent
   * for a PBKDF2 one written before Phase 10 — both must keep importing, in
   * both directions, or a backup becomes a thing that expires.
   */
  kdf: {
    name: string;
    iterations: number;
    salt: string;
    memoryKiB?: number;
    parallelism?: number;
  };
  verifier: SerializedSealed;
  records: SerializedRecord[];
}

export interface ImportResult {
  imported: number;
  /** Keys in the file that are not in this build's taxonomy, and were skipped. */
  skippedKeys: string[];
}

export class BackupFormatError extends Error {
  override readonly name = 'BackupFormatError';
}
