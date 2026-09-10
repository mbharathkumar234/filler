/**
 * Finding the *content* inside an image, as opposed to the canvas around it.
 *
 * ## The bug that asked for this
 *
 * `intake.ts` judged a signature's shape from `meta.width / meta.height` — the
 * canvas — and told anybody outside its aspect window to "crop away the paper
 * above and below it". For a photograph that has already been cropped tight,
 * that advice is not merely unhelpful, it is *wrong*: there is no paper left to
 * remove, and the user is being blamed for the shape of their own signature.
 *
 * A canvas ratio cannot distinguish the two cases that matter:
 *
 *   - **Margin.** A wide signature adrift in a square photograph. Croppable,
 *     and worth saying so.
 *   - **Shape.** A signature with a tall flourish, trimmed to its own ink.
 *     Cropping cannot change this, and no advice to crop is honest.
 *
 * Only the ink's bounding box separates them, so that is what this measures.
 *
 * ## Pure, per `CLAUDE.md`
 *
 * This takes a luminance buffer and returns numbers. No canvas, no bitmap, no
 * browser — the caller (`raster.ts`) does the pixel reading. So every rule
 * below is testable against a hand-built image, which matters because the
 * failure mode of a threshold is a *silently* wrong answer.
 *
 * ## Why the background is measured, not assumed
 *
 * White paper photographed under a phone camera is not 255. It is 230 in the
 * shade and 245 in the light, with JPEG ringing on top. A fixed "white is
 * anything above 240" threshold reads such a photo as ink from edge to edge and
 * finds nothing to trim. So the page level is taken from the border pixels —
 * whatever is at the edge *is* the background, by definition of a margin — and
 * ink is measured relative to that.
 *
 * A dark-background image (a signature scanned white-on-black, or the framed
 * photo that reported this bug) inverts cleanly for free: the border is dark,
 * so "differs from the border" still finds the writing.
 */

export interface ContentBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LuminanceImage {
  width: number;
  height: number;
  /** One byte per pixel, row-major. 0 is black, 255 is white. */
  data: Uint8Array;
}

export interface TrimOptions {
  /**
   * How far a pixel must sit from the page level before it counts as ink.
   *
   * 24/255 is about 9%. Below roughly 16 the JPEG noise in a photograph of
   * paper starts registering as content and nothing trims; well above 40 and a
   * pencil signature disappears.
   */
  threshold?: number;
  /**
   * Fraction of a line that must be ink before the line counts as content.
   *
   * Without this, one dust speck or one compression artefact in the margin
   * anchors the bounding box to the edge of the canvas and the trim does
   * nothing. A thin pen stroke crossing a 300px row is well over 0.4%.
   */
  minInkFraction?: number;
  /**
   * Share of the *strongest* deviation a pixel must reach to count as ink.
   *
   * See `inkThreshold`. Raising it ignores more of the mid-greys; lowering it
   * approaches the old fixed-threshold behaviour.
   */
  contrastFraction?: number;
}

const DEFAULTS = {
  threshold: 24,
  minInkFraction: 0.004,
  contrastFraction: 0.45,
} as const;

/**
 * Share of pixels taken to *be* the ink when calibrating the threshold.
 *
 * Small enough that a signature occupying a corner of a full sheet still
 * defines the scale — 0.2% of a 1152x1536 photo is 3,500 pixels, and a
 * signature is always more ink than that — and large enough that a few dust
 * specks cannot.
 */
const INK_SHARE = 0.002;

