import { describe, expect, it } from 'vitest';

import {
  ORIENTATION_MIN_CONFIDENCE,
  readPage,
  uprightPage,
  type OrientationRunner,
  type TensorRunner,
} from './paddle-reader';
import type { OrientationConfig, RgbaImage } from './paddle';

/**
 * The reading loop around PaddleOCR's two models (§ reading a document).
 *
 * The models are replaced by a runner that answers from a script, so what is
 * under test is the loop: the page is scaled before detection, boxes come back
 * in the page's own pixels, recognition is batched by width without the batch
 * shuffling which text belongs to which box, and a box the recogniser could
 * make nothing of is dropped rather than returned empty.
 */

const white = (width: number, height: number): RgbaImage => ({
  data: new Uint8ClampedArray(width * height * 4).fill(255),
  width,
  height,
});

const CHARACTERS = ['A', 'B', 'C', ' '];
const CLASSES = CHARACTERS.length + 1;
const STEPS = 8;

/** A recogniser output spelling `text`: one character per step, blanks between. */
function spell(text: string): Float32Array {
  const out = new Float32Array(STEPS * CLASSES);
  const indices = [...text].map((c) => CHARACTERS.indexOf(c) + 1);
  for (let t = 0; t < STEPS; t += 1) {
    const cls = t % 2 === 0 ? (indices[t / 2] ?? 0) : 0;
    out[t * CLASSES + cls] = 0.9;
  }
  return out;
}

type Region = [number, number, number, number];

/**
 * A runner whose detector finds `regions` and whose recogniser answers each
 * crop with `answer(contentWidth, rank)` — rank being the crop's place among
 * all crops by width, widest first.
 */
function scripted(regions: Region[], answer: (rank: number) => string) {
  const calls = { detect: [] as Array<[number, number]>, batches: [] as number[] };
  const seenWidths: number[] = [];

  const runner: TensorRunner = {
    async detect(_input, width, height) {
      calls.detect.push([width, height]);
      const data = new Float32Array(width * height);
      for (const [x0, y0, x1, y1] of regions) {
        for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) data[y * width + x] = 0.95;
      }
      return { data, width, height };
    },
    async recognise(_input, batch, _width, contentWidths) {
      calls.batches.push(batch);
      seenWidths.push(...contentWidths);
      const ranked = [...new Set(seenWidths)].sort((a, b) => b - a);
      const data = new Float32Array(batch * STEPS * CLASSES);
      contentWidths.forEach((w, i) => data.set(spell(answer(ranked.indexOf(w))), i * STEPS * CLASSES));
      return { data, timeSteps: STEPS, classes: CLASSES };
    },
  };
  return { runner, calls };
}

const CONFIG = {
  detection: { limitSideLen: 960, thresh: 0.3, boxThresh: 0.6, maxCandidates: 1000, unclipRatio: 1.5 },
  characters: CHARACTERS,
};

