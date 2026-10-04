/**
 * The worker's half of reading a document (§ reading a document).
 *
 * `OcrEngine` ([read-document.ts](../documents/read-document.ts)) is the seam
 * `readDocumentText` asks for. This is the engine: PaddleOCR's text detector and
 * English recogniser, running on ONNX Runtime in the offscreen reader
 * (`src/offscreen/ocr.ts`).
 *
 * Four jobs, in order:
 *
 *  1. **Prepare the page.** A PDF becomes a page of pixels; an image is sent as
 *     it was stored, because PaddleOCR's models were trained on photographs and
 *     every re-encode or clean-up costs them detail. Only a photograph too big
 *     to read in a sitting is scaled down — a twelve-megapixel PAN card once
 *     took longer than the service worker waiting for it stayed alive.
 *  2. **Read it,** one reading at a time, in the offscreen page — which stands
 *     a sideways photograph upright first, and says how far it turned it.
 *  3. **Put the boxes back into lines** (`layout.ts`), pairing each value with
 *     the label beside it, and dropping what the English model could only guess
 *     at in another alphabet.
 *  4. **Close.** The offscreen page is shut by the last reading out, so nothing
 *     of the user's document stays resident.
 *
 * The bytes never leave these two contexts, and nothing is fetched: the models
 * and the runtime are files in the package.
 */

import { createRasterBackend } from '@/documents/raster';
import type { RasterBackend } from '@/documents/derive';
import type { PdfLock } from '@/documents/pdf-lock';
import { readableWithBundled } from '@/documents/ocr';
import { MAX_PDF_PAGES, readingScale, tooSmallToRead } from '@/documents/preprocess';
import { layoutLines, SCRIPT_MISREAD_BELOW } from '@/documents/layout';
import { toFractions } from '@/documents/evidence-region';
import type { OcrEngine, PageImage, PdfText, TextLine } from '@/documents/read-document';
import type { IndicScript } from '@/documents/indic';
import type { ReadTable } from '@/documents/table';
import { base64ToBytes, bytesToBase64 } from '@/shared/base64';
import {
  envelope,
  type ExtensionRequest,
  type OcrItem,
  type PdfRequest,
  type ResponseMap,
} from '@/shared/messages';

const OFFSCREEN_PAGE = 'src/offscreen/ocr.html';

/**
 * How long one reading may take before it is called off.
 *
 * Generous, because a dense page on an old machine takes a while; finite,
 * because the alternative is what the user once saw — the worker collected, the
 * channel closed, and a browser error in place of an explanation.
 */
const READ_TIMEOUT_MS = 150_000;

/** Ping interval that keeps the service worker from being collected mid-read. */
const ALIVE_PING_MS = 20_000;

/** A PDF page is rasterised this wide: plenty for text, well inside the limits. */
const PDF_RENDER_WIDTH = 2000;

let creating: Promise<void> | null = null;

async function hasOffscreen(): Promise<boolean> {
  // `getContexts` is the supported way to ask; older builds threw instead.
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
    });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

async function openOffscreen(): Promise<void> {
  if (await hasOffscreen()) return;
  if (creating !== null) return creating;

  creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PAGE,
      reasons: ['WORKERS' as chrome.offscreen.Reason],
      justification:
        'Reading a document the user saved: recognising its text with models that run in a ' +
        'worker this page starts, and opening it with pdf.js when it is a PDF, which a service ' +
        'worker cannot load. Nothing is displayed and nothing is sent anywhere.',
    })
    .catch((error: unknown) => {
      // A race with another call can report "already exists"; that is the state
      // we wanted anyway.
      if (!(error instanceof Error) || !/already/i.test(error.message)) throw error;
    })
    .finally(() => {
      creating = null;
    });

  return creating;
}

async function closeOffscreen(): Promise<void> {
  try {
    if (await hasOffscreen()) await chrome.offscreen.closeDocument();
  } catch {
    // Already gone.
  }
}

