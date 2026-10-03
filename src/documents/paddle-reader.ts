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
  cropForTextline,
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
  type TableConfig,
  type TextlineConfig,
} from './paddle';
import { INDIC_SCRIPTS, type IndicScript } from './indic';
import { backgroundColour, trimBackground } from './scan';
import { findSeals, outsideSeals, sealBox, sealWords, unrollSeal } from './seal';
import {
  decodeStructure,
  fillTable,
  tableInput,
  tableRegions,
  widenToRules,
  type PlacedText,
  type ReadTable,
} from './table';

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

/** The text-line orientation classifier, and the size it reads a line at. */
export interface TextlineRunner {
  config: TextlineConfig;
  /** Input `[batch, 3, height, width]`; returns `batch` rows of one score per class. */
  classify(input: Float32Array, batch: number): Promise<ArrayLike<number>>;
}

/** UVDoc, reduced to what is asked of it. */
export interface UnwarpRunner {
  /** Input `[1, 3, height, width]`, RGB in 0–1; returns the page flattened, the same way. */
  unwarp(input: Float32Array, width: number, height: number): Promise<{ data: Float32Array; width: number; height: number }>;
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
  /** Set when a recogniser for another script read this box; absent for the English model. */
  script?: IndicScript;
}

/**
 * A recogniser for another script: its alphabet, and how to run it.
 *
 * PaddleOCR's language models share the English model's shape — a line 48
 * pixels high in, CTC classes out — and differ only in the alphabet, so the
 * loop that reads with one reads with any.
 */
export interface Alternate {
  /** The script its alphabet is for, and which its readings must be written in. */
  script: IndicScript;
  characters: readonly string[];
  recognise: TensorRunner['recognise'];
}

interface Reading {
  text: string;
  score: number;
  /** The least sure character's probability; the mean when it was not measured. */
  weakest?: number;
  /** The longest stretch of the box that read as nothing, in line-heights. */
  gap?: number;
}

/**
 * Below this, the English model was guessing, and the other scripts are asked.
 *
 * Measured on the user's own cards: every real English line read at 0.87 or
 * above, and every word of another script, read by the English model, between
 * 0.22 and 0.62 (`layout.ts` → `SCRIPT_MISREAD_BELOW`). 0.8 asks about the
 * whole of the second range and none of the first.
 */
export const SECOND_LOOK_BELOW = 0.8;

/**
 * Or when any one character is below this.
 *
 * Measured in the real reader: "वार्षिक आय : 48000" read by the English model
 * as "3:48000" at a mean of 0.93 — the whole Hindi label became one character
 * it was unsure of, and five digits it was sure of lifted the mean. The mean
 * hides a guessed word beside digits; the weakest character does not. A second
 * look at an English line with one blurred letter costs a moment and changes
 * nothing, since another script's reading must be in that script to count.
 */
export const WEAK_CHARACTER = 0.6;

/** How much surer of its weakest character another reading must be, when the means are close. */
export const WEAKEST_MARGIN = 0.2;

/**
 * Or when it has fewer characters than this per line-height of the box's width.
 *
 * The English model can be sure of every character it keeps and still have
 * read half a box: "वार्षिक आय : 48000" came back as "3:48000" at 0.93, its
 * weakest character 0.665 — the Hindi label simply became nothing. Measured in
 * the real reader, English lines carry 1.73 to 2.78 characters per line-height
 * (spaced capitals like "T O T A L" the fewest); that line carried 1.25, and
 * Kannada read by the English model 0.48 to 0.73.
 */
export const SPARSE_BELOW = 1.5;

/**
 * Or when a stretch of it this many line-heights long read as nothing at all.
 *
 * A label in another script beside a date can vanish whole while the date reads
 * well: "పుట్టిన తేదీ : 02/08/2003" came back as ": 02/08/2003", sure enough of
 * every character, dense enough over its width. Measured in the real reader,
 * English lines never left more than 0.67 of a line-height unread; lines whose
 * label vanished left 1.34 to 3.03.
 */
export const GAP_LINE_HEIGHTS = 1.2;

