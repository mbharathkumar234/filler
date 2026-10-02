import { describe, expect, it } from 'vitest';

import { parse } from 'yaml';

import {
  cropForRecognition,
  decodeCtc,
  detectionSize,
  findTextBoxes,
  modelConfigFrom,
  normaliseForDetection,
  normaliseForOrientation,
  PIPELINE_DETECTION,
  rotateQuarter,
  turnsFrom,
  type RgbaImage,
} from './paddle';

/**
 * PaddleOCR, without OpenCV (§ reading a document).
 *
 * PaddleOCR's own browser SDK drives its models through OpenCV.js, and
 * OpenCV.js builds functions with `new Function` — which the extension's
 * content security policy forbids, so the SDK cannot run in an extension page
 * at all. ONNX Runtime itself needs nothing of the kind. So the models run on
 * ONNX Runtime directly, and the steps around them — scaling the page,
 * finding the text boxes in the detector's output, cropping each box for the
 * recogniser, turning the recogniser's output into characters — are ported
 * here from PaddleOCR's own code, as pure functions over plain arrays.
 *
 * These tests pin the arithmetic against PaddleOCR's published behaviour, so a
 * port that drifts from it fails here rather than as a quiet loss of accuracy.
 */

/** A white page with black rectangles standing in for words. */
function page(width: number, height: number, ink: Array<[number, number, number, number]>): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const [x0, y0, x1, y1] of ink) {
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const at = (y * width + x) * 4;
        data[at] = 0;
        data[at + 1] = 0;
        data[at + 2] = 0;
      }
    }
  }
  return { data, width, height };
}

describe('the size a page is scaled to for detection', () => {
  /*
   * PaddleOCR's OCR pipeline, not the detector's own settings file: the file
   * says "long side 960", and the pipeline overrides it with "short side at
   * least 64, long side at most 4000" — detection at the page's own resolution.
   * Measured on the user's documents, following the file instead lost small
   * print (the Form-D certificate's phrases fell from 19 of 20 to 8) and merged
   * words into long lines that took four times as long to read.
   */
  it('detects at the page’s own resolution, as PaddleOCR’s pipeline does', () => {
    const size = detectionSize(1535, 2047, PIPELINE_DETECTION);
    expect(size).toEqual({ width: 1536, height: 2048 });
  });

  it('only enlarges a page whose short side is under 64', () => {
    expect(detectionSize(40, 400, PIPELINE_DETECTION).width).toBe(64);
  });

  it('never exceeds 4000 on the long side', () => {
    const size = detectionSize(3000, 6000, PIPELINE_DETECTION);
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(4000);
  });

  it('can still bring the long side down to a limit, for a caller that asks', () => {
    const size = detectionSize(1535, 2047, { limitSideLen: 960, limitType: 'max', maxSideLimit: 4000 });
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(960 + 16);
    expect(size.height).toBeGreaterThan(size.width);
  });

  it('rounds both sides to a multiple of 32, which the network needs', () => {
    for (const [w, h] of [[1535, 2047], [904, 1280], [820, 1280], [1080, 1615], [300, 200]]) {
      const size = detectionSize(w!, h!, PIPELINE_DETECTION);
      expect(size.width % 32, `${w}x${h}`).toBe(0);
      expect(size.height % 32, `${w}x${h}`).toBe(0);
    }
  });

  it('leaves a small page at its own size, rounded', () => {
    expect(detectionSize(300, 200, PIPELINE_DETECTION)).toEqual({ width: 288, height: 192 });
  });
});

describe('the detector’s input', () => {
  it('is BGR, planar, and normalised with the ImageNet mean and deviation', () => {
    // One pure-red pixel: R=255, G=0, B=0.
    const red: RgbaImage = { data: new Uint8ClampedArray([255, 0, 0, 255]), width: 1, height: 1 };
    const tensor = normaliseForDetection(red, {
      mean: [0.485, 0.456, 0.406],
      std: [0.229, 0.224, 0.225],
      scale: 1 / 255,
    });
    // Channel 0 is blue, so it is (0 - 0.485) / 0.229.
    expect(tensor[0]).toBeCloseTo((0 - 0.485) / 0.229, 5);
    expect(tensor[1]).toBeCloseTo((0 - 0.456) / 0.224, 5);
    expect(tensor[2]).toBeCloseTo((1 - 0.406) / 0.225, 5);
  });
});