/**
 * Keep this service worker alive for the length of a reading.
 *
 * MV3 collects a service worker after thirty seconds of idleness, and awaiting a
 * reply does not count as activity. A twelve-megapixel PAN card took longer than
 * that, the worker went, and the panel showed the browser's own words for it:
 * "A listener indicated an asynchronous response by returning true, but the
 * message channel closed before a response was received." Touching an extension
 * API resets the timer, so this touches the cheapest one available.
 */
function keepAlive(): () => void {
  const timer = setInterval(() => {
    void chrome.runtime.getPlatformInfo().catch(() => {});
  }, ALIVE_PING_MS);
  return () => clearInterval(timer);
}

/** What the offscreen reader hands back for one page. */
export interface PageReading {
  items: OcrItem[];
  /** The size of the page as it was read: upright, and flattened when it was a photo. */
  width: number;
  height: number;
  /** Quarter turns clockwise that stood the page upright. Absent or 0: it already was. */
  turns?: 0 | 1 | 2 | 3;
  /** The flattened page, base64 JPEG, when the photo was flattened before it was read. */
  flattened?: string;
  /** The tables on the page, cell by cell, when it has any. */
  tables?: ReadTable[];
  /** The round seals on the page, read straightened: where, and the words over the top and under the bottom. */
  seals?: Array<{ box: OcrItem['box']; text: string[] }>;
}

/**
 * The one reader, and who is using it (§ reading a document).
 *
 * There is a single offscreen document for the whole extension, and each read
 * used to close it on the way out. Two reads at once therefore killed each
 * other: the first to finish shut the page while the second was still
 * recognising, and the second's caller got the browser's words for a promise
 * nobody would keep — "the message channel closed before a response was
 * received".
 *
 * Two reads at once is not exotic. React's StrictMode runs an effect twice in
 * development, so pressing "Read details from this" once sends `doc:extract`
 * twice; and a user may simply press it on a second document. So reads are
 * serialised — one reading already uses the threads the machine can spare, and
 * two at once only make each other slower — and the page is closed by whichever read finds itself the
 * last one out.
 */
export interface Reader {
  open(): Promise<void>;
  close(): Promise<void>;
  /** `scripts`: the other scripts the page may be in, besides English. */
  recognise(image: Uint8Array, mime: string, scripts: readonly IndicScript[]): Promise<PageReading>;
  keepAlive(): () => void;
}

/** One job at a time on the offscreen page, which the last one out closes. */
export interface QueuedJobs {
  <T>(job: () => Promise<T>): Promise<T>;
  /**
   * Keep the page open for the whole of `work`, however many jobs it queues.
   *
   * A scanned PDF is rendered and read page by page, each step its own job.
   * Without this the page was closed after every one and opened again for the
   * next — the reader started afresh, models and all, twice a page.
   */
  during<T>(work: () => Promise<T>): Promise<T>;
}

export function serialiseReads(reader: Reader): QueuedJobs {
  let queue: Promise<void> = Promise.resolve();
  let inFlight = 0;

  const release = async () => {
    inFlight -= 1;
    // Last one out closes the page, so nothing of this document stays
    // resident — and nobody closes it under a reader still using it.
    if (inFlight === 0) await reader.close();
  };

  const read = async function read<T>(job: () => Promise<T>): Promise<T> {
    inFlight += 1;

    const mine = queue.then(async () => {
      await reader.open();
      const stopPinging = reader.keepAlive();
      try {
        return await job();
      } finally {
        stopPinging();
      }
    });
    // The queue must never reject, or every read after a failed one is skipped.
    queue = mine.then(
      () => undefined,
      () => undefined,
    );

    try {
      return await mine;
    } finally {
      await release();
    }
  };

  const during = async <T,>(work: () => Promise<T>): Promise<T> => {
    inFlight += 1;
    try {
      return await work();
    } finally {
      await release();
    }
  };

  return Object.assign(read, { during });
}