/**
 * Another script's reading is never taken with a character weaker than this.
 *
 * Measured: true Hindi readings never had a weakest character below 0.51; the
 * Devanagari model's readings of a Karnataka card's Kannada — sure enough on
 * average, and mostly in its script — never one above 0.28.
 */
export const ALTERNATE_WEAKEST_FLOOR = 0.45;

/** A reading that fills a box the English one left half empty must be at least this sure. */
export const FULLER_FLOOR = 0.85;

/**
 * A reading in another script must be at least this sure… — the bar every box
 * clears to be read at all (`layout.ts` → `SCRIPT_MISREAD_BELOW`), so a reading
 * chosen here is never dropped there.
 */
export const ALTERNATE_FLOOR = 0.7;

/** …and this much surer than the English model's guess. */
export const ALTERNATE_MARGIN = 0.1;

/**
 * At least this share of a reading's letters must be in the recogniser's own
 * script. Each language model's alphabet carries the Latin letters too, and an
 * English word read back in Latin is no evidence the word was anything else.
 */
const OWN_SCRIPT_SHARE = 0.5;

/** The share of `text`'s letters (vowel signs included) written in `script`. */
function scriptShare(text: string, script: IndicScript): number {
  const pattern = INDIC_SCRIPTS[script].pattern;
  let letters = 0;
  let own = 0;
  for (const char of text) {
    if (!/[\p{L}\p{M}]/u.test(char)) continue;
    letters += 1;
    if (pattern.test(char)) own += 1;
  }
  return letters === 0 ? 0 : own / letters;
}

/**
 * Was the English model guessing at this box — wholly, at one word of it, or by
 * leaving part of it unread? `units` is the box's width in line-heights.
 */
export function isDoubtful(reading: Reading | undefined, units?: number): boolean {
  if (reading === undefined || reading.text.trim() === '') return true;
  if (reading.score < SECOND_LOOK_BELOW || (reading.weakest ?? reading.score) < WEAK_CHARACTER) return true;
  if ((reading.gap ?? 0) >= GAP_LINE_HEIGHTS) return true;
  return units !== undefined && units > 0 && reading.text.length / units < SPARSE_BELOW;
}

/**
 * Which reading of one box to keep.
 *
 * The English model's, unless it was guessing and another script's recogniser
 * read the box in its own script, surely throughout, and clearly better: on the
 * whole, at the word the English model could only guess, or by reading the
 * part of the box it left empty. Pure, so the thresholds are tested on their
 * own. `units` is the box's width in line-heights.
 */
export function chooseReading(
  primary: Reading,
  others: ReadonlyArray<Reading & { script: IndicScript }>,
  units?: number,
): Reading & { script?: IndicScript } {
  if (!isDoubtful(primary, units)) return primary;
  const length = primary.text.trim().length;
  const primaryWeakest = primary.weakest ?? primary.score;
  let best: (Reading & { script: IndicScript }) | null = null;
  for (const other of others) {
    if (other.text.trim() === '' || other.score < ALTERNATE_FLOOR) continue;
    if ((other.weakest ?? other.score) < ALTERNATE_WEAKEST_FLOOR) continue;
    if (scriptShare(other.text, other.script) < OWN_SCRIPT_SHARE) continue;
    const fuller =
      other.score >= FULLER_FLOOR && other.text.length >= Math.max(length * 1.5, length + 3);
    const clearer =
      length === 0 ||
      other.score >= primary.score + ALTERNATE_MARGIN ||
      (other.weakest ?? other.score) >= primaryWeakest + WEAKEST_MARGIN ||
      fuller;
    if (!clearer) continue;
    if (best === null || other.score > best.score) best = other;
  }
  if (best === null) return primary;
  const chosen = best;
  return { ...chosen, text: agreedNumber(chosen.text, [primary, ...others.filter((other) => other !== chosen)]) };
}

/** The last number in a reading — digits with the separators dates and amounts print — and where it starts. */
function lastNumber(text: string): { value: string; index: number } | null {
  const match = /(\d(?:[\d,./-]*\d)?)(?![\s\S]*\d)/.exec(text);
  return match === null ? null : { value: match[1]!, index: match.index };
}