describe('finding the text boxes in the detector’s output', () => {
  /** A probability map with two confident blobs, and one faint one. */
  function map(width: number, height: number, blobs: Array<[number, number, number, number, number]>) {
    const data = new Float32Array(width * height);
    for (const [x0, y0, x1, y1, p] of blobs) {
      for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) data[y * width + x] = p;
    }
    return { data, width, height };
  }

  const params = { thresh: 0.3, boxThresh: 0.6, unclipRatio: 1.5, maxCandidates: 1000 };

  it('finds one box per word, in the page’s own coordinates', () => {
    const boxes = findTextBoxes(
      map(100, 50, [
        [10, 10, 40, 20, 0.9],
        [60, 10, 90, 20, 0.9],
      ]),
      { width: 200, height: 100 },
      params,
    );
    expect(boxes).toHaveLength(2);
    // The map is half the page's size, so a box at x=10 on the map is at 20 on the page.
    expect(boxes[0]!.x0).toBeLessThanOrEqual(20);
    expect(boxes[0]!.x1).toBeGreaterThanOrEqual(80);
  });

  it('drops a region the detector was not sure of', () => {
    const boxes = findTextBoxes(map(100, 50, [[10, 10, 40, 20, 0.45]]), { width: 100, height: 50 }, params);
    expect(boxes).toEqual([]);
  });

  it('grows each box by PaddleOCR’s unclip distance, since the map is drawn tight', () => {
    // A 30 x 10 region: area 300, perimeter 80, distance 300 * 1.5 / 80 = 5.625.
    const [box] = findTextBoxes(map(100, 50, [[10, 10, 40, 20, 0.9]]), { width: 100, height: 50 }, params);
    expect(box!.x0).toBeCloseTo(10 - 5.625, 0);
    expect(box!.y1).toBeCloseTo(20 + 5.625, 0);
  });

  it('orders boxes as a person reads them: top to bottom, then left to right', () => {
    const boxes = findTextBoxes(
      map(100, 60, [
        [60, 10, 90, 20, 0.9],
        [10, 11, 40, 21, 0.9],
        [10, 40, 40, 50, 0.9],
      ]),
      { width: 100, height: 60 },
      params,
    );
    expect(boxes.map((b) => Math.round(b.x0) < 30 && b.y0 < 30)).toEqual([true, false, false]);
  });

  it('keeps specks out, since a speck is never a word', () => {
    const boxes = findTextBoxes(map(100, 50, [[10, 10, 12, 12, 0.95]]), { width: 100, height: 50 }, params);
    expect(boxes).toEqual([]);
  });

  /*
   * A photographed page is never quite straight. Measured on the user's own
   * Form-D certificate: every long line of its paragraph vanished, because an
   * upright box around a slanted line is mostly background, its mean fell
   * below 0.6, and it was discarded — while PaddleOCR, which fits a rotated
   * rectangle to each region, read all of them.
   */
  it('keeps a long line photographed at a slant', () => {
    const boxes = findTextBoxes(slantedMap(), { width: 400, height: 100 }, params);
    expect(boxes).toHaveLength(1);
  });

  it('fits the slant: the box is as thick as the line, not as tall as its drift', () => {
    const [box] = findTextBoxes(slantedMap(), { width: 400, height: 100 }, params);
    const [tl, tr, , bl] = box!.quad;
    const long = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
    const short = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]);
    // The band is 8 thick and drifts 18 over its length; unclip adds about 12.
    expect(short).toBeLessThan(24);
    expect(long).toBeGreaterThan(350);
  });
});

/** A band 8 pixels thick, drifting 18 pixels down over 360 across: a line at about 3 degrees. */
function slantedMap() {
  const width = 400;
  const height = 100;
  const data = new Float32Array(width * height);
  for (let x = 20; x < 380; x += 1) {
    const top = Math.round(40 + ((x - 20) * 18) / 360);
    for (let y = top; y < top + 8; y += 1) data[y * width + x] = 0.9;
  }
  return { data, width, height };
}