/**
 * How different from the page a pixel must be to count as ink.
 *
 * ## Why a fixed number was not enough
 *
 * The first version of this used a flat 24/255, and it was wrong on the two
 * photographs that actually get uploaded:
 *
 *  - **Ruled or graph paper.** The printed grid is perhaps 30 levels below the
 *    page. A flat threshold calls every grid line ink, the bounding box becomes
 *    the whole sheet, and the measurement silently degrades into the canvas
 *    ratio it was written to replace.
 *  - **A shadow in the corner.** Same story: a soft grey blob anchors the box
 *    to (0, 0) and the signature is measured together with a shadow.
 *
 * Both are *mid-grey*. The pen is not — it is far darker than either. So the
 * threshold is calibrated against the darkest ink actually present rather than
 * against an absolute level: find the deviation reached by the strongest
 * `INK_SHARE` of pixels, and require a real fraction of it.
 *
 * ## Why this cannot make things worse
 *
 * The result is clamped *upward* from the old fixed floor, never below it. On a
 * faint pencil signature the calibrated value comes out under the floor and the
 * floor wins, which is exactly the previous behaviour. The adaptive part only
 * ever engages when there is something genuinely dark in the frame — which is
 * precisely when mid-greys should stop counting.
 */
function inkThreshold(image: LuminanceImage, page: number, options: TrimOptions): number {
  const floor = options.threshold ?? DEFAULTS.threshold;
  const fraction = options.contrastFraction ?? DEFAULTS.contrastFraction;
  const { data } = image;
  const count = image.width * image.height;

  const histogram = new Uint32Array(256);
  for (let i = 0; i < count; i++) histogram[Math.abs(data[i]! - page)]!++;

  const wanted = Math.max(1, Math.round(count * INK_SHARE));
  let seen = 0;
  let strongest = 0;
  for (let d = 255; d >= 0; d--) {
    seen += histogram[d]!;
    if (seen >= wanted) {
      strongest = d;
      break;
    }
  }

  return Math.max(floor, Math.round(strongest * fraction));
}

/**
 * The page level, taken as the median of the border pixels.
 *
 * Median rather than mean because a signature that runs off the edge of the
 * crop puts ink in the border sample, and a mean would drag the estimate
 * toward it — making the ink look less different from the page than it is,
 * which is the direction that loses strokes.
 */
export function estimateBackground(image: LuminanceImage): number {
  const { width, height, data } = image;
  if (width <= 0 || height <= 0) return 255;

  const border: number[] = [];
  for (let x = 0; x < width; x++) {
    border.push(data[x]!, data[(height - 1) * width + x]!);
  }
  for (let y = 0; y < height; y++) {
    border.push(data[y * width]!, data[y * width + width - 1]!);
  }

  border.sort((a, b) => a - b);
  return border[border.length >> 1]!;
}

/**
 * The smallest box containing everything that is not page.
 *
 * Returns `null` for a blank image — no content is a real answer, and it is
 * not the same as "the content is the whole canvas".
 */
export function findContentBox(
  image: LuminanceImage,
  options: TrimOptions = {},
): ContentBox | null {
  const { width, height, data } = image;
  if (width <= 0 || height <= 0 || data.length < width * height) return null;

  const minInkFraction = options.minInkFraction ?? DEFAULTS.minInkFraction;
  const page = estimateBackground(image);
  const threshold = inkThreshold(image, page, options);

  const rowInk = new Uint32Array(height);
  const colInk = new Uint32Array(width);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (Math.abs(data[row + x]! - page) > threshold) {
        rowInk[y]!++;
        colInk[x]!++;
      }
    }
  }

  /*
   * A line counts as content only if enough of it is ink.
   *
   * The absolute floor of 2 is what actually rejects dust and stray JPEG
   * artefacts, because on the image sizes people upload the fraction rounds
   * down to nothing: 0.4% of a 276px row is one pixel, and one pixel is
   * exactly what a speck is.
   *
   * The cost is stated rather than hidden: a stroke only one pixel wide is
   * invisible to this. Nothing photographed or scanned produces one — the
   * anti-aliasing alone spreads a pen line over two or three pixels — but a
   * synthetically drawn hairline would be missed, and the fallback for a
   * missed measurement is the canvas, which is where we started.
   */
  const rowFloor = Math.max(2, Math.floor(width * minInkFraction));
  const colFloor = Math.max(2, Math.floor(height * minInkFraction));

  const top = firstIndex(rowInk, rowFloor);
  if (top === -1) return null;
  const bottom = lastIndex(rowInk, rowFloor);
  const left = firstIndex(colInk, colFloor);
  if (left === -1) return null;
  const right = lastIndex(colInk, colFloor);

  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

