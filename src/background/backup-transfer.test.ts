import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteDB } from 'idb';

/**
 * A backup crossing the bus in pieces (§ Phase 1 export, extended).
 *
 * A vault that carries the documents is tens of megabytes, and one
 * `chrome.runtime` message that size is refused — so the file is written once
 * in the worker and collected piece by piece. What is worth testing is not the
 * arithmetic but the states around it: a restore that arrives out of order, a
 * wrong passphrase that must not cost the user the whole upload again, and an
 * export that is finished with.
 */

const session = { unlocked: true };
vi.mock('@/vault/session', () => ({
  isUnlocked: () => session.unlocked,
  lockVault: () => {
    session.unlocked = false;
  },
  touch: () => {},
  withKey: async () => {
    throw new Error('not used here');
  },
  createVault: async () => {},
  unlockVault: async () => false,
  getStatus: async () => ({ exists: true, unlocked: session.unlocked }),
  VaultLockedError: class VaultLockedError extends Error {
    constructor() {
      super('The vault is locked.');
    }
  },
  WeakPassphraseError: class WeakPassphraseError extends Error {},
}));

const { handleVaultRequest, forgetBackupsInFlight } = await import('./vault-service');
const { DB_NAME, closeVaultDb, openVaultDb, writeMeta } = await import('@/vault/db');
const { createVerifier, deriveKey, newSalt } = await import('@/vault/crypto');
const { putMaster } = await import('@/vault/document-store');
const { setField } = await import('@/vault/profile-store');
const { chunkBackup, parseBackup } = await import('@/vault/backup');

const PASSPHRASE = 'correct horse battery staple';
/** Cheap on purpose; the shipped parameters are asserted in `kdf-migration.test.ts`. */
const TEST_KDF = { name: 'Argon2id', memoryKiB: 1_024, iterations: 1, parallelism: 1 } as const;

async function reset(): Promise<void> {
  await closeVaultDb();
  await deleteDB(DB_NAME);
}

