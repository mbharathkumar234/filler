import { describe, expect, it } from 'vitest';

import { regionForLine, toFractions, unturnBox } from './evidence-region';

/**
 * The piece of the card a value was read from (§ reading a document).
 *
 * The suggestion screen has always quoted the line a value came from, so that
 * checking means comparing two strings. But both strings came from the same
 * reading, and a misread "8" is an "8" in both. The piece of the card itself is
 * the only thing on the screen the reader did not produce.
 */

const PAGE = { width: 1000, height: 2000 };

describe('a box, as a share of the page', () => {
  it('does not depend on how large the page was when it was read', () => {
    // A photograph shrunk before reading and a PDF rasterised at another size
    // must both point at the same place on the document.
    expect(toFractions({ x0: 100, y0: 400, x1: 600, y1: 440 }, PAGE)).toEqual({
      x0: 0.1,
      y0: 0.2,
      x1: 0.6,
      y1: 0.22,
    });
  });
});

describe('the region shown for a line', () => {
  const lines = [{ box: { x0: 0.1, y0: 0.2, x1: 0.6, y1: 0.22 } }, { box: { x0: 0, y0: 0, x1: 1, y1: 0.01 } }];

  it('shows a little of what surrounds the line, so the eye can place it', () => {
    const region = regionForLine(0, lines)!;
    expect(region.y0).toBeLessThan(0.2);
    expect(region.y1).toBeGreaterThan(0.22);
    expect(region.x0).toBeLessThan(0.1);
    expect(region.x1).toBeGreaterThan(0.6);
  });

  it('shows more above and below than the line is tall, but not the whole page', () => {
    const region = regionForLine(0, lines)!;
    expect(region.y1 - region.y0).toBeGreaterThan(0.02 * 2);
    expect(region.y1 - region.y0).toBeLessThan(0.02 * 5);
  });

  it('never runs off the edge of the page', () => {
    const region = regionForLine(1, lines)!;
    expect(region.x0).toBe(0);
    expect(region.y0).toBe(0);
    expect(region.x1).toBe(1);
  });

  it('shows nothing for a line it has no box for', () => {
    // Text read from a PDF's own text layer has no boxes; neither does a
    // value a rule inferred from a line number that is out of range.
    expect(regionForLine(7, lines)).toBeNull();
    expect(regionForLine(-1, lines)).toBeNull();
    expect(regionForLine(0, undefined)).toBeNull();
  });
});

describe('a box on a page that was turned before it was read', () => {
  /*
   * A sideways photograph is turned upright for the reader, so the reader's
   * boxes are places on the upright page. The piece shown to the user is cut
   * from the document as stored — still sideways — so each box is carried back
   * onto it first.
   */
  const box = { x0: 0.1, y0: 0.2, x1: 0.6, y1: 0.25 };

  it('is where it was on a page that was never turned', () => {
    expect(unturnBox(box, 0)).toEqual(box);
  });

  it('is carried back through a quarter turn clockwise', () => {
    // Upright = stored turned clockwise: the stored picture's left edge became
    // the top, so a line near the top of the upright page runs down the stored
    // picture's left side.
    expect(unturnBox(box, 1)).toEqual({ x0: 0.2, y0: 0.4, x1: 0.25, y1: 0.9 });
  });

  it('is carried back through a half turn', () => {
    expect(unturnBox(box, 2)).toEqual({ x0: 0.4, y0: 0.75, x1: 0.9, y1: 0.8 });
  });

  it('is carried back through a quarter turn anticlockwise', () => {
    expect(unturnBox(box, 3)).toEqual({ x0: 0.75, y0: 0.1, x1: 0.8, y1: 0.6 });
  });

  it('keeps its area, whichever way the page was turned', () => {
    const area = (b: typeof box) => (b.x1 - b.x0) * (b.y1 - b.y0);
    for (const turns of [0, 1, 2, 3] as const) {
      expect(area(unturnBox(box, turns))).toBeCloseTo(area(box), 6);
    }
  });
});
