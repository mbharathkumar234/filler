import { describe, expect, it } from 'vitest';
import {
  TRIMMABLE_MARGIN,
  estimateBackground,
  findContentBox,
  padContentBox,
  readShape,
  type LuminanceImage,
} from './trim';

/**
 * The rules here decide whether a user is told to crop their signature, so the
 * fixtures are built by hand rather than loaded: a threshold that is subtly
 * wrong still returns a plausible-looking box, and only a known image catches
 * it.
 */

interface Ink {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A page of `background` with a solid `ink` rectangle painted on it. */
function image(
  width: number,
  height: number,
  ink: Ink | null,
  { background = 255, inkLevel = 20 } = {},
): LuminanceImage {
  const data = new Uint8Array(width * height).fill(background);
  if (ink) {
    for (let y = ink.top; y < ink.top + ink.height; y++) {
      for (let x = ink.left; x < ink.left + ink.width; x++) {
        data[y * width + x] = inkLevel;
      }
    }
  }
  return { width, height, data };
}

describe('background estimation', () => {
  it('reads the page level off the border', () => {
    expect(estimateBackground(image(50, 50, { left: 10, top: 10, width: 20, height: 20 }))).toBe(
      255,
    );
  });

  it('survives a photograph of paper, which is never actually white', () => {
    const grey = image(50, 50, { left: 10, top: 10, width: 20, height: 20 }, { background: 232 });
    expect(estimateBackground(grey)).toBe(232);
  });

  it('handles a dark background rather than assuming ink is dark', () => {
    // White signature on a black card. The border is the background either way.
    const inverted = image(
      50,
      50,
      { left: 10, top: 10, width: 20, height: 20 },
      { background: 12, inkLevel: 240 },
    );
    expect(estimateBackground(inverted)).toBe(12);
    expect(findContentBox(inverted)).toEqual({ left: 10, top: 10, width: 20, height: 20 });
  });

  it('is not dragged off by ink that runs to the edge', () => {
    // A mean would be pulled well below 255 by a stroke crossing the border.
    const bleeding = image(50, 50, { left: 0, top: 20, width: 50, height: 4 });
    expect(estimateBackground(bleeding)).toBe(255);
  });
});

describe('content box', () => {
  it('finds a rectangle of ink', () => {
    expect(findContentBox(image(100, 100, { left: 20, top: 30, width: 40, height: 25 }))).toEqual({
      left: 20,
      top: 30,
      width: 40,
      height: 25,
    });
  });

  it('returns null for a blank page rather than the whole canvas', () => {
    expect(findContentBox(image(40, 40, null))).toBeNull();
  });

  it('ignores a speck of dust in the margin', () => {
    const speckled = image(200, 200, { left: 60, top: 90, width: 80, height: 20 });
    speckled.data[2 * 200 + 3] = 0; // one stray dark pixel near the corner

    const box = findContentBox(speckled);
    expect(box).toEqual({ left: 60, top: 90, width: 80, height: 20 });
  });

  it('does not mistake photographic noise for content', () => {
    const noisy = image(120, 120, { left: 40, top: 50, width: 40, height: 12 }, { background: 236 });
    // ±8 of sensor noise across the whole page, inside the 24 threshold.
    for (let i = 0; i < noisy.data.length; i += 7) {
      noisy.data[i] = 236 + ((i % 3) - 1) * 8;
    }
    expect(findContentBox(noisy)).toEqual({ left: 40, top: 50, width: 40, height: 12 });
  });

  it('still finds a thin stroke, which is the cost of the speckle floor', () => {
    const hairline = image(200, 200, { left: 98, top: 40, width: 2, height: 120 });
    expect(findContentBox(hairline)).toEqual({ left: 98, top: 40, width: 2, height: 120 });
  });

  it('refuses a buffer that does not describe the image it claims', () => {
    expect(findContentBox({ width: 100, height: 100, data: new Uint8Array(10) })).toBeNull();
  });
});

describe('shape reading', () => {
  /**
   * The case that reported the bug: a signature already cropped to its own ink,
   * taller than it is wide because of the flourish. Nothing to trim, and any
   * advice to crop is wrong.
   */
  it('reports a tight crop as untrimmable, keeping the real shape', () => {
    const tight = image(276, 354, { left: 4, top: 4, width: 268, height: 346 });
    const shape = readShape(tight)!;

    expect(shape.trimmable).toBe(false);
    expect(shape.marginRatio).toBeLessThan(TRIMMABLE_MARGIN);
    // Still taller than wide — the shape is the signature's, not the canvas's.
    expect(shape.contentAspect).toBeLessThan(1);
    expect(shape.contentAspect).toBeCloseTo(268 / 346, 5);
  });

  /**
   * The case the old advice was written for, and the only one where "crop away
   * the paper" is true: a wide signature adrift in a square photograph.
   */
  it('reports a wide signature in a square frame as trimmable, and wide', () => {
    const roomy = image(400, 400, { left: 40, top: 170, width: 320, height: 60 });
    const shape = readShape(roomy)!;

    expect(shape.trimmable).toBe(true);
    expect(shape.canvasAspect).toBe(1);
    // The canvas says square; the ink says a strip. That difference is the fix.
    expect(shape.contentAspect).toBeCloseTo(320 / 60, 5);
  });

  it('returns null for a blank image so callers can fall back to the canvas', () => {
    expect(readShape(image(60, 60, null))).toBeNull();
  });
});

describe('padding', () => {
  it('adds air around the ink', () => {
    const padded = padContentBox({ left: 100, top: 100, width: 200, height: 50 }, {
      width: 400,
      height: 400,
    });
    expect(padded.left).toBeLessThan(100);
    expect(padded.width).toBeGreaterThan(200);
  });

  it('never runs off the canvas', () => {
    const padded = padContentBox({ left: 0, top: 0, width: 100, height: 100 }, {
      width: 100,
      height: 100,
    });
    expect(padded).toEqual({ left: 0, top: 0, width: 100, height: 100 });
  });
});

/**
 * The two photographs that were actually uploaded, as luminance fixtures.
 *
 * Both defeated the original fixed threshold, and both did it silently: the
 * bounding box came back covering nearly the whole sheet, so `contentAspect`
 * quietly degraded into the canvas ratio this module exists to replace. The
 * screen then gave shape advice about a piece of paper.
 */
describe('photographs that broke the fixed threshold', () => {
  /** Signature on printed graph paper — the grid is the trap. */
  function graphPaper(): LuminanceImage {
    const width = 384;
    const height = 512;
    const data = new Uint8Array(width * height).fill(222);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (x % 12 === 0 || y % 12 === 0) data[y * width + x] = 194; // printed grid
      }
    }
    for (let y = 230; y < 366; y++) {
      for (let x = 95; x < 207; x++) {
        if ((x + y) % 3 === 0) data[y * width + x] = 70; // pen
      }
    }
    return { width, height, data };
  }

