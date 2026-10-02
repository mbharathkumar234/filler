import { describe, expect, it } from 'vitest';

import { PDF_WRAPPER_BYTES, jpegInPdf, jpegSize } from './pdf-wrap';

/**
 * One JPEG, on one PDF page (§ derivation).
 *
 * A portal that takes only PDFs gets the fitted JPEG wrapped in a page. That
 * used to be pdf-lib, loaded with `import()` — which a service worker is not
 * allowed to do, so every PDF-only box failed from the worker, where fills
 * actually run. A one-image PDF is a few hundred bytes of fixed structure; it
 * is written here, and checked here, without a library.
 */

/** A minimal JPEG header: SOI, an APP0, then a baseline SOF0 for `width` × `height`. */
function jpeg(width: number, height: number, components = 3): Uint8Array {
  const sof = [0xff, 0xc0, 0x00, 8 + 3 * components, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, components];
  for (let c = 0; c < components; c += 1) sof.push(c + 1, 0x11, 0);
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    ...sof,
    0xff, 0xd9,
  ]);
}

const text = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes);

describe('reading a JPEG’s size from its header', () => {
  it('finds the frame header after the others', () => {
    expect(jpegSize(jpeg(413, 531))).toEqual({ width: 413, height: 531, components: 3 });
  });

  it('reads a greyscale one', () => {
    expect(jpegSize(jpeg(100, 50, 1))?.components).toBe(1);
  });

  it('refuses what is not a JPEG', () => {
    expect(jpegSize(new TextEncoder().encode('%PDF-1.4'))).toBeNull();
    expect(jpegSize(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });
});

describe('the PDF', () => {
  const image = jpeg(413, 531);
  const pdf = jpegInPdf(image, 413, 531);
  const body = text(pdf);

  it('is a PDF, and ends as one', () => {
    expect(body.startsWith('%PDF-1.4\n')).toBe(true);
    expect(body.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('carries the JPEG as it is, byte for byte', () => {
    const at = body.indexOf(text(image));
    expect(at).toBeGreaterThan(0);
    expect([...pdf.subarray(at, at + image.length)]).toEqual([...image]);
  });

  it('describes the image by its own header, and puts it on a page the size asked for', () => {
    expect(body).toMatch(/\/Width 413 \/Height 531/);
    expect(body).toMatch(/\/Filter \/DCTDecode/);
    expect(body).toMatch(/\/ColorSpace \/DeviceRGB/);
    expect(body).toMatch(/\/MediaBox \[0 0 413 531\]/);
    expect(body).toMatch(/q 413 0 0 531 0 0 cm \/Im0 Do Q/);
  });

  it('gives a greyscale JPEG a grey colour space', () => {
    expect(text(jpegInPdf(jpeg(10, 10, 1), 10, 10))).toMatch(/\/ColorSpace \/DeviceGray/);
  });

  it('has a cross-reference table whose every entry points at its object', () => {
    // A reader trusts these offsets; one byte out and the file is "damaged".
    // The table itself, not the `startxref` near the end, which also ends in "xref".
    const xref = body.slice(body.lastIndexOf('\nxref\n') + 1);
    const offsets = [...xref.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(5);
    offsets.forEach((offset, index) => {
      expect(body.slice(offset, offset + 12), `object ${index + 1}`).toMatch(new RegExp(`^${index + 1} 0 obj`));
    });
    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(body)?.[1]);
    expect(body.slice(startxref, startxref + 4)).toBe('xref');
  });

  it('gives each stream its true length', () => {
    for (const match of body.matchAll(/\/Length (\d+) >>\nstream\n/g)) {
      const start = match.index! + match[0].length;
      expect(body.slice(start + Number(match[1]), start + Number(match[1]) + 10)).toBe('\nendstream');
    }
  });

  it('carries no password and nothing to open it with: it is an ordinary file', () => {
    expect(body).not.toMatch(/\/Encrypt/);
  });

  it('refuses to wrap something that is not a JPEG', () => {
    expect(() => jpegInPdf(new Uint8Array([1, 2, 3]), 10, 10)).toThrow(/not a JPEG/i);
  });
});

describe('what the wrapper adds', () => {
  // The size search takes this range on trust (`derive.ts`), so it is held to it
  // across every page size and JPEG length a portal could ask for.
  it('stays inside the range the size search allows for', () => {
    for (const side of [1, 9, 99, 413, 1654, 9999]) {
      for (const length of [64, 999, 99_999, 9_999_999]) {
        const image = new Uint8Array(length);
        image.set(jpeg(side, side));
        const added = jpegInPdf(image, side, side).length - length;
        expect(added, `${side} px, ${length} bytes`).toBeGreaterThanOrEqual(PDF_WRAPPER_BYTES.least);
        expect(added, `${side} px, ${length} bytes`).toBeLessThanOrEqual(PDF_WRAPPER_BYTES.most);
      }
    }
  });
});
