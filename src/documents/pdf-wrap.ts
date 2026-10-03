/**
 * One JPEG, on one PDF page (§ derivation).
 *
 * A portal that takes only PDFs gets the fitted JPEG wrapped in a page. That
 * was pdf-lib, loaded with `import()` so the service worker's cold start would
 * not pay for it — but a service worker may not call `import()` at all, so
 * every PDF-only box failed from the worker, which is where fills run. A PDF
 * holding one image is a few hundred bytes of fixed structure, written here,
 * pure, and checked in `pdf-wrap.test.ts` the way a reader would check it.
 *
 * The JPEG goes in as it is (`/DCTDecode`): no re-encoding, so what the size
 * search settled on is exactly what the portal receives, plus this wrapper.
 */

export interface JpegSize {
  width: number;
  height: number;
  /** 1 grey, 3 colour, 4 CMYK. */
  components: number;
}

/** The size and colour layout a JPEG's frame header declares, or null if it is not one. */
export function jpegSize(jpeg: Uint8Array): JpegSize | null {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;

  let at = 2;
  while (at + 9 < jpeg.length) {
    if (jpeg[at] !== 0xff) return null;
    const marker = jpeg[at + 1]!;
    // Fill bytes, and markers that stand alone without a length.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    // Start of frame: every SOFn except DHT, JPG and DAC, which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: (jpeg[at + 5]! << 8) | jpeg[at + 6]!,
        width: (jpeg[at + 7]! << 8) | jpeg[at + 8]!,
        components: jpeg[at + 9]!,
      };
    }
    at += 2 + ((jpeg[at + 2]! << 8) | jpeg[at + 3]!);
  }
  return null;
}

/**
 * What the wrapper adds around the JPEG, at least and at most.
 *
 * Measured across every page size and JPEG length a portal could ask for
 * (668 to 696 bytes; `pdf-wrap.test.ts` holds it to this range). The size
 * search uses it so a PDF lands inside a portal's window, not just the JPEG.
 */
export const PDF_WRAPPER_BYTES = { least: 600, most: 800 } as const;

/** What each page after the first adds, at least and at most (measured; held by the tests). */
const PER_PAGE_BYTES = { least: 300, most: 450 } as const;

/** What the wrapper adds around `pages` JPEGs, at least and at most. */
export function pdfWrapperBytes(pages: number): { least: number; most: number } {
  const more = Math.max(0, pages - 1);
  return {
    least: PDF_WRAPPER_BYTES.least + more * PER_PAGE_BYTES.least,
    most: PDF_WRAPPER_BYTES.most + more * PER_PAGE_BYTES.most,
  };
}

const COLOUR_SPACE: Readonly<Record<number, string>> = {
  1: '/DeviceGray',
  3: '/DeviceRGB',
  // Adobe writes CMYK JPEGs inverted; the Decode array turns them back.
  4: '/DeviceCMYK /Decode [1 0 1 0 1 0 1 0]',
};

/** A number as PDF writes it: no exponent, at most two decimals. */
function num(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * A single-page PDF showing `jpeg`, the page `width` × `height` points.
 *
 * Callers pass the image's pixel size, so a pixel is a point, as before.
 */
export function jpegInPdf(jpeg: Uint8Array, width: number, height: number): Uint8Array {
  return jpegPagesInPdf([{ jpeg, width, height }]);
}

/** One page of a PDF being written: its picture, and the page's size in points. */
export interface PdfPage {
  jpeg: Uint8Array;
  width: number;
  height: number;
}

/**
 * A PDF with one picture per page, in order, each page its own size.
 *
 * A scanned marks card of three pages, remade for a portal — locked, or too
 * big for the box — went in as one: the copy was made from the first page
 * alone. Objects are numbered as for one page, three more for each page after:
 * a page, its picture, the stream that draws it.
 */
export function jpegPagesInPdf(pages: readonly PdfPage[]): Uint8Array {
  if (pages.length === 0) throw new Error('A PDF of no pages cannot be written.');
  const described = pages.map((page) => {
    const size = jpegSize(page.jpeg);
    const colour = size === null ? undefined : COLOUR_SPACE[size.components];
    if (size === null || colour === undefined) throw new Error('That is not a JPEG this can put in a PDF.');
    return { ...page, size, colour };
  });

  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let written = 0;
  const ascii = (text: string) => {
    const bytes = new TextEncoder().encode(text);
    chunks.push(bytes);
    written += bytes.length;
  };
  const raw = (bytes: Uint8Array) => {
    chunks.push(bytes);
    written += bytes.length;
  };
  const object = (n: number, body: string) => {
    offsets[n] = written;
    ascii(`${n} 0 obj\n${body}\nendobj\n`);
  };
  const pageObject = (index: number) => 3 + index * 3;

  // The second line's high bytes mark the file as binary, as the spec advises.
  ascii('%PDF-1.4\n');
  raw(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(
    2,
    `<< /Type /Pages /Kids [${described.map((_, i) => `${pageObject(i)} 0 R`).join(' ')}] /Count ${described.length} >>`,
  );

  described.forEach(({ jpeg, width, height, size, colour }, index) => {
    const page = pageObject(index);
    const content = `q ${num(width)} 0 0 ${num(height)} 0 0 cm /Im0 Do Q`;
    object(
      page,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(width)} ${num(height)}] ` +
        `/Resources << /XObject << /Im0 ${page + 1} 0 R >> >> /Contents ${page + 2} 0 R >>`,
    );
    offsets[page + 1] = written;
    ascii(
      `${page + 1} 0 obj\n` +
        `<< /Type /XObject /Subtype /Image /Width ${size.width} /Height ${size.height} ` +
        `/ColorSpace ${colour} /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
    );
    raw(jpeg);
    ascii('\nendstream\nendobj\n');
    offsets[page + 2] = written;
    ascii(`${page + 2} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
  });

  const count = offsets.length; // objects 1 .. n, plus the free entry 0
  const xref = written;
  ascii(
    `xref\n0 ${count}\n0000000000 65535 f \n` +
      offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
        .join('') +
      `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );

  const pdf = new Uint8Array(written);
  let at = 0;
  for (const chunk of chunks) {
    pdf.set(chunk, at);
    at += chunk.length;
  }
  return pdf;
}
