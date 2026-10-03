import { describe, expect, it } from 'vitest';

import type { RgbaImage } from './paddle';
import { backgroundColour, evenLighting, hasBackground, trimBackground } from './scan';

/**
 * The scanner's own arithmetic (§ Stage 2: a phone photo made a scan).
 *
 * PaddleOCR's UVDoc flattens a page photographed curled or at an angle — and
 * stretches a page that was already flat, cutting into its margins. So it runs
 * only on a photo with something other than the page around it; what it leaves
 * of the table at the edges is trimmed; and the light is evened out, so the
 * page reads as paper rather than as a photograph of paper.
 */

type Rgb = [number, number, number];

function image(width: number, height: number, colour: (x: number, y: number) => Rgb): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = colour(x, y);
      const at = (y * width + x) * 4;
      data[at] = r;
      data[at + 1] = g;
      data[at + 2] = b;
      data[at + 3] = 255;
    }
  }
  return { data, width, height };
}

const PAPER: Rgb = [246, 244, 238];
const TABLE: Rgb = [128, 96, 72];
const INK: Rgb = [24, 24, 28];

/** A page of "text": dark strokes every few rows, on `paper`. */
const text = (paper: Rgb) => (x: number, y: number): Rgb => (y % 12 < 3 && x % 9 < 6 ? INK : paper);

/** A page in a rectangle of the frame, the table around it. */
const onTable = (left: number, top: number, right: number, bottom: number) => (x: number, y: number): Rgb =>
  x >= left && x < right && y >= top && y < bottom ? text(PAPER)(x, y) : TABLE;

const pixel = (img: RgbaImage, x: number, y: number): Rgb => {
  const at = (y * img.width + x) * 4;
  return [img.data[at]!, img.data[at + 1]!, img.data[at + 2]!];
};

describe('whether a photo has something other than the page around it', () => {
  it('sees the table around a page photographed on it', () => {
    expect(hasBackground(image(200, 150, onTable(30, 20, 170, 130)))).toBe(true);
  });

  it('sees none around a scan, or a page that fills the frame', () => {
    expect(hasBackground(image(200, 150, text(PAPER)))).toBe(false);
  });

  it('takes the page’s own colour as paper, whatever it is', () => {
    // A passbook's lavender, edge to edge.
    expect(hasBackground(image(200, 150, text([234, 226, 244])))).toBe(false);
  });

  it('calls paper in shadow paper still', () => {
    // A page filling the frame, the light falling away to one side.
    const shaded = (x: number, y: number): Rgb => {
      const [r, g, b] = text(PAPER)(x, y);
      const k = 1 - 0.35 * (x / 200);
      return [r * k, g * k, b * k];
    };
    expect(hasBackground(image(200, 150, shaded))).toBe(false);
  });
});

describe('trimming what is left of the table', () => {
  it('cuts the table off the edges of a flattened page', () => {
    // The page as UVDoc leaves it: nearly the whole frame, a band of table above
    // and to the right.
    const flattened = image(200, 150, onTable(0, 12, 184, 150));
    const trimmed = trimBackground(flattened);
    expect(trimmed.width).toBeGreaterThanOrEqual(180);
    expect(trimmed.width).toBeLessThanOrEqual(186);
    expect(trimmed.height).toBeGreaterThanOrEqual(136);
    expect(trimmed.height).toBeLessThanOrEqual(140);
    // What is left is page, corner to corner.
    for (const [x, y] of [[2, 2], [trimmed.width - 3, 2], [2, trimmed.height - 3], [trimmed.width - 3, trimmed.height - 3]] as const) {
      expect(pixel(trimmed, x, y)[0], `${x},${y}`).not.toBe(TABLE[0]);
    }
  });

  it('never cuts more than a fifth from any side', () => {
    const tiny = image(200, 150, onTable(80, 60, 120, 90));
    const trimmed = trimBackground(tiny);
    expect(trimmed.width).toBeGreaterThanOrEqual(120);
    expect(trimmed.height).toBeGreaterThanOrEqual(90);
  });

  it('leaves a page with nothing around it as it was', () => {
    const page = image(200, 150, text(PAPER));
    expect(trimBackground(page)).toBe(page);
  });

  it('cuts a band along one side, told the table’s colour by the photo it came from', () => {
    // The photo before flattening says what the table looked like, so a band
    // left along a single side is known for table, not taken for print.
    const photo = image(200, 150, onTable(30, 20, 170, 130));
    const table = backgroundColour(photo)!;
    expect(table.r).toBe(TABLE[0]);
    const flattened = image(200, 150, onTable(0, 6, 200, 150));
    expect(trimBackground(flattened, table).height).toBe(144);
  });

  it('has no table colour for a scan', () => {
    expect(backgroundColour(image(200, 150, text(PAPER)))).toBeNull();
  });
});

describe('evening out the light', () => {
  // Paper lit from the left: 240 at one edge, 140 at the other.
  const lit = image(240, 120, (x, y) => {
    const k = 1 - (100 / 240) * (x / 239);
    const [r, g, b] = text([240, 240, 240])(x, y);
    return r === INK[0] ? [r, g, b] : [r * k, g * k, b * k];
  });
  const even = evenLighting(lit);

  it('makes the paper the same white from one side to the other', () => {
    const paperAt = (x: number) => pixel(even, x, 7)[0];
    expect(paperAt(4)).toBeGreaterThanOrEqual(230);
    expect(paperAt(235)).toBeGreaterThanOrEqual(230);
    expect(Math.abs(paperAt(4) - paperAt(235))).toBeLessThanOrEqual(12);
  });

  it('keeps the ink dark, in the shadow too', () => {
    expect(pixel(even, 3, 1)[0]).toBeLessThan(90);
    expect(pixel(even, 237, 1)[0]).toBeLessThan(90);
  });

  it('keeps the size, and the page’s own colour', () => {
    expect([even.width, even.height]).toEqual([240, 120]);
    const lavender = evenLighting(image(120, 80, text([226, 214, 242])));
    const [r, g, b] = pixel(lavender, 60, 6);
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
  });
});