/** A prepared page, and anything about it the user deserves to be told. */
export interface RenderedPage {
  image: Uint8Array;
  mime: string;
  notes: string[];
  /** How many pages the document has. Absent: one, as a picture is. */
  pages?: number;
}

/**
 * One page of the document, as the reader should see it.
 *
 * An image goes as it was stored. PaddleOCR's models were trained on
 * photographs, not on cleaned-up scans, and each re-encode or "improvement"
 * costs them detail they use. Only a photograph too big to read in a sitting
 * is scaled down, and only then re-encoded. A PDF — whose text layer was tried
 * first and found wanting, or this would not be running — is rasterised.
 */
async function renderForReading(
  bytes: Uint8Array,
  mime: string,
  password?: string,
  page = 1,
): Promise<RenderedPage> {
  const backend = createRasterBackend();
  const notes: string[] = [];

  if (mime === 'application/pdf') {
    // Rendered by the offscreen page — this worker cannot load pdf.js — and
    // opened with the password the vault keeps for a locked PDF.
    const rendered = await offscreenPdf.render(bytes, PDF_RENDER_WIDTH, password, page);
    return { image: rendered.image, mime: 'image/png', notes, pages: rendered.pages };
  }

  const source = await backend.decode(bytes, mime);
  const small = tooSmallToRead(source.width, source.height);
  if (small !== null) notes.push(small);

  // Down only: enlarging a small scan adds no detail the detector can use.
  const scale = Math.min(1, readingScale(source.width, source.height));
  if (scale === 1) {
    backend.release?.(source);
    return { image: bytes, mime, notes };
  }

  const sized = await backend.resize(source, {
    width: Math.round(source.width * scale),
    height: Math.round(source.height * scale),
    fit: 'contain',
    scale,
    // Not a portal's requirement: a size chosen to be readable in a sitting.
    exact: false,
  });
  const jpeg = await backend.encodeJpeg(sized, 0.95);
  backend.release?.(sized);
  backend.release?.(source);
  return { image: jpeg, mime: 'image/jpeg', notes };
}

/**
 * A stored photo made a clean scan, in the offscreen page's one queue: stood
 * upright, flattened when it was photographed on something, evenly lit.
 */
export function offscreenScan(image: Uint8Array, mime: string): Promise<ResponseMap['ocr:scan']> {
  return offscreenJobs(() => askOffscreen({ type: 'ocr:scan', image: bytesToBase64(image), mime }));
}

/** Ask the offscreen page to read a page, with an end to the waiting. */
async function recogniseIn(image: Uint8Array, mime: string, scripts: readonly IndicScript[]): Promise<PageReading> {
  return askOffscreen({
    type: 'ocr:recognise',
    image: bytesToBase64(image),
    mime,
    ...(scripts.length === 0 ? {} : { scripts: [...scripts] }),
  });
}

/**
 * Ask the offscreen page for something, with an end to the waiting.
 *
 * The page answers `ocr:recognise` and the `pdf:*` requests; the worker leaves
 * them to it (`OFFSCREEN_TYPES`). Called inside a job of `offscreenJobs`, which
 * is what makes sure the page is open, and stays open, while it answers.
 */
async function askOffscreen<T extends 'ocr:recognise' | 'ocr:scan' | PdfRequest['type']>(
  request: Extract<ExtensionRequest, { type: T }>,
): Promise<ResponseMap[T]> {
  const ask = chrome.runtime.sendMessage(envelope(request)) as Promise<
    { ok: true; data: ResponseMap[T] } | { ok: false; error: string } | undefined
  >;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const response = await Promise.race([
    ask,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              'Reading this document took too long and was stopped. A smaller or sharper ' +
                'image usually reads in a few seconds.',
            ),
          ),
        READ_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));

  if (response?.ok !== true) {
    throw new Error(response?.error ?? 'The document could not be read.');
  }
  return response.data;
}

