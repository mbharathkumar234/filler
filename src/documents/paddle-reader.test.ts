import { describe, expect, it } from 'vitest';

import {
  ORIENTATION_MIN_CONFIDENCE,
  SMALL_PHOTO_SCALE,
  chooseReading,
  flattenPage,
  readPage,
  readSeals,
  readTables,
  readingScale,
  uprightPage,
  type OrientationRunner,
  type TableRunner,
  type TensorRunner,
} from './paddle-reader';
import type { OrientationConfig, RgbaImage, TableConfig, TextlineConfig } from './paddle';

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
const STEPS = 16;

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

describe('a box in another script', () => {
  /*
   * The English model reads every box first. One it could only guess at — a
   * Hindi word reads to it as low-scoring nonsense — is read again by each
   * installed recogniser for another script, and the best reading in that
   * recogniser's own alphabet wins. A page of English never loads them.
   */
  const HINDI = ['क', 'म', 'ल', ' '];

  /** Each crop read as `answer(rank)` at probability `p(rank)`, in `alphabet`. */
  function reader(alphabet: readonly string[], answer: (rank: number) => string, p: (rank: number) => number) {
    const seen: number[] = [];
    const classes = alphabet.length + 1;
    const recognise: TensorRunner['recognise'] = async (_input, batch, _width, contentWidths) => {
      seen.push(...contentWidths);
      const ranked = [...new Set(seen)].sort((a, b) => b - a);
      const data = new Float32Array(batch * STEPS * classes);
      contentWidths.forEach((w, i) => {
        const rank = ranked.indexOf(w);
        const indices = [...answer(rank)].map((c) => alphabet.indexOf(c) + 1);
        for (let t = 0; t < STEPS; t += 1) {
          const cls = t % 2 === 0 ? (indices[t / 2] ?? 0) : 0;
          data[i * STEPS * classes + t * classes + cls] = cls === 0 ? 0.9 : p(rank);
        }
      });
      return { data, timeSteps: STEPS, classes };
    };
    return recognise;
  }

  /** Two boxes: the wider one (rank 0) and the narrower (rank 1). */
  const TWO: Region[] = [
    [2, 2, 60, 10],
    [2, 22, 30, 30],
  ];

  function page(english: { answer: (rank: number) => string; p: (rank: number) => number }) {
    const { runner } = scripted(TWO, () => '');
    return { ...runner, recognise: reader(CHARACTERS, english.answer, english.p) };
  }

  it('leaves a page the English model reads well to the English model, and loads nothing more', async () => {
    let loaded = 0;
    const items = await readPage(white(64, 64), page({ answer: () => 'ABCABCAB', p: () => 0.95 }), {
      ...CONFIG,
      alternates: async () => {
        loaded += 1;
        return [];
      },
    });
    expect(items.map((item) => item.text)).toEqual(['ABCABCAB', 'ABCABCAB']);
    expect(loaded).toBe(0);
  });

  it('reads a box again when the English reading is far too short for its width', async () => {
    // "वार्षिक आय : 48000" read by the English model as "3:48000", sure of
    // every character it kept: the Hindi label simply became nothing. Measured,
    // English lines carry 1.7 characters or more per line-height of width; that
    // one carried 1.25.
    const { runner } = scripted([[2, 2, 60, 10]], () => '');
    const items = await readPage(white(64, 64), { ...runner, recognise: reader(CHARACTERS, () => 'A', () => 0.97) }, {
      ...CONFIG,
      alternates: async () => [
        { script: 'Devanagari', characters: HINDI, recognise: reader(HINDI, () => 'कमलकमल', () => 0.92) },
      ],
    });
    expect(items.map((item) => [item.text, item.script])).toEqual([['कमलकमल', 'Devanagari']]);
  });

  it('gives a box the English model could only guess at to the script that reads it', async () => {
    const items = await readPage(white(64, 64), page({ answer: (r) => (r === 0 ? 'CAB' : 'AB'), p: (r) => (r === 0 ? 0.4 : 0.95) }), {
      ...CONFIG,
      alternates: async () => [
        { script: 'Devanagari', characters: HINDI, recognise: reader(HINDI, () => 'कमल', () => 0.93) },
      ],
    });
    expect(items.map((item) => [item.text, item.script ?? 'Latin'])).toEqual([
      ['कमल', 'Devanagari'],
      ['AB', 'Latin'],
    ]);
  });

  it('keeps the English reading when no other script reads the box clearly better', async () => {
    const items = await readPage(white(64, 64), page({ answer: () => 'CAB', p: () => 0.75 }), {
      ...CONFIG,
      alternates: async () => [
        { script: 'Devanagari', characters: HINDI, recognise: reader(HINDI, () => 'कमल', () => 0.8) },
      ],
    });
    expect(items.map((item) => item.text)).toEqual(['CAB', 'CAB']);
    expect(items.every((item) => item.script === undefined)).toBe(true);
  });

  it('never takes a reading that is not in the recogniser’s own script', async () => {
    // A Devanagari model's alphabet includes Latin letters; reading an English
    // word back in Latin is no evidence the word was Hindi.
    const MIXED = ['क', 'A', 'B', ' '];
    const items = await readPage(white(64, 64), page({ answer: () => 'CAB', p: () => 0.5 }), {
      ...CONFIG,
      alternates: async () => [
        { script: 'Devanagari', characters: MIXED, recognise: reader(MIXED, () => 'AB', () => 0.99) },
      ],
    });
    expect(items.map((item) => item.text)).toEqual(['CAB', 'CAB']);
  });

  it('takes the best of several scripts', async () => {
    const TELUGU = ['క', 'మ', 'ల', ' '];
    const items = await readPage(white(64, 64), page({ answer: () => 'CAB', p: () => 0.3 }), {
      ...CONFIG,
      alternates: async () => [
        { script: 'Devanagari', characters: HINDI, recognise: reader(HINDI, () => 'कमल', () => 0.72) },
        { script: 'Telugu', characters: TELUGU, recognise: reader(TELUGU, () => 'కమల', () => 0.94) },
      ],
    });
    expect(items.map((item) => [item.text, item.script])).toEqual([
      ['కమల', 'Telugu'],
      ['కమల', 'Telugu'],
    ]);
  });

  it('reads a box the English model made nothing of', async () => {
    const items = await readPage(white(64, 64), page({ answer: () => '', p: () => 0.9 }), {
      ...CONFIG,
      alternates: async () => [
        { script: 'Devanagari', characters: HINDI, recognise: reader(HINDI, () => 'कमल', () => 0.9) },
      ],
    });
    expect(items.map((item) => item.text)).toEqual(['कमल', 'कमल']);
  });

  it('loads the other scripts once for a page, however many boxes need them', async () => {
    let loaded = 0;
    const many: Region[] = [];
    for (let i = 0; i < 10; i += 1) many.push([2, 2 + i * 6, 30, 5 + i * 6]);
    const { runner } = scripted(many, () => '');
    await readPage(white(64, 64), { ...runner, recognise: reader(CHARACTERS, () => 'CAB', () => 0.4) }, {
      ...CONFIG,
      alternates: async () => {
        loaded += 1;
        return [{ script: 'Devanagari', characters: HINDI, recognise: reader(HINDI, () => 'कमल', () => 0.9) }];
      },
    });
    expect(loaded).toBe(1);
  });
});

