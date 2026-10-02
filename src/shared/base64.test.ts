import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64, decodedLength } from './base64';

describe('bytes over the bus', () => {
  it('round-trips every byte value', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('survives a file larger than one chunk', () => {
    const bytes = Uint8Array.from({ length: 0x8000 * 3 + 7 }, (_, i) => (i * 31) % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('knows the decoded size without decoding', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 1000]) {
      const encoded = bytesToBase64(new Uint8Array(length));
      expect(decodedLength(encoded)).toBe(length);
    }
  });
});
