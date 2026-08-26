/**
 * Vault request handlers for the background service worker.
 *
 * This module is the *only* bridge between the message bus and the unlocked
 * key. Keeping it separate from `index.ts` means the privileged surface is one
 * file a reviewer can read end to end (§ Phase 10: "content-script isolation
 * review").
 */

import type { Result, VaultRequest, ResponseMap } from '@/shared/messages';
import { openVaultDb, readMeta } from '@/vault/db';
import { exportVault, importVault } from '@/vault/backup';
import {
  completeness,
  deleteField,
  getAllFields,
  setField,
} from '@/vault/profile-store';
import {
  VaultLockedError,
  WeakPassphraseError,
  createVault,
  getStatus,
  isUnlocked,
  lockVault,
  touch,
  unlockVault,
  withKey,
} from '@/vault/session';

function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

function err(error: string, code?: string): Result<never> {
  return code === undefined ? { ok: false, error } : { ok: false, error, code };
}

/**
 * Handle one vault request.
 *
 * Errors are converted to a `Result`, never thrown across the bus — an
 * unhandled rejection in a service worker is invisible to the UI, which would
 * leave the user staring at a spinner.
 */
export async function handleVaultRequest(
  request: VaultRequest,
): Promise<Result<ResponseMap[VaultRequest['type']]>> {
  try {
    switch (request.type) {
      case 'vault:status':
        return ok(await getStatus());

      case 'vault:create':
        await createVault(request.passphrase);
        return ok(null);

      case 'vault:unlock':
        return ok(await unlockVault(request.passphrase));

      /**
       * § Phase 6 re-auth gate. Deliberately the same code path as an unlock:
       * it re-derives the key from the passphrase, so a wrong one fails for
       * the same reason it always did, and a right one resets the
       * authentication clock as a side effect of actually proving identity.
       * A cheaper "just compare a hash" version would be a different, weaker
       * check wearing the same name.
       */
      case 'vault:reauth':
        return ok(await unlockVault(request.passphrase));

      case 'vault:lock':
        lockVault();
        return ok(null);

      case 'vault:touch':
        touch();
        return ok(null);

      case 'vault:list':
        return ok(await withKey((db, key) => getAllFields(db, key)));

      case 'vault:set':
        // A value read off a scanned card is recorded as `extracted`, not as
        // something the user typed. If a misread ever does get past the
        // suggestion screen, this is what makes it findable afterwards.
        await withKey((db, key) =>
          setField(db, key, request.key, request.value, request.fromDocument === true ? 'extracted' : 'user'),
        );
        return ok(null);

      case 'vault:delete':
        // Deleting needs an unlocked vault too — otherwise anything with bus
        // access could wipe the profile without proving it knows the passphrase.
        if (!isUnlocked()) throw new VaultLockedError();
        await deleteField(await openVaultDb(), request.key);
        return ok(null);

      case 'vault:completeness':
        if (!isUnlocked()) throw new VaultLockedError();
        return ok(await completeness(await openVaultDb()));

      case 'vault:export': {
        if (!isUnlocked()) throw new VaultLockedError();
        const db = await openVaultDb();
        const meta = await readMeta(db);
        if (!meta) return err('There is no vault to export.');
        touch();
        return ok(await exportVault(db, meta));
      }

      case 'vault:import': {
        const db = await openVaultDb();
        const result = await importVault(db, request.text, request.passphrase);
        if (result === null) return ok(null);
        // The imported vault has different KDF params; force a fresh unlock.
        lockVault();
        return ok(result);
      }
    }
  } catch (error) {
    if (error instanceof VaultLockedError) {
      return err(error.message, 'VAULT_LOCKED');
    }
    if (error instanceof WeakPassphraseError) {
      return err(error.feedback.join(' '), 'WEAK_PASSPHRASE');
    }
    return err(error instanceof Error ? error.message : 'Unexpected vault error.');
  }
}

export function isVaultRequest(type: string): type is VaultRequest['type'] {
  return type.startsWith('vault:');
}
