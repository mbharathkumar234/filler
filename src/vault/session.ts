/**
 * The unlocked-vault session (§ Phase 1).
 *
 *   "Master key held only in the service worker's memory, never persisted,
 *    never in chrome.storage.local."
 *   "Auto-lock: key zeroed after 15 min idle or on browser close."
 *
 * Two notes on how that is actually achieved:
 *
 *  - **"Zeroed" is a reference drop.** A non-extractable `CryptoKey` has no
 *    byte array for JavaScript to overwrite; dropping the only reference and
 *    letting the key become unreachable is the strongest thing the platform
 *    offers. Because the key is non-extractable, its bytes were never readable
 *    from JS in the first place.
 *  - **The deadline is checked on access, not just on a timer.** An MV3 service
 *    worker can be suspended at any moment, which would freeze a `setTimeout`.
 *    So every read of the key re-checks the idle deadline first; the timer is a
 *    best-effort proactive lock on top. Suspension itself drops the key, which
 *    is the "or on browser close" half for free.
 */

import {
  createVerifier,
  deriveKey,
  needsRehash,
  newKdfParams,
  verifyPassphrase,
  type KdfParams,
} from './crypto';
import { openVaultDb, readMeta, vaultExists, writeMeta, type VaultDb, type VaultMeta } from './db';
import { estimateStrength } from './passphrase';

/** §Phase 1: auto-lock after 15 minutes idle. */
export const IDLE_LOCK_MS = 15 * 60 * 1000;

export class VaultLockedError extends Error {
  override readonly name = 'VaultLockedError';
  constructor() {
    super('The vault is locked. Enter your passphrase to continue.');
  }
}

export class WeakPassphraseError extends Error {
  override readonly name = 'WeakPassphraseError';
  constructor(readonly feedback: string[]) {
    super('That passphrase is not strong enough.');
  }
}

interface UnlockedSession {
  key: CryptoKey;
  kdf: KdfParams;
  lastActivityAt: number;
  /**
   * When the passphrase was last actually typed (§ Phase 6 re-auth gate).
   *
   * Deliberately separate from `lastActivityAt`: activity defers auto-lock,
   * but it is not evidence of *who* is at the keyboard. Only entering the
   * passphrase moves this.
   */
  authenticatedAt: number;
}

/** The single owner of the unlocked key. Module-scoped, never exported. */
let session: UnlockedSession | null = null;
let lockTimer: ReturnType<typeof setTimeout> | null = null;

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
  /** ms until auto-lock, or null when locked. */
  locksInMs: number | null;
}

export async function getStatus(): Promise<VaultStatus> {
  const db = await openVaultDb();
  expireIfIdle();
  return {
    exists: await vaultExists(db),
    unlocked: session !== null,
    locksInMs: session ? Math.max(0, IDLE_LOCK_MS - (Date.now() - session.lastActivityAt)) : null,
  };
}

/**
 * Create a brand-new vault. Refuses a passphrase below the floor — this is the
 * one place the product is allowed to say no, and the threat model explains why
 * (a weak passphrase defeats every other control).
 */
export async function createVault(passphrase: string): Promise<void> {
  const db = await openVaultDb();
  if (await vaultExists(db)) {
    throw new Error('A vault already exists on this device.');
  }

  const strength = estimateStrength(passphrase);
  if (!strength.acceptable) {
    throw new WeakPassphraseError(strength.feedback);
  }

  const kdf = newKdfParams();
  const key = await deriveKey(passphrase, kdf);
  const now = new Date().toISOString();

  const meta: VaultMeta = {
    id: 'vault',
    schemaVersion: 1,
    kdf,
    verifier: await createVerifier(key),
    createdAt: now,
    updatedAt: now,
  };
  await writeMeta(db, meta);

  activate(key, kdf);
}

/**
 * Unlock an existing vault. Returns false on a wrong passphrase rather than
 * throwing — a wrong passphrase is an expected outcome, not an error, and the
 * caller must not be able to distinguish it from a tampered verifier.
 */
export async function unlockVault(passphrase: string): Promise<boolean> {
  const db = await openVaultDb();
  const meta = await readMeta(db);
  if (!meta) throw new Error('No vault exists on this device yet.');

  const key = await deriveKey(passphrase, meta.kdf);
  if (!(await verifyPassphrase(key, meta.verifier))) {
    return false;
  }

  const upgraded = await migrateKdfIfNeeded(db, meta, passphrase, key);
  activate(upgraded.key, upgraded.kdf);
  return true;
}