describe('choosing between readings', () => {
  it('needs the other reading to be in its script, sure, and clearly better', () => {
    const english = { text: 'CAB', score: 0.5 };
    expect(chooseReading(english, [{ text: 'कमल', score: 0.9, script: 'Devanagari' }])).toEqual({
      text: 'कमल',
      score: 0.9,
      script: 'Devanagari',
    });
    // Not sure enough.
    expect(chooseReading(english, [{ text: 'कमल', score: 0.55, script: 'Devanagari' }])).toEqual(english);
    // Not its script.
    expect(chooseReading(english, [{ text: 'kamal', score: 0.95, script: 'Devanagari' }])).toEqual(english);
    // A well-read English box is never second-guessed.
    expect(
      chooseReading({ text: 'NAME', score: 0.96, weakest: 0.9 }, [{ text: 'कमल', score: 0.99, script: 'Devanagari' }]),
    ).toEqual({ text: 'NAME', score: 0.96, weakest: 0.9 });
  });

  it('takes the reading that fills a box the English one left half empty', () => {
    // Measured on a four-line page: the English model read the income line as
    // "3:48000" at 0.93, its weakest character at 0.665 — not doubtful on either.
    // Only its length gave it away: seven characters across 5.6 line-heights.
    const english = { text: '3:48000', score: 0.93, weakest: 0.665 };
    const hindi = { text: 'वार्षिक आय : 48000', score: 0.98, weakest: 0.8, script: 'Devanagari' as const };
    expect(chooseReading(english, [hindi], 5.6)).toEqual(hindi);
    // The same reading across a box it filled is left alone.
    expect(chooseReading(english, [hindi], 3)).toEqual(english);
  });

  it('looks again at a line with a stretch it read nothing in, and takes the reading that has the label', () => {
    // "పుట్టిన తేదీ : 02/08/2003" read as ": 02/08/2003": the date dense and
    // sure, the Telugu label 1.69 line-heights of nothing.
    const english = { text: ': 02/08/2003', score: 0.93, weakest: 0.62, gap: 1.69 };
    const telugu = { text: 'పుట్టిన తేదీ : 02/08/2003', score: 0.99, weakest: 0.88, script: 'Telugu' as const };
    expect(chooseReading(english, [telugu], 5.6)).toEqual(telugu);
    expect(chooseReading({ ...english, gap: 0.5 }, [telugu], 5.6)).toEqual({ ...english, gap: 0.5 });
  });

  it('keeps the number every other reading agrees on, when the chosen one disagrees', () => {
    // A made-up Tamil certificate, as the real reader read it: the Tamil model
    // read the label and dropped the 6 of 60000; the Devanagari model read
    // 60000; the English model glued its guess at the label onto the digits,
    // "66660000" — which still ends in 60000. Digits look the same to every
    // model, and junk glued in front of them is not a vote against them.
    const english = { text: '66660000', score: 0.89, weakest: 0.6 };
    const tamil = { text: 'ஆண்டு வருமானம் : 0000', score: 0.91, weakest: 0.72, script: 'Tamil' as const };
    const devanagari = { text: 'शग 6π6 : 60000', score: 0.72, weakest: 0.22, script: 'Devanagari' as const };
    expect(chooseReading(english, [devanagari, tamil], 9).text).toBe('ஆண்டு வருமானம் : 60000');
    // With nobody to agree with, the chosen reading stands as it was read.
    expect(chooseReading(english, [tamil], 9).text).toBe('ஆண்டு வருமானம் : 0000');
    // And a number they agree on already is left alone.
    expect(chooseReading(english, [devanagari, { ...tamil, text: 'ஆண்டு வருமானம் : 60000' }], 9).text).toBe(
      'ஆண்டு வருமானம் : 60000',
    );
  });

  it('never takes a reading it was unsure of anywhere', () => {
    // A Karnataka card's Kannada, read by the Devanagari model: mostly in its
    // script, sure enough on average, and lost at one character — measured, the
    // garbage it made of Kannada never had a weakest character above 0.28; true
    // Hindi readings never fell below 0.51.
    const english = { text: '~ @0 : 12/05/2004', score: 0.81, weakest: 0.32 };
    const garbage = { text: '2न् 0J00 : 12/05/200', score: 0.92, weakest: 0.21, script: 'Devanagari' as const };
    expect(chooseReading(english, [garbage], 9)).toEqual(english);
  });

  it('looks again at a line one guessed word spoilt, however sure the digits beside it made the mean', () => {
    // "वार्षिक आय : 48000", read by the English model as "3:48000": the label
    // became one character it was unsure of, and five digits it was sure of
    // lifted the mean to 0.93. Measured in the real reader.
    const english = { text: '3:48000', score: 0.93, weakest: 0.35 };
    const hindi = { text: 'वार्षिक आय : 48000', score: 0.97, weakest: 0.82, script: 'Devanagari' as const };
    expect(chooseReading(english, [hindi])).toEqual(hindi);
    // Not when the other reading is no surer of its weakest character.
    expect(chooseReading(english, [{ ...hindi, weakest: 0.4 }])).toEqual(english);
  });
});

