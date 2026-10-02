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
import { chunkBackup, exportVault, importVault } from '@/vault/backup';
import { deleteSetting, getSetting, putSetting, PATH_SETTING } from '@/vault/settings-store';
import { parsePath } from '@/matching/pathway';
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

/**
 * A backup in transit, held only between its first piece and its last.
 *
 * Both are ciphertext: the export is the sealed file itself, and the import is
 * the file the user chose. A worker restart drops them, which is why every
 * handler below says so plainly rather than resuming into a half file.
 */
let pendingExport: string[] | null = null;
let pendingImport: string[] | null = null;

/** Dropped when the vault locks, so nothing outlives the session that made it. */
export function forgetBackupsInFlight(): void {
  pendingExport = null;
  pendingImport = null;
}

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
        forgetBackupsInFlight();
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

      /*
       * A backup now carries the documents, so it is far too big for one
       * message. The worker writes the whole file, keeps it while the panel
       * collects it piece by piece, and lets it go with the last piece.
       *
       * Nothing here decrypts: the pieces are ciphertext, as the file is.
       */
      /*
       * The academic path: read and written like any other sealed setting.
       *
       * It is read back through `parsePath`, so a value written by a later
       * build — or by anything else that reached the vault — is refused here
       * rather than shaping the editor into something nobody chose.
       */
      case 'vault:path': {
        if (!isUnlocked()) throw new VaultLockedError();
        const stored = await withKey((db, key) => getSetting(db, key, PATH_SETTING));
        if (stored === null) return ok(null);
        try {
          return ok(parsePath(JSON.parse(stored)));
        } catch {
          return ok(null);
        }
      }

      case 'vault:set-path': {
        if (!isUnlocked()) throw new VaultLockedError();
        await withKey(async (db, key) => {
          if (request.path === null) await deleteSetting(db, PATH_SETTING);
          else await putSetting(db, key, PATH_SETTING, JSON.stringify(request.path));
        });
        touch();
        return ok(null);
      }

      case 'vault:export-begin': {
        if (!isUnlocked()) throw new VaultLockedError();
        const db = await openVaultDb();
        const meta = await readMeta(db);
        if (!meta) return err('There is no vault to export.');
        touch();

        const text = await exportVault(db, meta);
        pendingExport = chunkBackup(text);
        return ok({
          chunks: pendingExport.length,
          bytes: text.length,
          documents: await db.count('documents'),
        });
      }

      case 'vault:export-chunk': {
        if (!isUnlocked()) throw new VaultLockedError();
        const piece = pendingExport?.[request.index];
        if (pendingExport === null || piece === undefined) {
          return err('That export is no longer in progress. Start it again.');
        }
        touch();
        // The last piece completes the file; the worker keeps nothing after it.
        if (request.index === pendingExport.length - 1) pendingExport = null;
        return ok(piece);
      }

      case 'vault:import-chunk': {
        // Piece 0 starts a restore; anything out of order is refused rather
        // than stitched into a file the user never had.
        if (request.index === 0) pendingImport = [];
        if (pendingImport === null || request.index !== pendingImport.length) {
          return err('The backup arrived out of order. Choose the file again.');
        }
        pendingImport.push(request.text);
        return ok({ received: pendingImport.length });
      }

      case 'vault:import-commit': {
        if (pendingImport === null || pendingImport.length === 0) {
          return err('There is no backup waiting to be restored.');
        }
        const db = await openVaultDb();
        const result = await importVault(db, pendingImport.join(''), request.passphrase);
        // A wrong passphrase keeps the pieces, so the user can try again
        // without reading the whole file a second time.
        if (result === null) return ok(null);
        pendingImport = null;
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

/**
 * Every vault message, listed rather than matched by prefix.
 *
 * `startsWith('vault:')` routed anything spelled that way and silently dropped
 * anything not — which is what happened to `path:get`: a real handler existed
 * below, the panel called it, and the router answered "Unhandled request"
 * because the name did not start with the right five characters.
 *
 * The list is checked against the union by the compiler below, so a message
 * added to `VaultRequest` and forgotten here fails the build instead of
 * failing in front of a user.
 */
const VAULT_REQUEST_TYPES = [
  'vault:status',
  'vault:create',
  'vault:unlock',
  'vault:lock',
  'vault:list',
  'vault:set',
  'vault:delete',
  'vault:completeness',
  'vault:export-begin',
  'vault:export-chunk',
  'vault:import-chunk',
  'vault:import-commit',
  'vault:touch',
  'vault:path',

  'vault:set-path',
  'vault:reauth',
] as const;

/** A vault message this module can handle but nothing would route to it. */
type Unrouted = Exclude<VaultRequest['type'], (typeof VAULT_REQUEST_TYPES)[number]>;
/** A name in the list that is not a vault message at all. */
type NotAMessage = Exclude<(typeof VAULT_REQUEST_TYPES)[number], VaultRequest['type']>;
const ROUTING_IS_COMPLETE: [Unrouted, NotAMessage] extends [never, never] ? true : never = true;
void ROUTING_IS_COMPLETE;

const VAULT_TYPE_SET: ReadonlySet<string> = new Set(VAULT_REQUEST_TYPES);

export function isVaultRequest(type: string): type is VaultRequest['type'] {
  return VAULT_TYPE_SET.has(type);
}