/** The same slanted band, as ink on a white page. */
function slantedPage(): RgbaImage {
  const width = 400;
  const height = 100;
  const image = page(width, height, []);
  for (let x = 20; x < 380; x += 1) {
    const top = Math.round(40 + ((x - 20) * 18) / 360);
    for (let y = top; y < top + 8; y += 1) {
      const at = (y * width + x) * 4;
      image.data[at] = 0;
      image.data[at + 1] = 0;
      image.data[at + 2] = 0;
    }
  }
  return image;
}

describe('cropping a box for the recogniser', () => {
  it('scales the crop to 48 pixels tall, keeping its proportions', () => {
    const image = page(400, 100, [[20, 30, 220, 70]]);
    const crop = cropForRecognition(image, { x0: 20, y0: 30, x1: 220, y1: 70 }, 48);
    expect(crop.height).toBe(48);
    // 200 x 40 is 5:1, so at 48 tall it is 240 wide.
    expect(crop.contentWidth).toBe(240);
  });

  it('pads a short crop out to the 320 the recogniser was trained on', () => {
    // PaddleOCR pads with zeros up to its base width rather than stretching,
    // and feeds the model exactly that shape.
    const image = page(400, 100, [[20, 30, 220, 70]]);
    const crop = cropForRecognition(image, { x0: 20, y0: 30, x1: 220, y1: 70 }, 48);
    expect(crop.width).toBe(320);
    // Past the content, the padding is zero in normalised space.
    expect(crop.tensor[300]).toBe(0);
  });

  it('never pads a long line down: its width is its own', () => {
    const image = page(1000, 50, [[0, 0, 1000, 50]]);
    const crop = cropForRecognition(image, { x0: 0, y0: 0, x1: 1000, y1: 50 }, 48);
    expect(crop.width).toBe(crop.contentWidth);
    expect(crop.width).toBe(960);
  });

  it('normalises to minus one to one, blue channel first', () => {
    const white = page(10, 10, []);
    const crop = cropForRecognition(white, { x0: 0, y0: 0, x1: 10, y1: 10 }, 48);
    // White is 255 in every channel: (1 - 0.5) / 0.5 = 1.
    expect(crop.tensor[0]).toBeCloseTo(1, 5);
    expect(crop.tensor.length).toBe(3 * 48 * crop.width);
  });

  it('straightens a slanted line before reading it', () => {
    // An upright crop of a slanted line has the ink high at one end and low at
    // the other; the recogniser reads a straight line. PaddleOCR warps each
    // rotated box upright (`get_rotate_crop_image`), and so does this.
    const [box] = findTextBoxes(slantedMap(), { width: 400, height: 100 }, {
      thresh: 0.3,
      boxThresh: 0.6,
      unclipRatio: 1.5,
      maxCandidates: 1000,
    });
    const crop = cropForRecognition(slantedPage(), box!, 48);

    const inkRow = (from: number, to: number) => {
      let sum = 0;
      let count = 0;
      for (let y = 0; y < 48; y += 1) {
        for (let x = from; x < to; x += 1) {
          if (crop.tensor[y * crop.width + x]! < 0) {
            sum += y;
            count += 1;
          }
        }
      }
      return sum / Math.max(1, count);
    };
    const tenth = Math.floor(crop.contentWidth / 10);
    const left = inkRow(tenth, 2 * tenth);
    const right = inkRow(crop.contentWidth - 2 * tenth, crop.contentWidth - tenth);
    expect(Math.abs(left - right)).toBeLessThan(4);
  });

  it('turns a tall, narrow box on its side, as PaddleOCR does with vertical text', () => {
    const image = page(200, 200, [[90, 20, 110, 120]]);
    const crop = cropForRecognition(
      image,
      {
        x0: 90,
        y0: 20,
        x1: 110,
        y1: 120,
        quad: [
          [90, 20],
          [110, 20],
          [110, 120],
          [90, 120],
        ],
      },
      48,
    );
    // 20 wide and 100 tall, read on its side: 100 : 20 at 48 tall is 240 wide.
    expect(crop.contentWidth).toBe(240);
  });
});