describe('a line printed upside down', () => {
  /*
   * PaddleOCR's text-line classifier says which lines are upside down — a
   * stamp turned over, a caption the other way. A line it calls upside down is
   * read both ways and the better reading kept, so a wrong call costs a moment
   * and never a reading.
   */
  const TEXTLINE: TextlineConfig = {
    width: 16,
    height: 8,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    scale: 1 / 255,
    labels: [0, 180],
  };

  /** A page dark on its left half and white on its right, one line across it. */
  function halves(): RgbaImage {
    const width = 64;
    const height = 64;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const v = x < 32 ? 40 : 255;
        data.set([v, v, v, 255], (y * width + x) * 4);
      }
    }
    return { data, width, height };
  }

  /**
   * A recogniser that reads "AB" well when the crop's dark half is on the left
   * — the way up the line was printed — and "CC" badly the other way.
   */
  const byWayUp: TensorRunner['recognise'] = async (input, batch, width, contentWidths) => {
    const data = new Float32Array(batch * STEPS * CLASSES);
    const plane = 48 * width;
    contentWidths.forEach((content, row) => {
      const base = row * 3 * plane + 24 * width;
      const darkLeft = input[base + 2]! < input[base + content - 3]!;
      const text = darkLeft ? 'AB' : 'CC';
      const p = darkLeft ? 0.97 : 0.6;
      const indices = [...text].map((c) => CHARACTERS.indexOf(c) + 1);
      for (let t = 0; t < STEPS; t += 1) {
        const cls = t % 2 === 0 ? (indices[t / 2] ?? 0) : 0;
        data[row * STEPS * CLASSES + t * CLASSES + cls] = cls === 0 ? 0.9 : p;
      }
    });
    return { data, timeSteps: STEPS, classes: CLASSES };
  };

  const page = (recognise: TensorRunner['recognise']) => {
    const { runner } = scripted([[4, 20, 60, 30]], () => '');
    return { ...runner, recognise };
  };

  const classifier = (upsideDown: number) => ({
    config: TEXTLINE,
    classify: async (_input: Float32Array, batch: number) =>
      Float32Array.from({ length: batch * 2 }, (_, i) => (i % 2 === 0 ? 1 - upsideDown : upsideDown)),
  });

  /** The same page turned over: the dark half on the right. */
  const turned = (): RgbaImage => {
    const img = halves();
    const data = new Uint8ClampedArray(img.data.length);
    for (let i = 0; i < img.width * img.height; i += 1) {
      data.set(img.data.subarray(i * 4, i * 4 + 4), (img.width * img.height - 1 - i) * 4);
    }
    return { data, width: img.width, height: img.height };
  };

  it('reads a line the classifier calls upside down the other way up', async () => {
    const items = await readPage(turned(), page(byWayUp), { ...CONFIG, textline: classifier(0.96) });
    expect(items.map((item) => item.text)).toEqual(['AB']);
  });

  it('keeps the reading as printed when turning it over reads worse', async () => {
    // The classifier is wrong about an upright line: read both ways, the
    // upright reading wins.
    const items = await readPage(halves(), page(byWayUp), { ...CONFIG, textline: classifier(0.96) });
    expect(items.map((item) => item.text)).toEqual(['AB']);
  });

  it('never turns a line over for a reading that is only a better guess', async () => {
    // A Hindi line hangs from a stroke along its top, which the classifier —
    // trained on Chinese and English — can take for the foot of an upside-down
    // line. The English model reads it badly both ways; the turned-over guess
    // scoring a little higher made the Hindi model read it upside down too, and
    // "नाम : सीमा वर्मा" came back as "H". Turned over is kept only when it reads
    // well in its own right.
    const guessing: TensorRunner['recognise'] = async (input, batch, width, contentWidths) => {
      const data = new Float32Array(batch * STEPS * CLASSES);
      const plane = 48 * width;
      contentWidths.forEach((content, row) => {
        const base = row * 3 * plane + 24 * width;
        const darkLeft = input[base + 2]! < input[base + content - 3]!;
        const [text, p] = darkLeft ? ['AB', 0.72] : ['CA', 0.5];
        const indices = [...text!].map((c) => CHARACTERS.indexOf(c) + 1);
        for (let t = 0; t < STEPS; t += 1) {
          const cls = t % 2 === 0 ? (indices[t / 2] ?? 0) : 0;
          data[row * STEPS * CLASSES + t * CLASSES + cls] = cls === 0 ? 0.9 : (p as number);
        }
      });
      return { data, timeSteps: STEPS, classes: CLASSES };
    };
    const items = await readPage(turned(), page(guessing), { ...CONFIG, textline: classifier(0.96) });
    expect(items.map((item) => item.text)).toEqual(['CA']);
  });

  it('does not turn a line on an unsure call', async () => {
    const items = await readPage(turned(), page(byWayUp), { ...CONFIG, textline: classifier(0.7) });
    expect(items.map((item) => item.text)).toEqual(['CC']);
  });
});

