/**
 * Reading a PDF's embedded text layer (§ document extraction).
 *
 * Separate from `raster.ts` because that module is the one part of this
 * directory allowed to touch a canvas, and this touches nothing: it asks
 * `pdfjs-dist` for the characters the document already contains and joins them
 * back into lines.
 *
 * ## Why the line reconstruction is not incidental
 *
 * `getTextContent` returns positioned fragments, not lines. A card that reads
 *
 *     Name              Ravi Kumar
 *     DOB               14/03/1998
 *
 * arrives as four items with coordinates, and concatenating them naively gives
 * `NameRavi KumarDOB14/03/1998`. Every label-anchored rule in `extract.ts`
 * works line by line — "is this line a date-of-birth label" — so getting the
 * lines back is what makes the exact-read path work at all.
 *
 * Items are therefore grouped by their vertical position, and joined with a
 * space when they are far enough apart horizontally to have been separate
 * words on the page.
 */

import type { PdfTextReader } from './read-document';
import { loadPdfJs } from './pdfjs';

/**
 * Two fragments within this many units of the same baseline are on one line.
 *
 * PDF coordinates are typographic points, so this is roughly half a line of
 * normal body text — loose enough to survive the slight baseline drift in
 * generated documents, tight enough not to merge adjacent rows of a table.
 */
const LINE_TOLERANCE = 3;

interface Fragment {
  text: string;
  x: number;
  y: number;
  width: number;
}

/** Group fragments into lines, top to bottom, left to right. */
export function reconstructLines(fragments: readonly Fragment[]): string[] {
  if (fragments.length === 0) return [];

  // PDF's origin is bottom-left, so a larger y is higher up the page.
  const sorted = [...fragments].sort((a, b) => b.y - a.y || a.x - b.x);

  const lines: Fragment[][] = [];
  for (const fragment of sorted) {
    const current = lines[lines.length - 1];
    const baseline = current?.[0]?.y;
    if (current && baseline !== undefined && Math.abs(baseline - fragment.y) <= LINE_TOLERANCE) {
      current.push(fragment);
    } else {
      lines.push([fragment]);
    }
  }

  return lines.map((line) =>
    line
      .sort((a, b) => a.x - b.x)
      .reduce((text, fragment, index) => {
        if (index === 0) return fragment.text;
        const previous = line[index - 1]!;
        const gap = fragment.x - (previous.x + previous.width);
        // A gap wider than a space means these were separate cells or columns.
        const separator = gap > 1 ? ' ' : '';
        return text + separator + fragment.text;
      }, '')
      .trim(),
  ).filter((line) => line !== '');
}

/** How many pages to read. An ID document is one or two; a statement is not. */
const MAX_PAGES = 5;

export const readPdfText: PdfTextReader = async (bytes, password) => {
  const { getDocument } = await loadPdfJs();
  const task = getDocument({ data: new Uint8Array(bytes), ...(password === undefined ? {} : { password }) });
  const pdf = await task.promise;

  try {
    const pages: string[] = [];
    const count = Math.min(pdf.numPages, MAX_PAGES);

    for (let pageNumber = 1; pageNumber <= count; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();

      const fragments: Fragment[] = [];
      for (const item of content.items) {
        if (!('str' in item) || item.str === '') continue;
        // `transform` is [a, b, c, d, e, f]; e and f are the position.
        const x = item.transform[4] ?? 0;
        const y = item.transform[5] ?? 0;
        fragments.push({ text: item.str, x, y, width: item.width ?? 0 });
      }

      pages.push(reconstructLines(fragments).join('\n'));
      page.cleanup();
    }

    return pages.join('\n').trim();
  } finally {
    await task.destroy();
  }
};
