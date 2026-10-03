/**
 * The piece of the card a value was read from (§ reading a document).
 *
 * The suggestion screen has always quoted the line a value came from, so that
 * checking means comparing two strings on one screen. But both strings came
 * from the same reading: a "3" misread as an "8" is an "8" in the value and an
 * "8" in the quoted line, and they agree perfectly. The piece of the card
 * itself is the one thing on that screen the reader did not produce, and
 * showing it turns "does this look right" into "is this what is printed".
 *
 * Boxes travel as **shares of the page** rather than pixels: a photograph may
 * be shrunk before it is read and a PDF rasterised at another size when it is
 * cropped, and a share points at the same place on the document either way.
 *
 * Pure: boxes in, boxes out. The cropping itself needs a canvas and lives in
 * `background/document-service.ts`.
 */

export interface PageBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const clamp = (n: number) => Math.min(1, Math.max(0, n));

/** Rounded to a ten-thousandth of the page: far finer than a pixel, and stable to compare. */
const share = (n: number) => Math.round(n * 10_000) / 10_000;

/** A box in page pixels, as shares of the page (0–1). */
export function toFractions(box: PageBox, page: { width: number; height: number }): PageBox {
  return {
    x0: share(clamp(box.x0 / page.width)),
    y0: share(clamp(box.y0 / page.height)),
    x1: share(clamp(box.x1 / page.width)),
    y1: share(clamp(box.y1 / page.height)),
  };
}

/**
 * A box on the upright page, carried back onto the document as stored.
 *
 * `turns` is how many quarter turns clockwise stood the stored picture upright
 * for the reader. Quarter turns keep an upright box upright, so this is a
 * relabelling of its four edges and nothing is resampled.
 */
export function unturnBox(box: PageBox, turns: 0 | 1 | 2 | 3): PageBox {
  const flip = (n: number) => share(1 - n);
  switch (turns) {
    case 0:
      return box;
    case 1:
      return { x0: box.y0, y0: flip(box.x1), x1: box.y1, y1: flip(box.x0) };
    case 2:
      return { x0: flip(box.x1), y0: flip(box.y1), x1: flip(box.x0), y1: flip(box.y0) };
    case 3:
      return { x0: flip(box.y1), y0: box.x0, x1: flip(box.y0), y1: box.x1 };
  }
}

/** How much of a line's own height is shown above it and below it. */
const CONTEXT_ABOVE_AND_BELOW = 0.9;

/** How much of the page's width is shown to either side. */
const CONTEXT_EITHER_SIDE = 0.02;

/**
 * The region to show for the line a value came from.
 *
 * The line itself and a little around it: nearly a line's height above and
 * below, so a label printed on the line before its value is in the picture,
 * and the eye can place the crop on the card in the user's hand.
 */
export function regionForLine(
  line: number,
  lines: ReadonlyArray<{ box: PageBox }> | undefined,
): PageBox | null {
  const found = lines?.[line];
  if (found === undefined || line < 0) return null;

  const { box } = found;
  const height = box.y1 - box.y0;
  return {
    x0: share(clamp(box.x0 - CONTEXT_EITHER_SIDE)),
    y0: share(clamp(box.y0 - height * CONTEXT_ABOVE_AND_BELOW)),
    x1: share(clamp(box.x1 + CONTEXT_EITHER_SIDE)),
    y1: share(clamp(box.y1 + height * CONTEXT_ABOVE_AND_BELOW)),
  };
}

/** One piece to cut: for which value, where on its page as stored, and how to stand it up. */
export interface PlannedPiece<K extends string = string> {
  key: K;
  region: PageBox;
  /** Quarter turns clockwise that stand the cut piece upright, as its page was for reading. */
  turns: 0 | 1 | 2 | 3;
}

/**
 * The pieces to cut, grouped by page number (from 1).
 *
 * A scanned PDF is read page by page; each line says which page it sat on
 * (none: the first) and how far that page was turned to be read. Grouping by
 * page means each page of the stored document is drawn once, however many
 * values came off it, and each piece is carried back onto its own page.
 */
export function planCrops<K extends string>(
  values: ReadonlyArray<{ key: K; line: number }>,
  lines: ReadonlyArray<{ box: PageBox; page?: number; turns?: 0 | 1 | 2 | 3 }> | undefined,
): Map<number, PlannedPiece<K>[]> {
  const plan = new Map<number, PlannedPiece<K>[]>();
  if (lines === undefined) return plan;

  for (const { key, line } of values) {
    const upright = regionForLine(line, lines);
    const found = lines[line];
    if (upright === null || found === undefined) continue;

    const turns = found.turns ?? 0;
    const page = found.page ?? 1;
    const pieces = plan.get(page) ?? [];
    pieces.push({ key, region: unturnBox(upright, turns), turns });
    plan.set(page, pieces);
  }
  return new Map([...plan.entries()].sort(([a], [b]) => a - b));
}