describe('reading one page', () => {
  it('shows the detector the page at its own resolution, as PaddleOCR’s pipeline does', async () => {
    const { runner, calls } = scripted([], () => '');
    await readPage(white(1920, 1080), runner, CONFIG);
    // Rounded to a multiple of 32, and nothing more.
    expect(calls.detect).toEqual([[1920, 1088]]);
  });

  it('scales as a caller asks, when it asks', async () => {
    const { runner, calls } = scripted([], () => '');
    await readPage(white(1920, 1080), runner, {
      ...CONFIG,
      scaling: { limitSideLen: 960, limitType: 'max', maxSideLimit: 4000 },
    });
    expect(calls.detect).toEqual([[960, 544]]);
  });

  it('returns each box in the page’s own pixels, with its text', async () => {
    // A 64 x 64 page is read at its own size, so map and page agree.
    const { runner } = scripted([[4, 4, 40, 14]], () => 'AB');
    const items = await readPage(white(64, 64), runner, CONFIG);
    expect(items).toHaveLength(1);
    expect(items[0]!.text).toBe('AB');
    expect(items[0]!.box.x0).toBeLessThan(4);
    expect(items[0]!.box.x1).toBeGreaterThan(40);
    expect(items[0]!.score).toBeCloseTo(0.9, 5);
  });

  it('keeps each text with its own box through batching by width', async () => {
    // Widest region on top, narrowest in the middle. The recogniser answers by
    // width rank, so a batch that shuffled its crops would put the wrong words
    // on the wrong boxes.
    const { runner } = scripted(
      [
        [2, 2, 60, 10],
        [2, 22, 20, 30],
        [2, 42, 40, 50],
      ],
      (rank) => ['A', 'B', 'C'][rank] ?? '',
    );
    const items = await readPage(white(64, 64), runner, CONFIG);
    expect(items.map((item) => item.text)).toEqual(['A', 'C', 'B']);
  });

  it('drops a box the recogniser could make nothing of', async () => {
    const { runner } = scripted([[4, 4, 40, 14]], () => '');
    expect(await readPage(white(64, 64), runner, CONFIG)).toEqual([]);
  });

  it('asks the recogniser in batches, not one crop at a time', async () => {
    const spaced: Region[] = [];
    for (let i = 0; i < 10; i += 1) spaced.push([2, 2 + i * 6, 30, 5 + i * 6]);
    const { runner, calls } = scripted(spaced, () => 'C');
    const items = await readPage(white(64, 64), runner, CONFIG);
    expect(items.length).toBe(10);
    expect(calls.batches.length).toBeLessThan(10);
  });
});

describe('standing a page upright before it is read', () => {
  /*
   * The recogniser reads upright text and nothing else, so a page photographed
   * sideways is turned first. The classifier is a model and can be unsure; a
   * page it is unsure of is left exactly as it came, because turning an upright
   * page on a guess would cost a good reading to save a bad one.
   */
  const ORIENTATION: OrientationConfig = {
    resizeShort: 256,
    cropSize: 224,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    scale: 1 / 255,
    labels: [0, 90, 180, 270],
  };

  function classifier(scores: number[]) {
    const seen: Array<[number, number]> = [];
    const runner: OrientationRunner = {
      async orient(input, size) {
        seen.push([input.length, size]);
        return Float32Array.from(scores);
      },
    };
    return { runner, seen };
  }

  it('shows the classifier one small square, whatever the page’s size', async () => {
    const { runner, seen } = classifier([0.92, 0.03, 0.03, 0.02]);
    await uprightPage(white(600, 900), runner, ORIENTATION);
    expect(seen).toEqual([[3 * 224 * 224, 224]]);
  });

  it('leaves an upright page as it came', async () => {
    const page = white(600, 900);
    const result = await uprightPage(page, classifier([0.92, 0.03, 0.03, 0.02]).runner, ORIENTATION);
    expect(result.image).toBe(page);
    expect(result.turns).toBe(0);
  });

  it('turns a sideways page back, and says how far', async () => {
    // Class "90": the page has been turned a quarter clockwise, so it goes
    // three quarters on — a quarter back.
    const result = await uprightPage(white(900, 600), classifier([0.02, 0.93, 0.03, 0.02]).runner, ORIENTATION);
    expect(result.turns).toBe(3);
    expect([result.image.width, result.image.height]).toEqual([600, 900]);
  });

  it('turns an upside-down page over', async () => {
    const result = await uprightPage(white(600, 900), classifier([0.02, 0.03, 0.93, 0.02]).runner, ORIENTATION);
    expect(result.turns).toBe(2);
    expect([result.image.width, result.image.height]).toEqual([600, 900]);
  });

  it('does not turn a page on a guess', async () => {
    const page = white(900, 600);
    const result = await uprightPage(page, classifier([0.35, 0.55, 0.05, 0.05]).runner, ORIENTATION);
    expect(result.image).toBe(page);
    expect(result.turns).toBe(0);
    expect(ORIENTATION_MIN_CONFIDENCE).toBeGreaterThan(0.55);
  });

  it('reads the page as it came when the classifier fails', async () => {
    const page = white(900, 600);
    const broken: OrientationRunner = {
      async orient() {
        throw new Error('no such model');
      },
    };
    const result = await uprightPage(page, broken, ORIENTATION);
    expect(result.image).toBe(page);
    expect(result.turns).toBe(0);
  });
});
