import { describe, expect, it } from 'vitest';
import {
  KDF_ITERATIONS,
  IV_BYTES,
  SALT_BYTES,
  VaultDecryptError,
  createVerifier,
  decryptBytes,
  decryptText,
  deriveKey,
  encryptBytes,
  encryptText,
  fromBase64,
  newKdfParams,
  newSalt,
  toBase64,
  verifyPassphrase,
} from './crypto';

/**
 * Written before crypto.ts, per §7 Session 2. The tamper-detection test is the
 * one that matters most: AES-GCM's authentication tag is what turns "someone
 * edited my IndexedDB" from silent data corruption into a loud failure.
 *
 * Tests derive keys at a low iteration count for speed. `KDF_ITERATIONS` — the
 * value the product actually ships — is asserted separately.
 */

const TEST_ITERATIONS = 1_000;

async function testKey(passphrase = 'correct horse battery staple') {
  const params = { ...newKdfParams(), iterations: TEST_ITERATIONS };
  return { key: await deriveKey(passphrase, params), params };
}

describe('KDF parameters', () => {
  it('ships at or above the 600k iteration floor required by the plan', () => {
    expect(KDF_ITERATIONS).toBeGreaterThanOrEqual(600_000);
  });

  it('generates a fresh random salt of the documented length', () => {
    const a = newSalt();
    const b = newSalt();
    expect(a).toHaveLength(SALT_BYTES);
    expect(b).toHaveLength(SALT_BYTES);
    expect(toBase64(a)).not.toBe(toBase64(b));
  });

  it('defaults new vaults to the shipping iteration count', () => {
    expect(newKdfParams().iterations).toBe(KDF_ITERATIONS);
  });

  it('derives a non-extractable key', async () => {
    const { key } = await testKey();
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });

  it('derives the same key material from the same passphrase and salt', async () => {
    const params = { ...newKdfParams(), iterations: TEST_ITERATIONS };
    const k1 = await deriveKey('same passphrase', params);
    const k2 = await deriveKey('same passphrase', params);
    const sealed = await encryptText(k1, 'round trip');
    await expect(decryptText(k2, sealed)).resolves.toBe('round trip');
  });

  it('derives different keys from the same passphrase under different salts', async () => {
    const p1 = { ...newKdfParams(), iterations: TEST_ITERATIONS };
    const p2 = { ...newKdfParams(), iterations: TEST_ITERATIONS };
    const k1 = await deriveKey('same passphrase', p1);
    const k2 = await deriveKey('same passphrase', p2);
    const sealed = await encryptText(k1, 'secret');
    await expect(decryptText(k2, sealed)).rejects.toThrow(VaultDecryptError);
  });
});

describe('encrypt / decrypt', () => {
  it('round-trips text', async () => {
    const { key } = await testKey();
    const sealed = await encryptText(key, 'Aadhaar: 0000 0000 0000');
    await expect(decryptText(key, sealed)).resolves.toBe('Aadhaar: 0000 0000 0000');
  });

  it('round-trips arbitrary bytes', async () => {
    const { key } = await testKey();
    const bytes = crypto.getRandomValues(new Uint8Array(4096));
    const sealed = await encryptBytes(key, bytes);
    const out = await decryptBytes(key, sealed);
    expect(toBase64(out)).toBe(toBase64(bytes));
  });

  it('round-trips unicode without mangling it', async () => {
    const { key } = await testKey();
    const value = 'पिता का नाम — Ravi Kumar 🙂';
    const sealed = await encryptText(key, value);
    await expect(decryptText(key, sealed)).resolves.toBe(value);
  });

  it('round-trips an empty value', async () => {
    const { key } = await testKey();
    const sealed = await encryptText(key, '');
    await expect(decryptText(key, sealed)).resolves.toBe('');
  });

  it('uses a fresh random IV per record', async () => {
    const { key } = await testKey();
    const a = await encryptText(key, 'identical plaintext');
    const b = await encryptText(key, 'identical plaintext');
    expect(a.iv).toHaveLength(IV_BYTES);
    expect(toBase64(a.iv)).not.toBe(toBase64(b.iv));
    // Same plaintext under a fresh IV must not produce the same ciphertext.
    expect(toBase64(a.ct)).not.toBe(toBase64(b.ct));
  });

  it('does not leave the plaintext recoverable from the sealed record', async () => {
    const { key } = await testKey();
    const sealed = await encryptText(key, 'SENSITIVE-MARKER-VALUE');
    const asText = new TextDecoder().decode(sealed.ct);
    expect(asText).not.toContain('SENSITIVE-MARKER-VALUE');
    expect(toBase64(sealed.ct)).not.toContain('SENSITIVE');
  });

  it('stamps a version on every sealed record so the format can migrate', async () => {
    const { key } = await testKey();
    const sealed = await encryptText(key, 'x');
    expect(sealed.v).toBe(1);
  });
});