/** The offscreen page, as the extension actually talks to it. */
const offscreenReader: Reader = {
  open: openOffscreen,
  close: closeOffscreen,
  recognise: recogniseIn,
  keepAlive,
};

/**
 * Every job the offscreen page does, one at a time, in one queue.
 *
 * Reading a page and opening a PDF both need the page open, and whichever
 * finishes last closes it. Two queues would each think themselves last and
 * close it under the other — the very failure `serialiseReads` was written
 * against — so there is exactly one.
 */
export const offscreenJobs = serialiseReads(offscreenReader);

// ---------------------------------------------------------------------------
// PDFs, opened in the same page
// ---------------------------------------------------------------------------

/**
 * pdf.js, as this worker reaches it: through the offscreen page.
 *
 * A service worker cannot load pdf.js — `import()` is disallowed there by the
 * HTML specification — so every PDF this worker handles is opened by the page,
 * which can. Until this existed no PDF opened at all: the text layer of an
 * e-Aadhaar was never read, and no PDF could be made into a portal's copy.
 */
export interface PdfEngine {
  lock(bytes: Uint8Array, password?: string): Promise<PdfLock>;
  /** The text layer, as lines, and the tables laid out from where it sits. */
  text(bytes: Uint8Array, password?: string): Promise<PdfText>;
  /** Page `page` (from 1; the first by default) as a PNG `width` pixels wide, and how many pages there are. */
  render(
    bytes: Uint8Array,
    width: number,
    password?: string,
    page?: number,
  ): Promise<{ image: Uint8Array; pages: number }>;
}

type Jobs = <T>(job: () => Promise<T>) => Promise<T>;
type AskPdf = <T extends PdfRequest['type']>(
  request: Extract<PdfRequest, { type: T }>,
) => Promise<ResponseMap[T]>;

export function createPdfEngine(ask: AskPdf, jobs: Jobs): PdfEngine {
  const opening = (bytes: Uint8Array, password?: string) => ({
    pdf: bytesToBase64(bytes),
    ...(password === undefined ? {} : { password }),
  });
  return {
    async lock(bytes, password) {
      const { lock } = await jobs(() => ask({ type: 'pdf:lock', ...opening(bytes, password) }));
      return lock;
    },
    async text(bytes, password) {
      const { text, tables } = await jobs(() => ask({ type: 'pdf:text', ...opening(bytes, password) }));
      return tables === undefined ? { text } : { text, tables };
    },
    async render(bytes, width, password, page) {
      const { image, pages } = await jobs(() =>
        ask({ type: 'pdf:render', width, ...(page === undefined ? {} : { page }), ...opening(bytes, password) }),
      );
      return { image: base64ToBytes(image), pages };
    },
  };
}

/** The engine this worker uses. */
export const offscreenPdf: PdfEngine = createPdfEngine((request) => askOffscreen(request), offscreenJobs);

/**
 * A raster backend for this worker: a PDF's page is rendered by the offscreen
 * page and handed back as a picture; everything else is done here.
 */
export function workerRasterBackend(): RasterBackend {
  return createRasterBackend({
    renderPdf: (bytes, width, password, page) => offscreenPdf.render(bytes, width, password, page),
  });
}

/**
 * The engine `document-service.ts` installs through `setOcrEngine`.
 *
 * The reader and the renderer are injectable so that the parts with a history
 * of going wrong — who opens the page, who closes it, what happens when two
 * reads overlap — can be tested without a browser.
 */
