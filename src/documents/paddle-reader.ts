/**
 * Reading one page with PaddleOCR's models (§ reading a document).
 *
 * The loop around the models: scale the page for the detector, find the text
 * boxes, crop each one, read the crops in batches, and hand back every box that
 * read as something. The models themselves are behind `TensorRunner`, so this
 * runs the same against ONNX Runtime in the offscreen reader and against a
 * scripted runner in a test.
 */

import {
  PIPELINE_DETECTION,
  cropForRecognition,
  decodeCtc,
  detectionSize,
  findTextBoxes,
  normaliseForDetection,
  normaliseForOrientation,
  resizeBilinear,
  rotateQuarter,
  turnsFrom,
  type Box,
  type DetectionParams,
  type DetectionScaling,
  type OrientationConfig,
  type QuarterTurns,
  type RgbaImage,
} from './paddle';

/** The two models, reduced to what the loop needs from them. */
export interface TensorRunner {
  /** Input `[1, 3, height, width]`; returns the probability map. */
  detect(
    input: Float32Array,
    width: number,
    height: number,
  ): Promise<{ data: Float32Array; width: number; height: number }>;
  /**
   * Input `[batch, 3, 48, width]`; returns `[batch, timeSteps, classes]`.
   * `contentWidths` says how much of each row of the batch is crop rather than
   * padding — the model does not need it, a test does.
   */
  recognise(
    input: Float32Array,
    batch: number,
    width: number,
    contentWidths: readonly number[],
  ): Promise<{ data: Float32Array; timeSteps: number; classes: number }>;
}

/** The page-orientation classifier, reduced to what is asked of it. */
export interface OrientationRunner {
  /** Input `[1, 3, size, size]`; returns one score per class. */
  orient(input: Float32Array, size: number): Promise<ArrayLike<number>>;
}

/**
 * How sure the classifier must be before a page is turned.
 *
 * Measured on the user's five documents, each turned all four ways: twenty of
 * twenty right, and never less sure than 0.86 (its training smooths the top
 * score to about 0.93, so that is what certainty looks like). A coin toss
 * between two ways up is 0.5. The bar sits between, nearer certainty, because
 * the two mistakes are not equal: a sideways page left sideways reads as badly
 * as it did before this existed, and an upright page turned on a guess loses a
 * reading that would have been good.
 */
export const ORIENTATION_MIN_CONFIDENCE = 0.7;

export interface UprightPage {
  image: RgbaImage;
  /** Quarter turns clockwise that stood the page upright; 0 for a page left as it came. */
  turns: QuarterTurns;
}

/**
 * The page, stood upright if it plainly was not.
 *
 * Best effort: a classifier that fails is a page read as it came, which is
 * what every page was before.
 */
export async function uprightPage(
  image: RgbaImage,
  runner: OrientationRunner,
  config: OrientationConfig,
): Promise<UprightPage> {
  try {
    const scores = await runner.orient(normaliseForOrientation(image, config), config.cropSize);
    const { turns, confidence } = turnsFrom(scores, config.labels);
    if (turns === 0 || confidence < ORIENTATION_MIN_CONFIDENCE) return { image, turns: 0 };
    return { image: rotateQuarter(image, turns), turns };
  } catch {
    return { image, turns: 0 };
  }
}

export interface ReadItem {
  text: string;
  /** The recogniser's mean character probability, 0–1. */
  score: number;
  box: Box;
}

const RECOGNITION_HEIGHT = 48;

/**
 * Crops per call to the recogniser.
 *
 * PaddleOCR batches its crops, sorted by width so each batch pads little.
 * Batching is most of the speed on a page with a hundred boxes.
 */
const BATCH_SIZE = 8;

export async function readPage(
  image: RgbaImage,
  runner: TensorRunner,
  config: {
    detection: DetectionParams;
    characters: readonly string[];
    /** How the page is scaled for detection; PaddleOCR's pipeline defaults otherwise. */
    scaling?: DetectionScaling;
  },
): Promise<ReadItem[]> {
  // 1. Detection, at the size PaddleOCR's pipeline uses: the page's own.
  const size = detectionSize(image.width, image.height, config.scaling ?? PIPELINE_DETECTION);
  const scaled =
    size.width === image.width && size.height === image.height
      ? image
      : resizeBilinear(image, size.width, size.height);
  const map = await runner.detect(normaliseForDetection(scaled), size.width, size.height);
  const boxes = findTextBoxes(map, { width: image.width, height: image.height }, config.detection);
  if (boxes.length === 0) return [];

  // 2. Recognition, cropped from the page at full resolution.
  const crops = boxes.map((box) => cropForRecognition(image, box, RECOGNITION_HEIGHT));

  // Narrowest first, so each batch pads to a width close to its own.
  const order = crops.map((_, index) => index).sort((a, b) => crops[a]!.width - crops[b]!.width);
  const read: Array<{ text: string; score: number } | undefined> = new Array(crops.length);

  for (let start = 0; start < order.length; start += BATCH_SIZE) {
    const indices = order.slice(start, start + BATCH_SIZE);
    const width = Math.max(...indices.map((i) => crops[i]!.width));
    const plane = RECOGNITION_HEIGHT * width;
    const input = new Float32Array(indices.length * 3 * plane);

    indices.forEach((cropIndex, row) => {
      const crop = crops[cropIndex]!;
      const cropPlane = RECOGNITION_HEIGHT * crop.width;
      for (let channel = 0; channel < 3; channel += 1) {
        for (let y = 0; y < RECOGNITION_HEIGHT; y += 1) {
          const from = channel * cropPlane + y * crop.width;
          const to = row * 3 * plane + channel * plane + y * width;
          input.set(crop.tensor.subarray(from, from + crop.width), to);
        }
      }
    });

    const output = await runner.recognise(
      input,
      indices.length,
      width,
      indices.map((i) => crops[i]!.contentWidth),
    );
    const stride = output.timeSteps * output.classes;
    indices.forEach((cropIndex, row) => {
      read[cropIndex] = decodeCtc(
        output.data,
        output.timeSteps,
        output.classes,
        config.characters,
        row * stride,
      );
    });
  }

  // 3. Every box that read as something, in reading order.
  const items: ReadItem[] = [];
  boxes.forEach((box, index) => {
    const result = read[index];
    if (result === undefined || result.text.trim() === '') return;
    items.push({
      text: result.text.trim(),
      score: result.score,
      box: { x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 },
    });
  });
  return items;
}
