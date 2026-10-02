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
  const size = jpegSize(jpeg);
  const colour = size === null ? undefined : COLOUR_SPACE[size.components];
  if (size === null || colour === undefined) throw new Error('That is not a JPEG this can put in a PDF.');

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

  const content = `q ${num(width)} 0 0 ${num(height)} 0 0 cm /Im0 Do Q`;

  // The second line's high bytes mark the file as binary, as the spec advises.
  ascii('%PDF-1.4\n');
  raw(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(width)} ${num(height)}] ` +
      '/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>',
  );
  offsets[4] = written;
  ascii(
    '4 0 obj\n' +
      `<< /Type /XObject /Subtype /Image /Width ${size.width} /Height ${size.height} ` +
      `/ColorSpace ${colour} /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
  );
  raw(jpeg);
  ascii('\nendstream\nendobj\n');
  offsets[5] = written;
  ascii(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);

  const xref = written;
  ascii(
    'xref\n0 6\n0000000000 65535 f \n' +
      offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
        .join('') +
      `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );

  const pdf = new Uint8Array(written);
  let at = 0;
  for (const chunk of chunks) {
    pdf.set(chunk, at);
    at += chunk.length;
  }
  return pdf;
}