async function seed(documentBytes = 32): Promise<void> {
  const db = await openVaultDb();
  const kdf = { ...TEST_KDF, salt: newSalt() };
  const key = await deriveKey(PASSPHRASE, kdf);
  await writeMeta(db, {
    id: 'vault',
    schemaVersion: 1,
    kdf,
    verifier: await createVerifier(key),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await setField(db, key, 'identity.full_name', 'Ravi Kumar');

  // Filled a page at a time: `getRandomValues` takes 64 KB per call, and a
  // six-megabyte scan is the point of the test below.
  const bytes = new Uint8Array(documentBytes);
  for (let at = 0; at < bytes.length; at += 65_536) {
    crypto.getRandomValues(bytes.subarray(at, Math.min(at + 65_536, bytes.length)));
  }
  await putMaster(db, key, {
    key: 'doc.marksheet_10',
    label: 'Class 10 marks card',
    bytes,
    meta: {
      mime: 'application/pdf',
      bytes: bytes.length,
      width: 0,
      height: 0,
      capturedAt: '2026-01-01T00:00:00.000Z',
    },
  });
}

/**
 * Collect a whole export, as the panel does.
 *
 * `handleVaultRequest` answers with the union of every vault response, which
 * the request type does not narrow; the panel gets the narrow type from
 * `send`. Here it is stated once, at the one call that needs it.
 */
async function exportAll(): Promise<{ text: string; documents: number; chunks: number }> {
  const begun = (await handleVaultRequest({ type: 'vault:export-begin' })) as
    | { ok: true; data: { chunks: number; bytes: number; documents: number } }
    | { ok: false; error: string };
  if (!begun.ok) throw new Error(begun.error);

  const parts: string[] = [];
  for (let index = 0; index < begun.data.chunks; index += 1) {
    const piece = await handleVaultRequest({ type: 'vault:export-chunk', index });
    if (!piece.ok) throw new Error(piece.error);
    parts.push(piece.data as string);
  }
  return { text: parts.join(''), documents: begun.data.documents, chunks: begun.data.chunks };
}

beforeEach(async () => {
  session.unlocked = true;
  forgetBackupsInFlight();
  await reset();
  await seed();
});

describe('exporting in pieces', () => {
  it('hands over a whole, parseable backup with the documents in it', async () => {
    const { text, documents } = await exportAll();

    expect(documents).toBe(1);
    const file = parseBackup(text);
    expect(file.records).toHaveLength(1);
    expect(file.documents).toHaveLength(1);
    expect(file.documents?.[0]?.label).toBe('Class 10 marks card');
  });

  it('splits a vault too big for one message, and joins back to the same file', async () => {
    await reset();
    // Six megabytes of scan: past one message, and past one piece.
    await seed(6 * 1024 * 1024);

    const { text, chunks } = await exportAll();

    expect(chunks).toBeGreaterThan(1);
    expect(() => parseBackup(text)).not.toThrow();
  });

  it('keeps nothing once the last piece has been handed over', async () => {
    const { chunks } = await exportAll();

    const again = await handleVaultRequest({ type: 'vault:export-chunk', index: chunks - 1 });
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.error).toMatch(/no longer in progress/);
  });

  it('refuses to export a locked vault', async () => {
    session.unlocked = false;
    const begun = await handleVaultRequest({ type: 'vault:export-begin' });
    expect(begun.ok).toBe(false);
  });
});

describe('restoring from pieces', () => {
  async function send(parts: string[]): Promise<void> {
    for (let index = 0; index < parts.length; index += 1) {
      const sent = await handleVaultRequest({ type: 'vault:import-chunk', index, text: parts[index]! });
      if (!sent.ok) throw new Error(sent.error);
    }
  }

  it('restores the fields and the documents together', async () => {
    const { text } = await exportAll();
    await reset();

    await send([text.slice(0, 100), text.slice(100)]);
    const result = await handleVaultRequest({ type: 'vault:import-commit', passphrase: PASSPHRASE });

    expect(result.ok && result.data).toMatchObject({ imported: 1, documents: 1 });
  });

  it('restores a vault whose documents are megabytes, not bytes', async () => {
    /*
     * The gap that let "replace this vault" ship broken: the six-megabyte case
     * was only ever *exported* in a test. Importing one died on the first
     * document it reached — the check that a string is base64 was a regular
     * expression, and V8 recurses on it past a few megabytes — so a real
     * backup of 110 fields and nine documents could not be restored at all.
     */
    await reset();
    await seed(6 * 1024 * 1024);
    const { text } = await exportAll();
    await reset();

    await send(chunkBackup(text));
    const result = await handleVaultRequest({ type: 'vault:import-commit', passphrase: PASSPHRASE });

    expect(result.ok && result.data).toMatchObject({ imported: 1, documents: 1 });
  });

  it('keeps the pieces when the passphrase is wrong, so they are not sent twice', async () => {
    const { text } = await exportAll();
    await send([text]);

    const wrong = await handleVaultRequest({ type: 'vault:import-commit', passphrase: 'not it' });
    expect(wrong.ok && wrong.data).toBeNull();

    // The same pieces, a second guess — and no second upload.
    const right = await handleVaultRequest({ type: 'vault:import-commit', passphrase: PASSPHRASE });
    expect(right.ok && right.data).toMatchObject({ documents: 1 });
  });

  it('refuses a piece that arrives out of order rather than stitching a file nobody had', async () => {
    const out = await handleVaultRequest({ type: 'vault:import-chunk', index: 3, text: '{}' });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toMatch(/out of order/);
  });

  it('refuses to commit when no pieces have arrived', async () => {
    const commit = await handleVaultRequest({ type: 'vault:import-commit', passphrase: PASSPHRASE });
    expect(commit.ok).toBe(false);
  });

  it('starts a fresh restore when piece 0 arrives again', async () => {
    const { text } = await exportAll();
    await send(['{"half of an abandoned attempt"']);

    // Choosing the file again starts at zero, and the abandoned half is gone.
    await send([text]);
    const result = await handleVaultRequest({ type: 'vault:import-commit', passphrase: PASSPHRASE });
    expect(result.ok && result.data).toMatchObject({ imported: 1, documents: 1 });
  });
});