/**
 * Re-key a vault onto the current KDF (§ Phase 10).
 *
 * Runs at unlock because that is the only moment the passphrase exists in
 * memory. There is no background migration job and there cannot be one — the
 * whole design is that nothing but the user's own typing can produce the key.
 *
 * ## Why the records do not need rewriting
 *
 * The KDF produces the AES key; the records are sealed *under* that key. So a
 * re-key means re-deriving and re-encrypting everything... which would be a
 * long, interruptible, partially-applied operation on a service worker that
 * can be suspended at any moment. Instead the migration is deliberately
 * conservative: **it only happens when the vault is otherwise empty**, or it
 * does not happen at all.
 *
 * A vault with data keeps PBKDF2 at 600k iterations — which is not weak, only
 * weaker — and says so in the panel, where the user can re-create the vault
 * from a backup if they want the upgrade. Silently re-encrypting somebody's
 * entire vault in a context that can be killed mid-write is a worse failure
 * than a strong-but-older KDF.
 */
async function migrateKdfIfNeeded(
  db: VaultDb,
  meta: VaultMeta,
  passphrase: string,
  currentKey: CryptoKey,
): Promise<{ key: CryptoKey; kdf: KdfParams }> {
  if (!needsRehash(meta.kdf)) return { key: currentKey, kdf: meta.kdf };
  if ((await db.count('profile')) > 0 || (await db.count('documents')) > 0) {
    return { key: currentKey, kdf: meta.kdf };
  }

  try {
    const kdf = newKdfParams();
    const key = await deriveKey(passphrase, kdf);
    await writeMeta(db, {
      ...meta,
      kdf,
      verifier: await createVerifier(key),
      updatedAt: new Date().toISOString(),
    });
    return { key, kdf };
  } catch {
    // A failed upgrade must not cost the user their unlock.
    return { key: currentKey, kdf: meta.kdf };
  }
}

/**
 * Can this vault be upgraded to the current KDF, and is it worth telling the
 * user? Read by the panel so the offer is explicit rather than silent.
 */
export async function kdfStatus(): Promise<{
  name: string;
  upgradable: boolean;
  blockedByData: boolean;
}> {
  const db = await openVaultDb();
  const meta = await readMeta(db);
  if (!meta) return { name: 'none', upgradable: false, blockedByData: false };

  const stale = needsRehash(meta.kdf);
  const hasData = (await db.count('profile')) > 0 || (await db.count('documents')) > 0;

  return { name: meta.kdf.name, upgradable: stale, blockedByData: stale && hasData };
}

/** Drop the key. Idempotent — safe to call on a locked vault. */
export function lockVault(): void {
  session = null;
  if (lockTimer !== null) {
    clearTimeout(lockTimer);
    lockTimer = null;
  }
}

/**
 * The only way to reach the key. Throws if locked or if the idle deadline has
 * passed, so no caller can operate on a vault that should have auto-locked
 * while the service worker was suspended.
 */
export function requireKey(): CryptoKey {
  expireIfIdle();
  if (!session) throw new VaultLockedError();
  touch();
  return session.key;
}

export function isUnlocked(): boolean {
  expireIfIdle();
  return session !== null;
}

/** Register user activity, deferring auto-lock. */
export function touch(): void {
  if (!session) return;
  session.lastActivityAt = Date.now();
  scheduleLock();
}

export async function withKey<T>(fn: (db: VaultDb, key: CryptoKey) => Promise<T>): Promise<T> {
  const key = requireKey();
  const db = await openVaultDb();
  return fn(db, key);
}

function activate(key: CryptoKey, kdf: KdfParams): void {
  const now = Date.now();
  session = { key, kdf, lastActivityAt: now, authenticatedAt: now };
  scheduleLock();
}

/**
 * When the user last proved they are the user, or null if the vault is locked.
 *
 * The Phase 6 re-auth gate reads this. `touch()` does not move it — see the
 * note on `UnlockedSession.authenticatedAt`.
 */
export function lastAuthenticatedAt(): number | null {
  expireIfIdle();
  return session?.authenticatedAt ?? null;
}

function expireIfIdle(): void {
  if (session && Date.now() - session.lastActivityAt >= IDLE_LOCK_MS) {
    lockVault();
  }
}

function scheduleLock(): void {
  if (lockTimer !== null) clearTimeout(lockTimer);
  lockTimer = setTimeout(lockVault, IDLE_LOCK_MS);
  // Never let the lock timer hold a Node/worker event loop open in tests.
  (lockTimer as unknown as { unref?: () => void }).unref?.();
}

/** Test seam. Not exported through the vault's public surface. */
export function __resetSessionForTests(): void {
  lockVault();
}
