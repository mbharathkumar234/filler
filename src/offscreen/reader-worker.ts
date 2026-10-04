/// <reference lib="webworker" />
/**
 * The document reader itself (§ reading a document).
 *
 * A dedicated Web Worker started by the offscreen page — which is why the
 * offscreen page exists at all: a service worker cannot start a Web Worker. It
 * holds ONNX Runtime and PaddleOCR's three models, stands each page upright,
 * reads it, and answers with every piece of text it found and where it sits.
 *
 * **Everything it loads is inside the package.** The models are fetched from
 * the extension's own origin, whose address the offscreen page hands over with
 * each request (a worker has no `chrome.runtime` to ask). ONNX Runtime's
 * WebAssembly is a build asset of this package. The extension's CSP
 * (`connect-src 'self'`) refuses anything else.
 */

import type * as Ort from 'onnxruntime-web/wasm';

import {
  flattenPage,
  readPage,
  readSeals,
  readTables,
  readingScale,
  uprightPage,
  type Alternate,
  type ReadSeal,
  type OrientationRunner,
  type TableRunner,
  type TensorRunner,
  type TextlineRunner,
  type UnwarpRunner,
} from '@/documents/paddle-reader';
import type { ReadTable } from '@/documents/table';
import type { IndicScript } from '@/documents/indic';
import { evenLighting } from '@/documents/scan';
import type { ModelConfig, QuarterTurns, RgbaImage } from '@/documents/paddle';
import { readerThreads } from '@/documents/preprocess';
import type { OcrItem } from '@/shared/messages';

declare const self: DedicatedWorkerGlobalScope;

/** The models `ocrAssets()` unpacks into `dist/ocr/`, loaded for every reading. */
const DETECTOR = 'PP-OCRv5_mobile_det';
const RECOGNISER = 'en_PP-OCRv5_mobile_rec';
const ORIENTATION = 'PP-LCNet_x1_0_doc_ori';
/** Under a megabyte: says which lines are upside down. */
const TEXTLINE = 'PP-LCNet_x0_25_textline_ori';
/** Thirty megabytes, loaded the first time a photo has a table around the page. */
const UNWARP = 'UVDoc';
/** Eight megabytes, loaded the first time a page has a table of text on it: a grade card's courses. */
const TABLE = 'SLANet_plus';
const RECOGNITION_HEIGHT = 48;

/**
 * PaddleOCR's recognisers for the other scripts this build reads.
 *
 * Each reads its own script, the digits and the Latin letters, and is asked
 * only about a box the English model was guessing at (`paddle-reader.ts` →
 * `chooseReading`). Devanagari is one model for Hindi, Marathi, Sanskrit,
 * Nepali, Konkani, Maithili, Bodo and Dogri.
 */
const OTHER_SCRIPTS: ReadonlyArray<{ name: string; script: IndicScript }> = [
  { name: 'devanagari_PP-OCRv5_mobile_rec', script: 'Devanagari' },
  { name: 'te_PP-OCRv5_mobile_rec', script: 'Telugu' },
  { name: 'ta_PP-OCRv5_mobile_rec', script: 'Tamil' },
];

type Runtime = typeof Ort;

/**
 * ONNX Runtime, loaded as a file of its own.
 *
 * With more than one thread it starts each thread by loading the file it lives
 * in. Imported the ordinary way it lives in *this* file, and every thread would
 * start a second reader; imported like this the bundler gives it a file to
 * itself, which holds nothing else.
 *
 * Loaded on the first reading, not while this file is still starting: a worker
 * that awaits at its top level is not yet listening, and the reading that
 * started it would be posted to nobody.
 */
let runtime: Promise<Runtime> | null = null;

function runtimeReady(): Promise<Runtime> {
  runtime ??= import('onnxruntime-web/wasm').then((ort) => {
    // Threads share memory, which the browser allows only on an isolated page
    // (the manifest's two cross-origin keys). Asked of the page rather than
    // assumed: on a page that is not, this is one thread, as it always was.
    ort.env.wasm.numThreads = readerThreads(self.crossOriginIsolated, self.navigator.hardwareConcurrency);
    ort.env.wasm.proxy = false;
    ort.env.logLevel = 'error';
    return ort;
  });
  return runtime;
}

