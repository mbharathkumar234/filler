/**
 * Bytes over the message bus.
 *
 * Extension messaging serialises as JSON, which has no binary type. The older
 * paths send `number[]`, and that is fine for a 30 KB photograph — but it costs
 * about 3.6 characters per byte, so a few certificates in one fill would push a
 * message towards Chrome's 64 MiB limit. Base64 costs 1.33.
 *
 * Deliberately its own module rather than `vault/crypto.ts`'s helpers: the
 * content script needs the decoder, and nothing from `vault/` may be bundled
 * into a page.
 */

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  // Chunked: spreading a multi-megabyte array into one call overflows the
  // argument limit.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** How many bytes a base64 string decodes to, without decoding it. */
export function decodedLength(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}