/**
 * The chosen reading, with its number replaced by the one the other readings
 * agree on, when two of them do and it does not.
 *
 * Digits look the same to every model. On a made-up Tamil certificate the
 * Tamil model — which read the label, and so was chosen — dropped the 6 of
 * 60000; the Devanagari model read 60000; the English model read "66660000",
 * its guess at the label glued onto the digits. A reading agrees with a number
 * its own number ends in, so glued junk is no vote against it; one of them must
 * have read the number exactly. One reading against two is outvoted; one
 * against one is left as it was read.
 */
function agreedNumber(text: string, others: readonly Reading[]): string {
  const mine = lastNumber(text);
  if (mine === null) return text;
  const theirs = others.map((other) => lastNumber(other.text)?.value).filter((value) => value !== undefined);
  let agreed: string | null = null;
  for (const candidate of new Set(theirs)) {
    if (candidate === mine.value) continue;
    const support = theirs.filter((value) => value.endsWith(candidate)).length;
    if (support >= 2 && (agreed === null || candidate.length > agreed.length)) agreed = candidate;
  }
  if (agreed === null) return text;
  return text.slice(0, mine.index) + agreed + text.slice(mine.index + mine.value.length);
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
    /**
     * Recognisers for other scripts, asked about the boxes the English model
     * was guessing at. A function, so they are loaded only when a page has
     * such a box — a page of English never pays for them.
     */
    alternates?: () => Promise<readonly Alternate[]>;
    /** Says which lines are upside down; those are read both ways. */
    textline?: TextlineRunner;
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
  const read = await recogniseCrops(
    crops,
    crops.map((_, index) => index),
    runner.recognise.bind(runner),
    config.characters,
  );

  // 3. A line the classifier calls upside down is read the other way up too,
  // and kept that way only if it reads better. A wrong call costs a moment.
  if (config.textline) {
    const over = await upsideDown(image, boxes, config.textline);
    if (over.length > 0) {
      const turned = crops.map((crop, index) => (over.includes(index) ? turnOver(crop) : crop));
      const again = await recogniseCrops(turned, over, runner.recognise.bind(runner), config.characters);
      for (const index of over) {
        const before = read[index]?.score ?? 0;
        const after = again[index];
        // Turned over only when that reads well in its own right — not merely
        // less badly. A Hindi line can look upside down to the classifier, and
        // the English model reads it badly either way up.
        if (after !== undefined && after.score >= TURNED_READS_WELL && after.score >= before + TURNED_MARGIN) {
          read[index] = after;
          crops[index] = turned[index]!;
        }
      }
    }
  }

  // 4. A second look at every box the English model was guessing at, by each
  // recogniser for another script — loaded now, the first time one is needed.
  const units = crops.map((crop) => crop.contentWidth / RECOGNITION_HEIGHT);
  const doubtful = crops.map((_, index) => index).filter((index) => isDoubtful(read[index], units[index]));
  const others: Array<Array<(Reading & { script: IndicScript }) | undefined>> = [];
  if (doubtful.length > 0 && config.alternates) {
    for (const alternate of await config.alternates()) {
      const readings = await recogniseCrops(crops, doubtful, alternate.recognise, alternate.characters);
      others.push(readings.map((reading) => (reading === undefined ? undefined : { ...reading, script: alternate.script })));
    }
  }

  // 5. Every box that read as something, in reading order.
  const items: ReadItem[] = [];
  boxes.forEach((box, index) => {
    const primary = read[index] ?? { text: '', score: 0, weakest: 0 };
    const result = chooseReading(
      primary,
      others.map((readings) => readings[index]).filter((reading) => reading !== undefined),
      units[index],
    );
    if (result.text.trim() === '') return;
    items.push({
      text: result.text.trim(),
      score: result.score,
      box: { x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 },
      ...(result.script === undefined ? {} : { script: result.script }),
    });
  });
  return items;
}

/** The classifier must be at least this sure a line is upside down before it is read the other way. */
export const TEXTLINE_MIN_CONFIDENCE = 0.9;

/** A line read turned over is kept only if it reads this well… */
export const TURNED_READS_WELL = 0.8;
/** …and this much better than the line as printed. */
export const TURNED_MARGIN = 0.1;

/** Lines per call to the text-line classifier. */
const TEXTLINE_BATCH = 32;