function firstIndex(counts: Uint32Array, floor: number): number {
  for (let i = 0; i < counts.length; i++) if (counts[i]! >= floor) return i;
  return -1;
}

function lastIndex(counts: Uint32Array, floor: number): number {
  for (let i = counts.length - 1; i >= 0; i--) if (counts[i]! >= floor) return i;
  return -1;
}

export interface ShapeReading {
  /** The ink's bounding box within the canvas. */
  content: ContentBox;
  /** Width ÷ height of the ink alone — the honest shape of the signature. */
  contentAspect: number;
  /** Width ÷ height of the whole canvas, for comparison. */
  canvasAspect: number;
  /** Share of the canvas that is blank margin, 0–1. */
  marginRatio: number;
  /**
   * Whether cropping is worth doing or mentioning.
   *
   * A few pixels of border are not a finding; re-encoding to shave them costs
   * more quality than the margin costs compliance.
   */
  trimmable: boolean;
}

/** How much margin is worth acting on. Below this, leave the image alone. */
export const TRIMMABLE_MARGIN = 0.08;

/**
 * Measure an image's real shape.
 *
 * `null` when there is nothing to measure — a blank scan, or a buffer that does
 * not describe an image. Callers fall back to the canvas, which is what they
 * did before this module existed.
 */
export function readShape(image: LuminanceImage, options: TrimOptions = {}): ShapeReading | null {
  const content = findContentBox(image, options);
  if (content === null || content.width === 0 || content.height === 0) return null;

  const canvasArea = image.width * image.height;
  const marginRatio = canvasArea > 0 ? 1 - (content.width * content.height) / canvasArea : 0;

  return {
    content,
    contentAspect: content.width / content.height,
    canvasAspect: image.height > 0 ? image.width / image.height : 0,
    marginRatio,
    trimmable: marginRatio >= TRIMMABLE_MARGIN,
  };
}

/**
 * Rebuild a reading from a box that was measured earlier and stored.
 *
 * Only the box is persisted, because it is the only part that cannot be
 * recomputed — every other field here is arithmetic on it and the canvas. That
 * keeps the stored metadata small and, more usefully, keeps the thresholds
 * (`TRIMMABLE_MARGIN` and friends) changeable without migrating anybody's
 * vault: they are applied at read time, not baked in at write time.
 */
export function shapeFromBox(
  content: ContentBox,
  canvas: { width: number; height: number },
): ShapeReading | null {
  if (content.width <= 0 || content.height <= 0) return null;
  if (canvas.width <= 0 || canvas.height <= 0) return null;

  const marginRatio = 1 - (content.width * content.height) / (canvas.width * canvas.height);
  return {
    content,
    contentAspect: content.width / content.height,
    canvasAspect: canvas.width / canvas.height,
    marginRatio,
    trimmable: marginRatio >= TRIMMABLE_MARGIN,
  };
}

/**
 * Grow a content box by a margin, clamped to the canvas.
 *
 * Cropping to the exact ink looks wrong — a signature butted against all four
 * edges reads as damaged, and portals that print it into a box expect a little
 * air. The padding is a share of the *short* side so it stays proportional on
 * a wide strip.
 */
export function padContentBox(
  box: ContentBox,
  canvas: { width: number; height: number },
  fraction = 0.04,
): ContentBox {
  const pad = Math.round(Math.min(box.width, box.height) * fraction);
  const left = Math.max(0, box.left - pad);
  const top = Math.max(0, box.top - pad);
  const right = Math.min(canvas.width, box.left + box.width + pad);
  const bottom = Math.min(canvas.height, box.top + box.height + pad);
  return { left, top, width: right - left, height: bottom - top };
}
