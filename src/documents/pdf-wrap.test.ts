import { describe, expect, it } from 'vitest';

import { PDF_WRAPPER_BYTES, jpegInPdf, jpegPagesInPdf, jpegSize, pdfWrapperBytes } from './pdf-wrap';

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

describe('a PDF of several pages', () => {
  /*
   * A scanned marks card of three pages, remade for a portal — locked, or too
   * big for the box — has to go in as three pages. It went in as one: the copy
   * was made from the first page alone, and nothing said so.
   */
  const pages = [
    { jpeg: jpeg(1240, 1754), width: 1240, height: 1754 },
    { jpeg: jpeg(1754, 1240), width: 1754, height: 1240 },
    { jpeg: jpeg(1240, 1754, 1), width: 1240, height: 1754 },
  ];
  const pdf = jpegPagesInPdf(pages);
  const body = text(pdf);

  it('has every page, in order, each its own size', () => {
    expect(body).toMatch(/\/Type \/Pages \/Kids \[3 0 R 6 0 R 9 0 R\] \/Count 3/);
    const boxes = [...body.matchAll(/\/MediaBox \[0 0 (\d+) (\d+)\]/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(boxes).toEqual([
      [1240, 1754],
      [1754, 1240],
      [1240, 1754],
    ]);
  });

  it('carries each page’s picture as it is, with its own colour', () => {
    for (const page of pages) expect(body.indexOf(text(page.jpeg))).toBeGreaterThan(0);
    expect([...body.matchAll(/\/ColorSpace \/(\w+)/g)].map((m) => m[1])).toEqual(['DeviceRGB', 'DeviceRGB', 'DeviceGray']);
  });

  it('has a cross-reference table whose every entry points at its object', () => {
    const xref = body.slice(body.lastIndexOf('\nxref\n') + 1);
    const offsets = [...xref.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(2 + 3 * pages.length);
    offsets.forEach((offset, index) => {
      expect(body.slice(offset, offset + 12), `object ${index + 1}`).toMatch(new RegExp(`^${index + 1} 0 obj`));
    });
  });

  it('is, for one page, exactly the one-page PDF', () => {
    const one = pages[0]!;
    expect([...jpegPagesInPdf([one])]).toEqual([...jpegInPdf(one.jpeg, one.width, one.height)]);
  });

  it('adds no more than the size search allows for, however many pages', () => {
    for (let count = 1; count <= 10; count += 1) {
      for (const length of [64, 99_999]) {
        const many = Array.from({ length: count }, () => {
          const image = new Uint8Array(length);
          image.set(jpeg(9999, 9999));
          return { jpeg: image, width: 9999, height: 9999 };
        });
        const added = jpegPagesInPdf(many).length - count * length;
        const bounds = pdfWrapperBytes(count);
        expect(added, `${count} pages`).toBeGreaterThanOrEqual(bounds.least);
        expect(added, `${count} pages`).toBeLessThanOrEqual(bounds.most);
      }
    }
  });

  it('refuses a PDF of no pages', () => {
    expect(() => jpegPagesInPdf([])).toThrow(/no pages/i);
  });
});