export interface ReadRequest {
  id: number;
  image: ArrayBuffer;
  mime: string;
  /** The extension's `ocr/` folder, as `chrome.runtime.getURL('ocr/')` gives it. */
  base: string;
  /** The other scripts this page may be in; a recogniser is loaded for each one this build has. */
  scripts?: IndicScript[];
  /** `scan`: not read, but made a clean scan — upright, flattened if photographed on something, evenly lit. */
  kind?: 'scan';
}

/** A photo made a clean scan, as a JPEG. */
export interface ScanResult {
  image: ArrayBuffer;
  width: number;
  height: number;
  flattened: boolean;
  turns: QuarterTurns;
}

export type ReadResponse =
  | {
      id: number;
      ok: true;
      /**
       * The boxes and the size are the page's as it was read: upright, and
       * flattened when it was a photo of a page on something. `turns` is how it
       * was stood upright; `flattened`, when present, is that page as a JPEG —
       * the boxes are its, not the photo's.
       */
      result: {
        items: OcrItem[];
        width: number;
        height: number;
        turns: QuarterTurns;
        flattened?: ArrayBuffer;
        /** The tables on the page, cell by cell, when it has any. */
        tables?: ReadTable[];
        /** The round seals on the page, each read straightened, when it has any. */
        seals?: ReadSeal[];
      };
    }
  | { id: number; ok: true; scan: ScanResult }
  | { id: number; ok: false; error: string };

interface Loaded {
  session: Ort.InferenceSession;
  config: ModelConfig;
}

/**
 * Errors only, from every session and every run.
 *
 * The converted models carry a few dozen constants no node uses, and ONNX
 * Runtime announces each one as it drops it, on every load — written to the
 * console as errors, so Chrome listed them under the extension's Errors, a
 * screenful for a reader that worked. `env.logLevel` alone did not stop it:
 * each session and each run has a level of its own, and both default to
 * warnings (`onnxruntime-web` → `session-options.ts`, `run-options.ts`).
 * A real failure still throws, and the reading says so.
 */
const ERRORS_ONLY = 3;
const QUIET_RUN: Ort.InferenceSession.RunOptions = { logSeverityLevel: ERRORS_ONLY };

async function load(ort: Runtime, base: string, name: string): Promise<Loaded> {
  const [model, config] = await Promise.all([
    fetch(`${base}${name}.onnx`).then((r) => r.arrayBuffer()),
    fetch(`${base}${name}.json`).then((r) => r.json() as Promise<ModelConfig>),
  ]);
  const session = await ort.InferenceSession.create(new Uint8Array(model), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
    logSeverityLevel: ERRORS_ONLY,
  });
  return { session, config };
}

/**
 * The models, loaded once for as long as this worker lives.
 *
 * Loading is most of the cost of a first reading; a second document in the
 * same sitting should not pay it again. The worker lives no longer than the
 * offscreen page, which is closed when the last reading is done.
 */
let models: Promise<{
  ort: Runtime;
  detector: Loaded;
  recogniser: Loaded;
  orientation: Loaded;
  textline: Loaded;
}> | null = null;

function modelsReady(base: string) {
  models ??= runtimeReady().then(async (ort) => {
    const [detector, recogniser, orientation, textline] = await Promise.all([
      load(ort, base, DETECTOR),
      load(ort, base, RECOGNISER),
      load(ort, base, ORIENTATION),
      load(ort, base, TEXTLINE),
    ]);
    return { ort, detector, recogniser, orientation, textline };
  });
  // A failed load is not cached: the next reading tries again.
  models.catch(() => {
    models = null;
  });
  return models;
}

/** One recogniser, as the reading loop calls it. */
function recogniserFor(ort: Runtime, recogniser: Loaded): TensorRunner['recognise'] {
  return async (input, batch, width) => {
    const output = await recogniser.session.run(
      {
        [recogniser.session.inputNames[0]!]: new ort.Tensor('float32', input, [batch, 3, RECOGNITION_HEIGHT, width]),
      },
      QUIET_RUN,
    );
    const result = output[recogniser.session.outputNames[0]!]!;
    return { data: result.data as Float32Array, timeSteps: result.dims[1]!, classes: result.dims[2]! };
  };
}

