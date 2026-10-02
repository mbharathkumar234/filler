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
  readPage,
  uprightPage,
  type OrientationRunner,
  type TensorRunner,
} from '@/documents/paddle-reader';
import type { ModelConfig, QuarterTurns, RgbaImage } from '@/documents/paddle';
import { readerThreads } from '@/documents/preprocess';
import type { OcrItem } from '@/shared/messages';

declare const self: DedicatedWorkerGlobalScope;

/** The three models `ocrAssets()` unpacks into `dist/ocr/`. */
const DETECTOR = 'PP-OCRv5_mobile_det';
const RECOGNISER = 'en_PP-OCRv5_mobile_rec';
const ORIENTATION = 'PP-LCNet_x1_0_doc_ori';
const RECOGNITION_HEIGHT = 48;

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
    // The converted models carry a few unused weights and ONNX Runtime says so
    // on every load. Errors still surface; the notes do not.
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
}

export type ReadResponse =
  | {
      id: number;
      ok: true;
      /** The boxes and the size are the **upright** page's; `turns` is how it got there. */
      result: { items: OcrItem[]; width: number; height: number; turns: QuarterTurns };
    }
  | { id: number; ok: false; error: string };

interface Loaded {
  session: Ort.InferenceSession;
  config: ModelConfig;
}

async function load(ort: Runtime, base: string, name: string): Promise<Loaded> {
  const [model, config] = await Promise.all([
    fetch(`${base}${name}.onnx`).then((r) => r.arrayBuffer()),
    fetch(`${base}${name}.json`).then((r) => r.json() as Promise<ModelConfig>),
  ]);
  const session = await ort.InferenceSession.create(new Uint8Array(model), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
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
}> | null = null;

function modelsReady(base: string) {
  models ??= runtimeReady().then(async (ort) => {
    const [detector, recogniser, orientation] = await Promise.all([
      load(ort, base, DETECTOR),
      load(ort, base, RECOGNISER),
      load(ort, base, ORIENTATION),
    ]);
    return { ort, detector, recogniser, orientation };
  });
  // A failed load is not cached: the next reading tries again.
  models.catch(() => {
    models = null;
  });
  return models;
}

function runnerFor(ort: Runtime, detector: Loaded, recogniser: Loaded): TensorRunner {
  return {
    async detect(input, width, height) {
      const output = await detector.session.run({
        [detector.session.inputNames[0]!]: new ort.Tensor('float32', input, [1, 3, height, width]),
      });
      const map = output[detector.session.outputNames[0]!]!;
      const dims = map.dims;
      return {
        data: map.data as Float32Array,
        width: dims[dims.length - 1]!,
        height: dims[dims.length - 2]!,
      };
    },
    async recognise(input, batch, width) {
      const output = await recogniser.session.run({
        [recogniser.session.inputNames[0]!]: new ort.Tensor('float32', input, [
          batch,
          3,
          RECOGNITION_HEIGHT,
          width,
        ]),
      });
      const result = output[recogniser.session.outputNames[0]!]!;
      return { data: result.data as Float32Array, timeSteps: result.dims[1]!, classes: result.dims[2]! };
    },
  };
}

function orientationRunnerFor(ort: Runtime, orientation: Loaded): OrientationRunner {
  return {
    async orient(input, size) {
      const output = await orientation.session.run({
        [orientation.session.inputNames[0]!]: new ort.Tensor('float32', input, [1, 3, size, size]),
      });
      return output[orientation.session.outputNames[0]!]!.data as Float32Array;
    },
  };
}

async function pixelsOf(image: ArrayBuffer, mime: string): Promise<RgbaImage> {
  const bitmap = await createImageBitmap(new Blob([image], { type: mime }));
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This worker cannot draw an image to read.');
    // White under anything transparent: an unflattened PNG reads as black.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, bitmap.width, bitmap.height);
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { data: data.data, width: data.width, height: data.height };
  } finally {
    bitmap.close();
  }
}

async function read(request: ReadRequest) {
  const { ort, detector, recogniser, orientation } = await modelsReady(request.base);
  const pixels = await pixelsOf(request.image, request.mime);

  const detection = detector.config.detection;
  const characters = recogniser.config.characters;
  const upright = orientation.config.orientation;
  if (!detection || !characters || !upright) throw new Error('The reader’s models are incomplete.');

  // Which way up first: the recogniser reads upright text and nothing else.
  const page = await uprightPage(pixels, orientationRunnerFor(ort, orientation), upright);
  const items = await readPage(page.image, runnerFor(ort, detector, recogniser), {
    detection,
    characters,
  });
  return { items, width: page.image.width, height: page.image.height, turns: page.turns };
}

self.onmessage = (event: MessageEvent<ReadRequest>) => {
  const request = event.data;
  read(request).then(
    (result) => self.postMessage({ id: request.id, ok: true, result } satisfies ReadResponse),
    (error: unknown) =>
      self.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : 'The document could not be read.',
      } satisfies ReadResponse),
  );
};