describe('turning the recogniser’s output into text (CTC)', () => {
  const DICT = ['A', 'B', 'C', ' '];

  /** One time step per entry: the class that wins, with its probability. */
  function steps(winners: Array<[number, number]>, classes = 5) {
    const data = new Float32Array(winners.length * classes);
    winners.forEach(([cls, p], t) => {
      for (let c = 0; c < classes; c += 1) data[t * classes + c] = (1 - p) / (classes - 1);
      data[t * classes + cls] = p;
    });
    return { data, timeSteps: winners.length, classes };
  }

  it('collapses repeats and drops the blank, which is class zero', () => {
    // A A _ A B B _ C  ->  "AABC": a repeat only counts again after a blank.
    const out = steps([[1, 0.9], [1, 0.9], [0, 0.9], [1, 0.9], [2, 0.9], [2, 0.9], [0, 0.9], [3, 0.9]]);
    expect(decodeCtc(out.data, out.timeSteps, out.classes, DICT).text).toBe('AABC');
  });

  it('scores a reading by the mean probability of the characters it kept', () => {
    const out = steps([[1, 0.8], [0, 0.99], [2, 0.6]]);
    expect(decodeCtc(out.data, out.timeSteps, out.classes, DICT).score).toBeCloseTo(0.7, 5);
  });

  it('reads nothing as nothing, with a score of zero', () => {
    const out = steps([[0, 0.99], [0, 0.99]]);
    expect(decodeCtc(out.data, out.timeSteps, out.classes, DICT)).toEqual({ text: '', score: 0 });
  });
});

describe('the settings file each model ships with', () => {
  it('reads the recogniser’s character list, and adds the space PaddleOCR adds', () => {
    const yml = [
      'Global:',
      '  model_name: en_PP-OCRv5_mobile_rec',
      'PostProcess:',
      '  name: CTCLabelDecode',
      '  character_dict:',
      '  - "0"',
      '  - A',
      "  - '#'",
      '  - "\\u00e9"',
    ].join('\n');
    // Parsed at build time, by a real YAML parser; the extension ships JSON.
    const config = modelConfigFrom(parse(yml));
    expect(config.modelName).toBe('en_PP-OCRv5_mobile_rec');
    expect(config.characters).toEqual(['0', 'A', '#', 'é', ' ']);
  });

  it('reads the detector’s thresholds, falling back to PaddleOCR’s defaults', () => {
    const yml = [
      'Global:',
      '  model_name: PP-OCRv5_mobile_det',
      'PreProcess:',
      '  transform_ops:',
      '  - DetResizeForTest:',
      '      resize_long: 960',
      'PostProcess:',
      '  name: DBPostProcess',
      '  thresh: 0.3',
      '  box_thresh: 0.6',
      '  max_candidates: 1000',
      '  unclip_ratio: 1.5',
    ].join('\n');
    const config = modelConfigFrom(parse(yml));
    expect(config.modelName).toBe('PP-OCRv5_mobile_det');
    expect(config.detection).toEqual({
      limitSideLen: 960,
      thresh: 0.3,
      boxThresh: 0.6,
      maxCandidates: 1000,
      unclipRatio: 1.5,
    });
  });
});