function runnerFor(ort: Runtime, detector: Loaded, recogniser: Loaded): TensorRunner {
  return {
    async detect(input, width, height) {
      const output = await detector.session.run(
        { [detector.session.inputNames[0]!]: new ort.Tensor('float32', input, [1, 3, height, width]) },
        QUIET_RUN,
      );
      const map = output[detector.session.outputNames[0]!]!;
      const dims = map.dims;
      return {
        data: map.data as Float32Array,
        width: dims[dims.length - 1]!,
        height: dims[dims.length - 2]!,
      };
    },
    recognise: recogniserFor(ort, recogniser),
  };
}

/**
 * The other scripts' recognisers — only those the page was asked to be read in
 * — each loaded the first time a page has a box the English model could only
 * guess at, and kept for as long as this worker lives. A document in English
 * alone never loads them.
 */
const others = new Map<string, Promise<Alternate>>();

function othersReady(ort: Runtime, base: string, scripts: readonly IndicScript[]): Promise<Alternate[]> {
  const wanted = OTHER_SCRIPTS.filter(({ script }) => scripts.includes(script));
  return Promise.all(
    wanted.map(({ name, script }) => {
      let loading = others.get(name);
      if (loading === undefined) {
        loading = load(ort, base, name).then((loaded) => {
          const characters = loaded.config.characters;
          if (!characters) throw new Error(`The ${script} reader has no alphabet.`);
          return { script, characters, recognise: recogniserFor(ort, loaded) };
        });
        // A failed load is not kept: the next page tries again.
        loading.catch(() => others.delete(name));
        others.set(name, loading);
      }
      return loading;
    }),
  );
}

function textlineRunnerFor(ort: Runtime, textline: Loaded): TextlineRunner | undefined {
  const config = textline.config.textline;
  if (!config) return undefined;
  return {
    config,
    async classify(input, batch) {
      const output = await textline.session.run(
        { [textline.session.inputNames[0]!]: new ort.Tensor('float32', input, [batch, 3, config.height, config.width]) },
        QUIET_RUN,
      );
      return output[textline.session.outputNames[0]!]!.data as Float32Array;
    },
  };
}

/** UVDoc, loaded the first time a photo has a table around the page, and kept. */
let unwarp: Promise<Loaded> | null = null;

function unwarpRunnerFor(ort: Runtime, base: string): UnwarpRunner {
  return {
    async unwarp(input, width, height) {
      unwarp ??= load(ort, base, UNWARP);
      unwarp.catch(() => {
        unwarp = null;
      });
      const model = await unwarp;
      const output = await model.session.run(
        { [model.session.inputNames[0]!]: new ort.Tensor('float32', input, [1, 3, height, width]) },
        QUIET_RUN,
      );
      const flat = output[model.session.outputNames[0]!]!;
      const dims = flat.dims;
      return { data: flat.data as Float32Array, width: dims[dims.length - 1]!, height: dims[dims.length - 2]! };
    },
  };
}

/** SLANet_plus, loaded the first time a page has a table on it, and kept. */
let table: Promise<Loaded> | null = null;

function tableRunnerFor(ort: Runtime, base: string): TableRunner {
  return {
    async load() {
      table ??= load(ort, base, TABLE);
      table.catch(() => {
        table = null;
      });
      const model = await table;
      const config = model.config.table;
      if (!config) throw new Error('The table reader’s settings are missing.');
      return {
        config,
        async structure(input, size) {
          const output = await model.session.run(
            { [model.session.inputNames[0]!]: new ort.Tensor('float32', input, [1, 3, size, size]) },
            QUIET_RUN,
          );
          // Two outputs, told apart by their last dimension: a score for each
          // token, and a cell's corners.
          const outputs = model.session.outputNames.map((name) => output[name]!);
          const probs = outputs.find((o) => o.dims[o.dims.length - 1] === config.classes.length);
          const locs = outputs.find((o) => o.dims[o.dims.length - 1] === config.locCount);
          if (!probs || !locs) throw new Error('The table reader answered in an unexpected shape.');
          return { probs: probs.data as Float32Array, locs: locs.data as Float32Array, steps: probs.dims[1]! };
        },
      };
    },
  };
}

/** A page as a JPEG: for the pictures cut beside each value read off it, or as a clean scan. */
async function jpegOf(image: RgbaImage, quality = 0.9): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This worker cannot draw a page.');
  context.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return blob.arrayBuffer();
}

function orientationRunnerFor(ort: Runtime, orientation: Loaded): OrientationRunner {
  return {
    async orient(input, size) {
      const output = await orientation.session.run(
        { [orientation.session.inputNames[0]!]: new ort.Tensor('float32', input, [1, 3, size, size]) },
        QUIET_RUN,
      );
      return output[orientation.session.outputNames[0]!]!.data as Float32Array;
    },
  };
}

