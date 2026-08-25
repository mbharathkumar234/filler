/**
 * Vault crypto (§ Phase 1).
 *
 *   AES-GCM 256, key derived from the user's passphrase via PBKDF2-SHA256 at
 *   >=600k iterations, per-vault random salt, per-record random IV.
 *
 * Design notes that matter:
 *
 *  - The derived key is **non-extractable**. Even code inside the extension
 *    cannot read the raw bytes back out of the `CryptoKey`, which limits the
 *    blast radius of an accidental log or a serialisation bug.
 *  - AES-GCM authenticates. A flipped ciphertext byte, an altered IV, or a
 *    truncated tag all make `decrypt` throw rather than return garbage — that
 *    is the tamper detection the plan requires, and it is why nothing here
 *    rolls its own MAC.
 *  - Nothing in this module touches storage, the DOM, or the network. It is a
 *    pure function library so it can be unit-tested without a browser.
 */

/** Shipping iteration count. The plan's floor is 600k; do not lower it. */
export const KDF_ITERATIONS = 600_000;

/** Per-vault salt length in bytes. */
export const SALT_BYTES = 16;

/** Per-record IV length in bytes. 96 bits is the AES-GCM recommended size. */
export const IV_BYTES = 12;

/** Current sealed-record format version. Bump when the envelope changes. */
export const RECORD_VERSION = 1;

/** Known plaintext used to check a passphrase without decrypting real data. */
const VERIFIER_PLAINTEXT = 'autofill-assistant/vault/v1';

export interface KdfParams {
  readonly name: 'PBKDF2-SHA256';
  readonly iterations: number;
  readonly salt: Uint8Array;
}

export interface SealedRecord {
  readonly v: number;
  readonly iv: Uint8Array;
  /** Ciphertext with the AES-GCM authentication tag appended. */
  readonly ct: Uint8Array;
}

/**
 * Thrown whenever a decrypt fails, for any reason — wrong key, tampered
 * ciphertext, altered IV, truncated tag.
 *
 * The message is deliberately uninformative: distinguishing "wrong passphrase"
 * from "tampered record" for a caller would also distinguish them for an
 * attacker probing the vault. It never contains plaintext.
 */
export class VaultDecryptError extends Error {
  override readonly name = 'VaultDecryptError';
  constructor() {
    super('Unable to decrypt: wrong passphrase or the record has been altered.');
  }
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

export function newSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SALT_BYTES));
}

/** KDF parameters for a brand-new vault. */
export function newKdfParams(): KdfParams {
  return { name: 'PBKDF2-SHA256', iterations: KDF_ITERATIONS, salt: newSalt() };
}

/**
 * Derive the vault's AES-GCM key from a passphrase.
 *
 * The returned key is non-extractable and lives only as long as the caller
 * holds a reference to it (§ Phase 1: "held only in the service worker's
 * memory, never persisted").
 */
export async function deriveKey(passphrase: string, params: KdfParams): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: bufferSource(params.salt),
      iterations: params.iterations,
    },
    material,
    { name: 'AES-GCM', length: 256 },
    /* extractable */ false,
    ['encrypt', 'decrypt'],
  );
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt
// ---------------------------------------------------------------------------

export async function encryptBytes(key: CryptoKey, plaintext: Uint8Array): Promise<SealedRecord> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: bufferSource(iv) },
    key,
    bufferSource(plaintext),
  );
  return { v: RECORD_VERSION, iv, ct: new Uint8Array(ct) };
}

export async function decryptBytes(key: CryptoKey, record: SealedRecord): Promise<Uint8Array> {
  if (record.v !== RECORD_VERSION) {
    throw new VaultDecryptError();
  }
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bufferSource(record.iv) },
      key,
      bufferSource(record.ct),
    );
    return new Uint8Array(plain);
  } catch {
    // Swallow the underlying OperationError on purpose — see VaultDecryptError.
    throw new VaultDecryptError();
  }
}

export async function encryptText(key: CryptoKey, plaintext: string): Promise<SealedRecord> {
  return encryptBytes(key, new TextEncoder().encode(plaintext));
}

export async function decryptText(key: CryptoKey, record: SealedRecord): Promise<string> {
  return new TextDecoder().decode(await decryptBytes(key, record));
}

// ---------------------------------------------------------------------------
// Passphrase verification
// ---------------------------------------------------------------------------

/**
 * Seal a known plaintext under the vault key. Stored in vault metadata so an
 * unlock attempt can be checked without touching a single real record — which
 * is what makes a wrong passphrase a clean failure rather than a cascade of
 * decrypt errors across the whole profile.
 */
export async function createVerifier(key: CryptoKey): Promise<SealedRecord> {
  return encryptText(key, VERIFIER_PLAINTEXT);
}

export async function verifyPassphrase(key: CryptoKey, verifier: SealedRecord): Promise<boolean> {
  try {
    return (await decryptText(key, verifier)) === VERIFIER_PLAINTEXT;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Codec — used by the .afvault backup format, not by IndexedDB (which stores
// Uint8Array natively).
// ---------------------------------------------------------------------------

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  // Chunked to avoid blowing the argument limit on large document blobs.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  if (!BASE64_RE.test(value)) {
    throw new Error('Invalid base64 input.');
  }
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Narrow a Uint8Array to the exact bytes it views.
 *
 * A Uint8Array can be a window onto a larger ArrayBuffer; handing WebCrypto the
 * underlying buffer would silently encrypt or authenticate the wrong bytes.
 */
function bufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
