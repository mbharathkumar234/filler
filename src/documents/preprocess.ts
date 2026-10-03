/**
 * How big a page is handed to the reader (§ reading a document).
 *
 * The reader (PaddleOCR on ONNX Runtime, in the offscreen page) takes a page as
 * it was photographed: its models were trained on photographs, and cleaning a
 * page up first — thresholding, flattening the lighting — costs them detail they
 * use. What does need deciding here is size.
 *
 * A twelve-megapixel photograph handed over whole took longer to read than the
 * service worker waiting for it stayed alive, so a page is scaled down to a size
 * that reads in a sitting. And a scan too small to read is said to be too small,
 * rather than read badly in silence.
 *
 * (The lighting-flattening pass that used to live here was for Tesseract, which
 * thresholds a page as a whole. PaddleOCR finds each word before reading it, and
 * the Phase 0 comparison fed it untouched images.)
 */

/**
 * The long edge a page is brought down to before it is read.
 *
 * The detector works at the page's own size and the recogniser crops each
 * word from the page as handed over, so more pixels than this still help, up
 * to the point where they only cost time.
 */
export const READ_LONG_EDGE = 2400;

/**
 * The most pixels worth handing to the reader in one go.
 *
 * A 2944 x 4224 photograph of a PAN card — 12.4 megapixels — went through
 * untouched, and reading it outlived the worker waiting for the answer. The
 * user saw "the message channel closed before a response was received".
 */
const MAX_READ_PIXELS = 6_000_000;

/**
 * Below this on the long edge, a full page's text is too small to read.
 *
 * Measured, for this reader: PaddleOCR read the user's own 1280-pixel caste and
 * income certificates almost word for word (Phase 0). Below a thousand pixels,
 * a full A4 page's body text is a handful of pixels tall, and nothing reads it
 * reliably.
 */
const TOO_SMALL_LONG_EDGE = 1000;

/**
 * How much to scale a page by before reading it.
 *
 * Both directions are answered here; the reader uses only the downward one
 * (`Math.min(1, …)`), because enlarging a small scan adds no detail the detector
 * can use.
 */
export function readingScale(width: number, height: number): number {
  const longEdge = Math.max(width, height);
  let scale = READ_LONG_EDGE / longEdge;

  // Already the right size: leave the pixels exactly as they are.
  if (Math.abs(scale - 1) < 0.02) scale = 1;

  const pixels = width * scale * (height * scale);
  if (pixels > MAX_READ_PIXELS) scale *= Math.sqrt(MAX_READ_PIXELS / pixels);

  return scale;
}

/**
 * Whether to tell the user the picture itself is the limit.
 *
 * Enlarging a tiny scan does not put back detail the camera never captured.
 * Saying so is more use than a list of values read off it wrongly.
 */
export function tooSmallToRead(width: number, height: number): string | null {
  if (Math.max(width, height) >= TOO_SMALL_LONG_EDGE) return null;
  return (
    `This scan is ${width} × ${height} pixels. Text that small cannot be read reliably — ` +
    'enlarging it does not put back detail the camera never captured. A photo about twice ' +
    'this size, in even light, reads far better.'
  );
}

/**
 * The most pages of a PDF that are read.
 *
 * An ID card is one page and a marks card two or three; a bank statement is
 * fifty, and reading fifty pages of recognition is minutes of a person waiting
 * for details that are on the first page anyway. Text layers and scanned
 * pages both stop here, and a PDF that goes on is said to.
 */
export const MAX_PDF_PAGES = 5;

/** Past this many threads, the reader's models gain little and the machine loses a lot. */
const MAX_READER_THREADS = 4;

/**
 * How many CPU threads the reader runs its models on.
 *
 * Threads share memory, and a browser lets a page share memory only when it is
 * isolated from other origins — so an unisolated page gets one, whatever the
 * machine has. An isolated one gets half the machine's cores, up to four: the
 * user is sitting at the browser this runs in, and a reader that takes every
 * core to finish a second sooner is a worse reader.
 */
export function readerThreads(isolated: boolean, cores: number | undefined): number {
  if (!isolated || cores === undefined || !Number.isFinite(cores)) return 1;
  return Math.max(1, Math.min(MAX_READER_THREADS, Math.floor(cores / 2)));
}