/** The boxes the classifier is sure are upside down. */
async function upsideDown(image: RgbaImage, boxes: readonly Box[], textline: TextlineRunner): Promise<number[]> {
  const { config } = textline;
  const turned = config.labels.indexOf(180);
  if (turned === -1) return [];
  const plane = 3 * config.width * config.height;
  const over: number[] = [];
  try {
    for (let start = 0; start < boxes.length; start += TEXTLINE_BATCH) {
      const batch = boxes.slice(start, start + TEXTLINE_BATCH);
      const input = new Float32Array(batch.length * plane);
      batch.forEach((box, row) => input.set(cropForTextline(image, box, config), row * plane));
      const scores = await textline.classify(input, batch.length);
      const classes = config.labels.length;
      batch.forEach((_, row) => {
        const own = Array.from({ length: classes }, (_, c) => scores[row * classes + c]!);
        const best = own.indexOf(Math.max(...own));
        if (best === turned && own[best]! >= TEXTLINE_MIN_CONFIDENCE) over.push(start + row);
      });
    }
  } catch {
    // A classifier that fails leaves every line as printed, as before it existed.
    return [];
  }
  return over;
}

/** A recognition crop turned over: its content reversed both ways, its padding left where it was. */
function turnOver(crop: ReturnType<typeof cropForRecognition>): ReturnType<typeof cropForRecognition> {
  const { width, height, contentWidth } = crop;
  const plane = width * height;
  const tensor = new Float32Array(crop.tensor);
  for (let channel = 0; channel < 3; channel += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < contentWidth; x += 1) {
        tensor[channel * plane + (height - 1 - y) * width + (contentWidth - 1 - x)] =
          crop.tensor[channel * plane + y * width + x]!;
      }
    }
  }
  return { ...crop, tensor };
}

/** UVDoc is shown the page no larger than this on its longer side. */
export const MAX_UNWARP_SIDE = 2000;

/**
 * A photo flattened, when it is a photo of a page lying on something.
 *
 * Measured on a made-up marks card photographed curled on a table: as
 * photographed, the rows no longer lined up, and three subjects' marks paired
 * with the wrong subject; flattened, every row was back in line. On a page
 * that was already flat, UVDoc stretches the page into the frame and cuts its
 * margins — so a scan, a PDF page, a photo the page fills, is left as it came
 * (`scan.ts` → `hasBackground`). What UVDoc leaves of the table is trimmed.
 * Best effort: a model that fails is a page read as it came.
 */
export async function flattenPage(
  image: RgbaImage,
  runner: UnwarpRunner,
): Promise<{ image: RgbaImage; flattened: boolean }> {
  const table = backgroundColour(image);
  if (table === null) return { image, flattened: false };
  try {
    const scale = Math.min(1, MAX_UNWARP_SIDE / Math.max(image.width, image.height));
    const shown =
      scale === 1
        ? image
        : resizeBilinear(image, Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
    const { width, height } = shown;
    const plane = width * height;
    const input = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i += 1) {
      input[i] = shown.data[i * 4]! / 255;
      input[plane + i] = shown.data[i * 4 + 1]! / 255;
      input[2 * plane + i] = shown.data[i * 4 + 2]! / 255;
    }
    const out = await runner.unwarp(input, width, height);
    const outPlane = out.width * out.height;
    const data = new Uint8ClampedArray(outPlane * 4);
    for (let i = 0; i < outPlane; i += 1) {
      data[i * 4] = out.data[i]! * 255;
      data[i * 4 + 1] = out.data[outPlane + i]! * 255;
      data[i * 4 + 2] = out.data[2 * outPlane + i]! * 255;
      data[i * 4 + 3] = 255;
    }
    return { image: trimBackground({ data, width: out.width, height: out.height }, table), flattened: true };
  } catch {
    return { image, flattened: false };
  }
}

/**
 * Read the crops at `which` with one recogniser, in batches.
 *
 * PaddleOCR batches its crops, sorted by width so each batch pads little —
 * narrowest first. Returns a reading per crop index; crops not asked about are
 * left undefined.
 */