describe('a page photographed sideways', () => {
  /*
   * A phone held the wrong way round gives a page whose lines run up the
   * picture. The detector still finds them; the recogniser reads nothing, since
   * it was only ever shown upright text. PaddleOCR's answer is a small
   * classifier that says which way up the page is, run before anything else.
   */

  /** A page whose every pixel is its own index, so a turn can be followed. */
  const numbered = (width: number, height: number): RgbaImage => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i += 1) data.set([i, i, i, 255], i * 4);
    return { data, width, height };
  };
  const reds = (image: RgbaImage) =>
    Array.from({ length: image.width * image.height }, (_, i) => image.data[i * 4]);

  it('turns a page a quarter clockwise', () => {
    // 0 1 2      3 0
    // 3 4 5  ->  4 1
    //            5 2
    const turned = rotateQuarter(numbered(3, 2), 1);
    expect([turned.width, turned.height]).toEqual([2, 3]);
    expect(reds(turned)).toEqual([3, 0, 4, 1, 5, 2]);
  });

  it('turns a page upside down', () => {
    const turned = rotateQuarter(numbered(3, 2), 2);
    expect([turned.width, turned.height]).toEqual([3, 2]);
    expect(reds(turned)).toEqual([5, 4, 3, 2, 1, 0]);
  });

  it('turns a page a quarter anticlockwise', () => {
    // 0 1 2      2 5
    // 3 4 5  ->  1 4
    //            0 3
    const turned = rotateQuarter(numbered(3, 2), 3);
    expect([turned.width, turned.height]).toEqual([2, 3]);
    expect(reds(turned)).toEqual([2, 5, 1, 4, 0, 3]);
  });

  it('leaves an upright page as it is, and four quarters come back round', () => {
    const image = numbered(3, 2);
    expect(rotateQuarter(image, 0)).toBe(image);
    let turned = image;
    for (let i = 0; i < 4; i += 1) turned = rotateQuarter(turned, 1);
    expect(reds(turned)).toEqual(reds(image));
  });

  const ORIENTATION = modelConfigFrom(
    parse(`
Global:
  model_name: PP-LCNet_x1_0_doc_ori
PreProcess:
  transform_ops:
  - ResizeImage:
      resize_short: 256
  - CropImage:
      size: 224
  - NormalizeImage:
      channel_num: 3
      mean: [0.485, 0.456, 0.406]
      order: ''
      scale: 0.00392156862745098
      std: [0.229, 0.224, 0.225]
  - ToCHWImage: null
PostProcess:
  Topk:
    topk: 1
    label_list: ['0', '90', '180', '270']
`),
  ).orientation!;

  it('reads the classifier’s settings from its own file', () => {
    expect(ORIENTATION.resizeShort).toBe(256);
    expect(ORIENTATION.cropSize).toBe(224);
    expect(ORIENTATION.labels).toEqual([0, 90, 180, 270]);
    expect(ORIENTATION.mean).toEqual([0.485, 0.456, 0.406]);
  });

  it('gives the classifier the middle of the page, 224 square, red first', () => {
    // Pure red: after normalising, the red plane is high and the others low.
    const width = 600;
    const height = 900;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i += 1) data.set([255, 0, 0, 255], i * 4);

    const tensor = normaliseForOrientation({ data, width, height }, ORIENTATION);
    const plane = 224 * 224;
    expect(tensor.length).toBe(3 * plane);
    expect(tensor[0]).toBeCloseTo((1 - 0.485) / 0.229, 4);
    expect(tensor[plane]).toBeCloseTo((0 - 0.456) / 0.224, 4);
    expect(tensor[2 * plane]).toBeCloseTo((0 - 0.406) / 0.225, 4);
  });

  it('crops the middle, not the corner', () => {
    // White everywhere but a black left edge a sixth of the page wide: the
    // short side goes to 256, the crop takes the middle 224, and the edge —
    // under 43 of those 256 pixels, of which the crop drops the outer 16 — is
    // still there on the left and gone from the right.
    const width = 600;
    const height = 600;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < 100; x += 1) data.set([0, 0, 0, 255], (y * width + x) * 4);
    }
    const tensor = normaliseForOrientation({ data, width, height }, ORIENTATION);
    const black = (0 - 0.485) / 0.229;
    const white = (1 - 0.485) / 0.229;
    expect(tensor[112 * 224]).toBeCloseTo(black, 3);
    expect(tensor[112 * 224 + 223]).toBeCloseTo(white, 3);
  });

  it('says how far to turn a page back, and how sure it is', () => {
    // The label is how far the page has been turned clockwise; it is turned
    // back by the rest of the circle.
    expect(turnsFrom([0.9, 0.05, 0.03, 0.02], ORIENTATION.labels)).toEqual({ turns: 0, confidence: 0.9 });
    expect(turnsFrom([0.1, 0.8, 0.05, 0.05], ORIENTATION.labels)).toEqual({ turns: 3, confidence: 0.8 });
    expect(turnsFrom([0.1, 0.1, 0.7, 0.1], ORIENTATION.labels)).toEqual({ turns: 2, confidence: 0.7 });
    expect(turnsFrom([0.1, 0.1, 0.2, 0.6], ORIENTATION.labels)).toEqual({ turns: 1, confidence: 0.6 });
  });
});
