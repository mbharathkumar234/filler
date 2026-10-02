/**
 * The `.afvault` file format: constants and types, with **no runtime imports**.
 *
 * The one import here is a type, erased at build time, so the module still
 * pulls no runtime dependency into a UI bundle.
 *
 * Split out from `backup.ts` on purpose. The side panel needs the warning text
 * and the file extension; it must not need `crypto.ts`, `db.ts`, or `idb` to
 * get them. Keeping this module dependency-free is what stops the vault
 * implementation from being pulled into every UI bundle that mentions a backup.
 */

import type { DocumentMeta } from '@/shared/types';

export const BACKUP_FORMAT = 'afvault';
/** Version 2 carries the documents as well; version 1 carried the fields only. */
export const BACKUP_VERSION = 2;
export const READABLE_BACKUP_VERSIONS: readonly number[] = [1, 2];
export const BACKUP_EXTENSION = '.afvault';

/**
 * How much of a backup travels in one message.
 *
 * A vault of scans is tens of megabytes, and one `chrome.runtime` message that
 * size is refused — the same reason a fill carries documents inside a budget.
 * Export and import therefore move the file a piece at a time; the file itself
 * is ordinary JSON, and is never split anywhere but in transit.
 */
export const BACKUP_CHUNK_BYTES = 4 * 1024 * 1024;
/** A ceiling on a restore, so a malformed sender cannot fill the worker's heap. */
export const MAX_BACKUP_CHUNKS = 64;

/**
 * Shown verbatim before an export completes. The plan asks for
 * "scary-but-clear", and the point is that the file is exactly as sensitive as
 * the vault it came from.
 */
export const EXPORT_WARNING = [
  'This file contains your entire vault, encrypted with your passphrase.',
  'That includes your saved documents, so the file is as large as they are.',
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

/**
 * A stored document, as it travels.
 *
 * `meta` is the same plaintext description the vault keeps — dimensions and a
 * MIME type, which are not secrets and are what lets the panel show a slot
 * without unlocking. The bytes are the sealed ones, copied verbatim.
 */
export interface SerializedDocument extends SerializedSealed {
  id: string;
  key: string;
  label: string;
  meta: DocumentMeta;
  createdAt: string;
  /**
   * The password a locked PDF opens with, sealed, copied verbatim like the
   * bytes. Absent for every other document, and in a file written before it.
   */
  password?: SerializedSealed;
}

/**
 * A stored setting, as it travels.
 *
 * The academic path the vault is laid out from is one of these, and a restore
 * that dropped it would hand somebody back a vault holding all their documents
 * and no idea which ones they are. The API key travels too: the file is the
 * whole vault, sealed with the same passphrase, and the export warning says so.
 */
export interface SerializedSetting extends SerializedSealed {
  name: string;
  updatedAt: string;
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
  /** Absent in a version 1 file, which carried no documents. */
  documents?: SerializedDocument[];
  /** Absent in a version 1 file, and in a version 2 file written before this. */
  settings?: SerializedSetting[];
}

export interface ImportResult {
  imported: number;
  /** Documents restored. Zero for a version 1 backup, which had none. */
  documents: number;
  /** Keys in the file that are not in this build's taxonomy, and were skipped. */
  skippedKeys: string[];
}

/**
 * Cut a finished backup into pieces small enough to send.
 *
 * Never mid-character: a label in Kannada or an emoji in a document name is a
 * surrogate pair in a JavaScript string, and a cut between its halves would
 * put a broken character into two different messages. The pieces are joined
 * back with nothing between them, so `chunkBackup(text).join('') === text`.
 */
export function chunkBackup(text: string, size: number = BACKUP_CHUNK_BYTES): string[] {
  const pieces: string[] = [];
  for (let at = 0; at < text.length; ) {
    let end = Math.min(at + size, text.length);
    // 0xD800–0xDBFF is the first half of a pair; keep it with its second.
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    pieces.push(text.slice(at, end));
    at = end;
  }
  return pieces;
}

export class BackupFormatError extends Error {
  override readonly name = 'BackupFormatError';
}