async function recogniseCrops(
  crops: ReadonlyArray<ReturnType<typeof cropForRecognition>>,
  which: readonly number[],
  recognise: TensorRunner['recognise'],
  characters: readonly string[],
): Promise<Array<Reading | undefined>> {
  const order = [...which].sort((a, b) => crops[a]!.width - crops[b]!.width);
  const read: Array<Reading | undefined> = new Array(crops.length);

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

    const output = await recognise(
      input,
      indices.length,
      width,
      indices.map((i) => crops[i]!.contentWidth),
    );
    const stride = output.timeSteps * output.classes;
    // Steps per line-height of width: the model reads a 48-pixel-high line in
    // steps of a fixed width, so this is the same for every row of the batch.
    const stepsPerLine = (output.timeSteps * RECOGNITION_HEIGHT) / width;
    indices.forEach((cropIndex, row) => {
      const contentSteps = Math.ceil((crops[cropIndex]!.contentWidth / width) * output.timeSteps);
      const decoded = decodeCtc(output.data, output.timeSteps, output.classes, characters, row * stride, contentSteps);
      read[cropIndex] = { ...decoded, gap: decoded.gap / stepsPerLine };
    });
  }
  return read;
}

/**
 * The table model, SLANet_plus, as the reader calls it: loaded the first time a
 * page has a table on it, so a page with none never pays for it.
 */
export interface TableRunner {
  load(): Promise<{
    config: TableConfig;
    /** The structure tokens' scores at each step, and each step's cell corners. */
    structure(input: Float32Array, size: number): Promise<{ probs: Float32Array; locs: Float32Array; steps: number }>;
  }>;
}

/**
 * The tables on a page that has been read, each as a grid of its cells' text
 * (`table.ts`).
 *
 * Where a table is comes from the text already read; the model is asked only
 * about those places. A table the model cannot read — or a model that cannot
 * be had — costs the page nothing it had: its lines were read already, and the
 * extraction rules read those.
 */
export async function readTables(
  image: RgbaImage,
  items: readonly PlacedText[],
  runner: TableRunner,
): Promise<ReadTable[]> {
  const regions = tableRegions(items);
  if (regions.length === 0) return [];

  try {
    const model = await runner.load();
    const tables: ReadTable[] = [];
    for (const region of regions) {
      const box = widenToRules(image, region);
      const { data, ratio } = tableInput(image, box, model.config);
      const output = await model.structure(data, model.config.size);
      const structure = decodeStructure(output, model.config, { ratio, offset: { x: box.x0, y: box.y0 } });
      const table = fillTable(structure, items);
      // A grid with one row, or with nothing in it across, is not a table read.
      if (table.rows.length >= 2 && table.rows.some((row) => row.filter((cell) => cell !== '').length >= 2)) {
        tables.push(table);
      }
    }
    return tables;
  } catch {
    return [];
  }
}

/** A seal read off a page: where it is, and the words along its arcs — over the top, then under the bottom. */
export interface ReadSeal {
  box: Box;
  text: string[];
}

/**
 * The round seals on a page that has been read, each read again as two straight
 * strips (`seal.ts`) by the same reader as the page.
 *
 * What the page's own reading guessed along a ring that was read is set aside:
 * the strips read those letters straight. A ring whose strips say nothing — or
 * cannot be read — changes nothing: the page keeps what it read.
 */
export async function readSeals(
  image: RgbaImage,
  items: readonly ReadItem[],
  read: (strip: RgbaImage) => Promise<ReadItem[]>,
): Promise<{ items: ReadItem[]; seals: ReadSeal[] }> {
  const found = findSeals(image);
  const seals: ReadSeal[] = [];
  const replaced: typeof found = [];
  for (const seal of found) {
    try {
      const text: string[] = [];
      for (const way of ['over', 'under'] as const) {
        const strip = unrollSeal(image, seal, way);
        const words = sealWords(await read(strip), strip.width);
        if (words !== '') text.push(words);
      }
      if (text.length > 0) {
        seals.push({ box: sealBox(seal), text });
        replaced.push(seal);
      }
    } catch {
      // The page's own reading of it stands.
    }
  }
  return { items: replaced.length === 0 ? [...items] : outsideSeals(items, replaced), seals };
}
