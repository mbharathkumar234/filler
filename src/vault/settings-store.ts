/**
 * Sealed settings (§ Phase 8).
 *
 * One thing lives here so far: the Anthropic API key. It is encrypted under
 * the vault key like everything else the user would mind losing, which has a
 * consequence worth stating plainly — **the model can only be used while the
 * vault is unlocked.** That is the right coupling: the LLM exists to help fill
 * a form, and filling needs the vault open anyway.
 *
 * The alternative, `chrome.storage.local`, would leave a working credential in
 * a file that anyone with the user's profile directory can read. The threat
 * model already names a compromised API key as an adversary; making that
 * adversary need the passphrase too is cheap.
 */

import { decryptText, encryptText, VaultDecryptError } from './crypto';
import type { StoredSetting, VaultDb } from './db';

export const API_KEY_SETTING = 'llm.apiKey';
export const MODEL_SETTING = 'llm.model';
/**
 * The user's own academic path (§ vault structure), as JSON.
 *
 * Sealed like every other setting, because it names a reservation category.
 * It decides which blocks and slots the editor offers, so it is configuration
 * rather than a value any form is ever filled from.
 */
export const PATH_SETTING = 'vault.path';

export async function putSetting(
  db: VaultDb,
  cryptoKey: CryptoKey,
  name: string,
  value: string,
): Promise<void> {
  const record: StoredSetting = {
    name,
    sealed: await encryptText(cryptoKey, value),
    updatedAt: new Date().toISOString(),
  };
  await db.put('settings', record);
}

/**
 * Read a setting back.
 *
 * A record that will not decrypt returns null rather than throwing: it means
 * the vault was re-created under a new passphrase and this leftover is not
 * recoverable. The user's next step is to re-enter the key, not to see a
 * crash from a settings read.
 */
export async function getSetting(
  db: VaultDb,
  cryptoKey: CryptoKey,
  name: string,
): Promise<string | null> {
  const record = await db.get('settings', name);
  if (!record) return null;
  try {
    return await decryptText(cryptoKey, record.sealed);
  } catch (error) {
    if (error instanceof VaultDecryptError) return null;
    throw error;
  }
}

export async function deleteSetting(db: VaultDb, name: string): Promise<void> {
  await db.delete('settings', name);
}

/** Is a key present at all? Answered without decrypting it. */
export async function hasSetting(db: VaultDb, name: string): Promise<boolean> {
  return (await db.get('settings', name)) !== undefined;
}

/**
 * A key with its middle removed, for display.
 *
 * The settings screen has to show *something* so the user can tell one key
 * from another, and showing the whole thing means it sits on screen in an
 * office. The last four characters are enough to distinguish two keys.
 */
export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '•'.repeat(trimmed.length);
  return `${trimmed.slice(0, 7)}…${trimmed.slice(-4)}`;
}