describe('a photo flattened before it is read', () => {
  /*
   * UVDoc, behind a runner: given a photo with a table around the page, the
   * page flattened and the table trimmed; given a scan, nothing — it stretches
   * a flat page into the frame and cuts its margins.
   */
  const paper = [246, 244, 238];
  const table = [128, 96, 72];

  function photo(withTable: boolean): RgbaImage {
    const width = 120;
    const height = 90;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const inside = !withTable || (x >= 15 && x < 105 && y >= 10 && y < 80);
        const ink = inside && y % 10 < 2 && x % 7 < 4;
        const [r, g, b] = ink ? [20, 20, 20] : inside ? paper : table;
        data.set([r!, g!, b!, 255], (y * width + x) * 4);
      }
    }
    return { data, width, height };
  }

  /** "Flattens" by handing back the page region stretched to the frame, as UVDoc does. */
  const unwarper = () => {
    const calls: Array<[number, number]> = [];
    return {
      calls,
      runner: {
        async unwarp(input: Float32Array, width: number, height: number) {
          calls.push([width, height]);
          const out = new Float32Array(3 * width * height);
          const plane = width * height;
          for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
              // Page everywhere but a band of table along the top, as UVDoc leaves.
              const top = y < 4;
              const [r, g, b] = top ? table : paper;
              out[y * width + x] = r! / 255;
              out[plane + y * width + x] = g! / 255;
              out[2 * plane + y * width + x] = b! / 255;
            }
          }
          expect(input.length).toBe(3 * plane);
          return { data: out, width, height };
        },
      },
    };
  };

  it('flattens a photo with the table around it, and trims what is left of the table', async () => {
    const { runner, calls } = unwarper();
    const result = await flattenPage(photo(true), runner);
    expect(calls).toEqual([[120, 90]]);
    expect(result.flattened).toBe(true);
    expect(result.image.height).toBeLessThan(90);
  });

  it('leaves a scan as it came, without asking the model', async () => {
    const { runner, calls } = unwarper();
    const scan = photo(false);
    const result = await flattenPage(scan, runner);
    expect(calls).toEqual([]);
    expect(result).toEqual({ image: scan, flattened: false });
  });

  it('reads the photo as it came when the model fails', async () => {
    const original = photo(true);
    const result = await flattenPage(original, {
      async unwarp() {
        throw new Error('out of memory');
      },
    });
    expect(result).toEqual({ image: original, flattened: false });
  });
});