export function createOcrHost(
  reader: Reader = offscreenReader,
  render: (
    bytes: Uint8Array,
    mime: string,
    password?: string,
    page?: number,
  ) => Promise<RenderedPage> = renderForReading,
): OcrEngine {
  // The real page shares its one queue with the PDF engine; a test's reader
  // gets a queue of its own.
  const read = reader === offscreenReader ? offscreenJobs : serialiseReads(reader);

  return {
    availableScripts: async (): Promise<IndicScript[]> => readableWithBundled(),

    async recognise(bytes, mime, scripts, password) {
      // The English model reads every box first; without it there is no reading.
      if (!scripts.includes('Latin')) return { text: '' };
      // The others, asked only about a box the English model could only guess at.
      const others = scripts.filter((script) => script !== 'Latin');

      // The reader stays open from the first page to the last; each page is
      // rendered, then read, in turn.
      return read.during(async () => {
        const first = await render(bytes, mime, password, 1);
        const total = first.pages ?? 1;
        const count = Math.min(total, MAX_PDF_PAGES);

        const lines: TextLine[] = [];
        const scores: number[] = [];
        const notes = [...first.notes];
        const pageImages: PageImage[] = [];
        const tables: ReadTable[] = [];

        for (let pageNumber = 1; pageNumber <= count; pageNumber += 1) {
          const page = pageNumber === 1 ? first : await render(bytes, mime, password, pageNumber);
          if (pageNumber > 1) notes.push(...page.notes);
          const reading = await read(() => reader.recognise(page.image, page.mime, others));

          for (const item of reading.items) {
            if (item.score >= SCRIPT_MISREAD_BELOW) scores.push(item.score);
          }
          tables.push(...(reading.tables ?? []));

          // Lines, each with where it sat — as a share of its page, since the
          // page the reader saw may not be the size the document was stored
          // at — on which page, and turned how far to be read. A flattened
          // photo's lines sit on the flattened page, which is upright: no turns,
          // and that page goes back with them.
          const turns = reading.turns ?? 0;
          if (reading.flattened !== undefined) {
            pageImages.push({ page: pageNumber, image: base64ToBytes(reading.flattened), mime: 'image/jpeg' });
            notes.push(flattenedNote(count > 1 ? pageNumber : null));
          }
          const turnsOnLines = reading.flattened === undefined ? turns : 0;
          // Each seal a line of its own, after the page's, where the seal is:
          // "Seal: TAHSILDAR, SAMPLEPURA TALUK", and its picture is the seal.
          const sealLines = (reading.seals ?? []).map((seal) => ({ text: `Seal: ${seal.text.join(', ')}`, box: seal.box }));
          for (const line of [...layoutLines(reading.items), ...sealLines]) {
            lines.push({
              text: line.text,
              box: toFractions(line.box, reading),
              ...(pageNumber > 1 ? { page: pageNumber } : {}),
              ...(turnsOnLines === 0 ? {} : { turns: turnsOnLines }),
            });
          }
          if (turns !== 0) notes.push(turnedNote(turns, count > 1 ? pageNumber : null));
        }

        if (total > count) {
          notes.push(`This PDF has ${total} pages. The first ${count} were read; the rest were not.`);
        }

        const confidence =
          scores.length === 0 ? undefined : scores.reduce((sum, score) => sum + score, 0) / scores.length;

        return {
          text: lines.map((line) => line.text).join('\n'),
          lines,
          ...(confidence === undefined ? {} : { confidence }),
          ...(notes.length > 0 ? { notes } : {}),
          ...(pageImages.length > 0 ? { pageImages } : {}),
          ...(tables.length > 0 ? { tables } : {}),
        };
      });
    },
  };
}

/** What the user is told about a photo flattened before it was read. */
function flattenedNote(page: number | null): string {
  const what = page === null ? 'The photo' : `Page ${page}`;
  return `${what} was flattened before it was read: the page was curled, or photographed at an angle, on something.`;
}

/** What the user is told about a page that was turned upright to be read. */
function turnedNote(turns: 1 | 2 | 3, page: number | null): string {
  const how = turns === 2 ? 'upside down' : 'sideways';
  return page === null
    ? `This picture was ${how}, so it was turned upright before it was read.`
    : `Page ${page} was ${how}, so it was turned upright before it was read.`;
}