describe('tamper detection', () => {
  it('throws when a ciphertext byte is flipped', async () => {
    const { key } = await testKey();
    const sealed = await encryptText(key, 'transfer 100 rupees');

    const tampered = { ...sealed, ct: Uint8Array.from(sealed.ct) };
    tampered.ct[0]! ^= 0x01;

    await expect(decryptText(key, tampered)).rejects.toThrow(VaultDecryptError);
  });

  it('throws when a byte anywhere in the ciphertext is flipped', async () => {
    const { key } = await testKey();
    const sealed = await encryptText(key, 'x'.repeat(512));

    for (const index of [1, 100, sealed.ct.length - 1]) {
      const tampered = { ...sealed, ct: Uint8Array.from(sealed.ct) };
      tampered.ct[index]! ^= 0xff;
      await expect(decryptText(key, tampered), `byte ${index}`).rejects.toThrow(VaultDecryptError);
    }
  });

  it('throws when the IV is altered', async () => {
    const { key } = await testKey();
    const sealed = await encryptText(key, 'transfer 100 rupees');

    const tampered = { ...sealed, iv: Uint8Array.from(sealed.iv) };
    tampered.iv[0]! ^= 0x01;

    await expect(decryptText(key, tampered)).rejects.toThrow(VaultDecryptError);
  });

  it('throws when the authentication tag is truncated', async () => {
    const { key } = await testKey();
    const sealed = await encryptText(key, 'transfer 100 rupees');

    const tampered = { ...sealed, ct: sealed.ct.slice(0, sealed.ct.length - 1) };

    await expect(decryptText(key, tampered)).rejects.toThrow(VaultDecryptError);
  });

  it('releases no partial plaintext on failure', async () => {
    const { key } = await testKey();
    const sealed = await encryptText(key, 'PARTIAL-PLAINTEXT-MARKER repeated '.repeat(20));

    const tampered = { ...sealed, ct: Uint8Array.from(sealed.ct) };
    tampered.ct[tampered.ct.length - 2]! ^= 0x40;

    // AES-GCM verifies the tag before returning anything. A caller must never
    // see a prefix of the plaintext.
    await expect(decryptText(key, tampered)).rejects.toThrow(VaultDecryptError);
    const err = await decryptText(key, tampered).catch((e: unknown) => e);
    expect(String(err)).not.toContain('PARTIAL-PLAINTEXT-MARKER');
  });
});

describe('passphrase verification', () => {
  it('accepts the correct passphrase', async () => {
    const params = { ...newKdfParams(), iterations: TEST_ITERATIONS };
    const key = await deriveKey('right passphrase', params);
    const verifier = await createVerifier(key);

    const again = await deriveKey('right passphrase', params);
    await expect(verifyPassphrase(again, verifier)).resolves.toBe(true);
  });

  it('rejects a wrong passphrase cleanly rather than throwing', async () => {
    const params = { ...newKdfParams(), iterations: TEST_ITERATIONS };
    const key = await deriveKey('right passphrase', params);
    const verifier = await createVerifier(key);

    const wrong = await deriveKey('wrong passphrase', params);
    await expect(verifyPassphrase(wrong, verifier)).resolves.toBe(false);
  });

  it('rejects a tampered verifier rather than treating it as a match', async () => {
    const params = { ...newKdfParams(), iterations: TEST_ITERATIONS };
    const key = await deriveKey('right passphrase', params);
    const verifier = await createVerifier(key);

    const tampered = { ...verifier, ct: Uint8Array.from(verifier.ct) };
    tampered.ct[0]! ^= 0x01;

    await expect(verifyPassphrase(key, tampered)).resolves.toBe(false);
  });
});

describe('base64 codec', () => {
  it('round-trips bytes', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(1024));
    expect(toBase64(fromBase64(toBase64(bytes)))).toBe(toBase64(bytes));
  });

  it('round-trips an empty array', () => {
    expect(fromBase64(toBase64(new Uint8Array(0)))).toHaveLength(0);
  });

  it('rejects input that is not valid base64', () => {
    expect(() => fromBase64('not base64!!!')).toThrow();
  });
});