describe('a small photo, read larger', () => {
  it('reads a photo under a thousand pixels across at one and a half times its size', () => {
    // The user's passbook photo: 780 x 716.
    expect(readingScale(780, 716)).toBe(SMALL_PHOTO_SCALE);
    expect(readingScale(716, 999)).toBe(1.5);
  });

  it('reads every other page as it came', () => {
    expect(readingScale(1000, 600)).toBe(1);
    // The smallest of the documents it was measured on.
    expect(readingScale(1112, 682)).toBe(1);
    expect(readingScale(4000, 3000)).toBe(1);
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

describe('the tables on a page', () => {
  const TABLE: TableConfig = {
    classes: ['sos', '<thead>', '</thead>', '<tbody>', '</tbody>', '<tr>', '</tr>', '<td', '>', '</td>', '<td></td>', 'eos'],
    size: 488,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    scale: 1 / 255,
    locCount: 8,
  };

  /** Three rows of three, the text in the middle of each cell of a 180 x 100 page. */
  const at = (text: string, column: number, row: number) => ({
    text,
    score: 0.99,
    box: { x0: 10 + 60 * column, y0: 10 + 30 * row, x1: 50 + 60 * column, y1: 30 + 30 * row },
  });
  const ITEMS = [
    at('Subject', 0, 0),
    at('Marks', 1, 0),
    at('Result', 2, 0),
    at('Physics', 0, 1),
    at('61', 1, 1),
    at('P', 2, 1),
    at('Chemistry', 0, 2),
    at('74', 1, 2),
    at('P', 2, 2),
  ];

  /**
   * A stand-in for SLANet_plus that answers three rows of three equal cells
   * filling the picture it is shown — whatever the picture's size, which is
   * the part of its answer it reads from the input's padding.
   */
  function threeByThree(): { runner: TableRunner; loads: () => number } {
    let loads = 0;
    const runner: TableRunner = {
      async load() {
        loads += 1;
        return {
          config: TABLE,
          async structure(input, size) {
            // How far down the picture reaches: the first row of padding.
            let height = size;
            while (height > 0 && input[(height - 1) * size] === 0 && input[(height - 1) * size + 1] === 0) height -= 1;
            const tall = height / size;
            const tokens: Array<string | [number, number]> = ['sos'];
            for (let r = 0; r < 3; r += 1) {
              tokens.push('<tr>');
              for (let c = 0; c < 3; c += 1) tokens.push([c, r]);
              tokens.push('</tr>');
            }
            tokens.push('eos');
            const classes = TABLE.classes.length;
            const probs = new Float32Array(tokens.length * classes);
            const locs = new Float32Array(tokens.length * 8);
            tokens.forEach((token, step) => {
              const name = typeof token === 'string' ? token : '<td></td>';
              probs[step * classes + TABLE.classes.indexOf(name)] = 1;
              if (typeof token !== 'string') {
                const [c, r] = token;
                const [x0, x1, y0, y1] = [c / 3, (c + 1) / 3, (r * tall) / 3, ((r + 1) * tall) / 3];
                locs.set([x0, y0, x1, y0, x1, y1, x0, y1], step * 8);
              }
            });
            return { probs, locs, steps: tokens.length };
          },
        };
      },
    };
    return { runner, loads: () => loads };
  }

  it('reads a table cell by cell: the model’s cells, filled with what was read', async () => {
    const { runner } = threeByThree();
    expect(await readTables(white(180, 100), ITEMS, runner)).toEqual([
      {
        rows: [
          ['Subject', 'Marks', 'Result'],
          ['Physics', '61', 'P'],
          ['Chemistry', '74', 'P'],
        ],
      },
    ]);
  });

  it('loads no table model for a page with no table on it', async () => {
    const { runner, loads } = threeByThree();
    const lines = [at('Name', 0, 0), at('ARJUN', 1, 0), at('Semester', 0, 1), at('III', 1, 1)];
    expect(await readTables(white(180, 100), lines, runner)).toEqual([]);
    expect(loads()).toBe(0);
  });

  it('keeps the page’s lines when the table model cannot be had', async () => {
    const failing: TableRunner = {
      load: () => Promise.reject(new Error('no such file')),
    };
    expect(await readTables(white(180, 100), ITEMS, failing)).toEqual([]);
  });
});

describe('the seals on a page', () => {
  /** A page with a violet ring on it, 100 pixels round, at (300, 300). */
  function sealed(): RgbaImage {
    const page = white(600, 500);
    for (let y = 180; y <= 420; y += 1) {
      for (let x = 180; x <= 420; x += 1) {
        if (Math.abs(Math.hypot(x - 300, y - 300) - 100) <= 2) {
          const at = (y * 600 + x) * 4;
          page.data.set([76, 46, 158], at);
        }
      }
    }
    return page;
  }
  const piece = (text: string, x0: number, y0: number, x1: number, y1: number, score = 0.99) => ({
    text,
    score,
    box: { x0, y0, x1, y1 },
  });
  const PAGE = [
    piece('Date of Issue : 14/03/2024', 20, 20, 260, 44),
    // The page's own guess at the ring's lettering.
    piece('SAMMPLEPURAT', 240, 360, 360, 395, 0.8),
  ];

  /** A reader that answers each strip with one arc's words, in its middle. */
  function strips(...answers: string[]) {
    const seen: RgbaImage[] = [];
    const read = async (strip: RgbaImage) => {
      seen.push(strip);
      const text = answers[seen.length - 1] ?? '';
      return text === '' ? [] : [piece(text, strip.width * 0.4, 5, strip.width * 0.6, 40)];
    };
    return { read, seen };
  }

  it('reads a seal’s two arcs from its two strips, and sets aside the page’s guess along the ring', async () => {
    const { read, seen } = strips('TAHSILDAR', 'SAMPLEPURA TALUK');
    const result = await readSeals(sealed(), PAGE, read);
    expect(seen).toHaveLength(2);
    expect(result.seals).toHaveLength(1);
    expect(result.seals[0]!.text).toEqual(['TAHSILDAR', 'SAMPLEPURA TALUK']);
    const box = result.seals[0]!.box;
    expect(Math.round(box.x0 / 10)).toBe(20);
    expect(Math.round(box.x1 / 10)).toBe(40);
    expect(result.items.map((item) => item.text)).toEqual(['Date of Issue : 14/03/2024']);
  });

  it('reads no strip on a page with no seal, and changes nothing', async () => {
    const { read, seen } = strips('TAHSILDAR');
    const result = await readSeals(white(600, 500), PAGE, read);
    expect(seen).toEqual([]);
    expect(result).toEqual({ items: PAGE, seals: [] });
  });

  it('keeps the page’s reading when the strips say nothing, or cannot be read', async () => {
    expect(await readSeals(sealed(), PAGE, strips().read)).toEqual({ items: PAGE, seals: [] });
    const failing = async () => Promise.reject(new Error('the reader fell over'));
    expect(await readSeals(sealed(), PAGE, failing)).toEqual({ items: PAGE, seals: [] });
  });
});