/**
 * An image as pixels, `scaleFor` times its size — enlarged by the browser's
 * own resampling, which is what reads a small photo's narrow characters apart
 * (`paddle-reader.ts` → `readingScale`).
 */
async function pixelsOf(
  image: ArrayBuffer,
  mime: string,
  scaleFor: (width: number, height: number) => number = () => 1,
): Promise<RgbaImage> {
  const bitmap = await createImageBitmap(new Blob([image], { type: mime }));
  try {
    const scale = scaleFor(bitmap.width, bitmap.height);
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This worker cannot draw an image to read.');
    // White under anything transparent: an unflattened PNG reads as black.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height);
    return { data: data.data, width: data.width, height: data.height };
  } finally {
    bitmap.close();
  }
}

async function read(request: ReadRequest) {
  const { ort, detector, recogniser, orientation, textline } = await modelsReady(request.base);
  // A small photo is read larger; the boxes come back in the larger page's
  // pixels, beside its size, so where each line sat is the same share of it.
  const pixels = await pixelsOf(request.image, request.mime, readingScale);

  const detection = detector.config.detection;
  const characters = recogniser.config.characters;
  const upright = orientation.config.orientation;
  if (!detection || !characters || !upright) throw new Error('The reader’s models are incomplete.');

  // Which way up first: the recogniser reads upright text and nothing else.
  const page = await uprightPage(pixels, orientationRunnerFor(ort, orientation), upright);
  // Then flat, when it is a photo of a page lying on something.
  const flat = await flattenPage(page.image, unwarpRunnerFor(ort, request.base));
  const lines = textlineRunnerFor(ort, textline);
  const runner = runnerFor(ort, detector, recogniser);
  const readImage = (image: RgbaImage) =>
    readPage(image, runner, {
      detection,
      characters,
      alternates: () => othersReady(ort, request.base, request.scripts ?? []),
      ...(lines === undefined ? {} : { textline: lines }),
    });
  // Round seals read again, straightened, by the same reader: an issuing
  // authority is often printed nowhere else.
  const sealed = await readSeals(flat.image, await readImage(flat.image), readImage);
  const items = sealed.items;
  // The tables, on the page as it was read: the boxes above are this page's.
  const tables = await readTables(flat.image, items, tableRunnerFor(ort, request.base));
  return {
    items,
    width: flat.image.width,
    height: flat.image.height,
    turns: page.turns,
    ...(flat.flattened ? { flattened: await jpegOf(flat.image) } : {}),
    ...(tables.length > 0 ? { tables } : {}),
    ...(sealed.seals.length > 0 ? { seals: sealed.seals } : {}),
  };
}

/**
 * A photo made a clean scan: stood upright, flattened when it is a page
 * photographed lying on something, its light evened out. Nothing is read.
 */
async function scan(request: ReadRequest): Promise<ScanResult> {
  const { ort, orientation } = await modelsReady(request.base);
  const pixels = await pixelsOf(request.image, request.mime);
  const upright = orientation.config.orientation;
  const page = upright
    ? await uprightPage(pixels, orientationRunnerFor(ort, orientation), upright)
    : { image: pixels, turns: 0 as QuarterTurns };
  const flat = await flattenPage(page.image, unwarpRunnerFor(ort, request.base));
  const clean = evenLighting(flat.image);
  return {
    image: await jpegOf(clean, 0.92),
    width: clean.width,
    height: clean.height,
    flattened: flat.flattened,
    turns: page.turns,
  };
}

self.onmessage = (event: MessageEvent<ReadRequest>) => {
  const request = event.data;
  if (request.kind === 'scan') {
    scan(request).then(
      (result) => self.postMessage({ id: request.id, ok: true, scan: result } satisfies ReadResponse, [result.image]),
      (error: unknown) =>
        self.postMessage({
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : 'The photo could not be made a scan.',
        } satisfies ReadResponse),
    );
    return;
  }
  read(request).then(
    (result) =>
      self.postMessage(
        { id: request.id, ok: true, result } satisfies ReadResponse,
        result.flattened === undefined ? [] : [result.flattened],
      ),
    (error: unknown) =>
      self.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : 'The document could not be read.',
      } satisfies ReadResponse),
  );
};