  /** Signature on plain paper with a soft grey shadow in one corner. */
  function shadowedCorner(): LuminanceImage {
    const width = 720;
    const height = 640;
    const data = new Uint8Array(width * height).fill(238);
    for (let y = 0; y < 115; y++) {
      for (let x = 0; x < 90; x++) data[y * width + x] = 170; // shadow
    }
    for (let y = 180; y < 410; y++) {
      for (let x = 210; x < 420; x++) {
        if ((x * 2 + y) % 5 === 0) data[y * width + x] = 80; // pen
      }
    }
    return { width, height, data };
  }

  it('ignores a printed grid and finds only the signature', () => {
    const box = findContentBox(graphPaper())!;

    // The signature, not the sheet. Before the adaptive threshold this came
    // back as {left: 1, top: 1, width: 383, height: 511}.
    expect(box.left).toBeGreaterThan(80);
    expect(box.top).toBeGreaterThan(200);
    expect(box.width).toBeLessThan(150);
    expect(box.height).toBeLessThan(180);
  });

  it('reports the graph-paper sheet as almost entirely blank', () => {
    const shape = readShape(graphPaper())!;
    expect(shape.marginRatio).toBeGreaterThan(0.85);
    expect(shape.trimmable).toBe(true);
  });

  it('ignores a shadow in the corner rather than measuring from it', () => {
    const box = findContentBox(shadowedCorner())!;

    // Previously anchored to (0, 0) by the shadow, which put the corner and
    // the signature in one box and reported their combined shape.
    expect(box).toEqual({ left: 210, top: 180, width: 210, height: 230 });
  });

  it('recovers the true shape of the signature, not of the page', () => {
    const shape = readShape(shadowedCorner())!;
    expect(shape.contentAspect).toBeCloseTo(210 / 230, 2);
    // The canvas would have said 1.125; the shadow-anchored box said 1.02.
    expect(shape.canvasAspect).toBeCloseTo(720 / 640, 5);
  });

  it('still reads a faint pencil signature, where nothing is very dark', () => {
    // The adaptive threshold must not raise itself out of range on a
    // low-contrast image: the floor wins, which is the old behaviour.
    const faint = image(300, 200, { left: 60, top: 70, width: 160, height: 50 }, {
      background: 246,
      inkLevel: 210,
    });
    expect(findContentBox(faint)).toEqual({ left: 60, top: 70, width: 160, height: 50 });
  });
});
