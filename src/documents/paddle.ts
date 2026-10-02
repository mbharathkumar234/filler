/**
 * PaddleOCR's reading pipeline, without OpenCV (§ reading a document).
 *
 * ## Why this is a port and not the SDK
 *
 * PaddleOCR publishes a browser SDK, and it cannot run in an extension page:
 * it drives its models through OpenCV.js, and OpenCV.js builds functions with
 * `new Function`, which the extension's content security policy forbids. The
 * models themselves need only ONNX Runtime, which needs nothing of the kind.
 *
 * So PaddleOCR's models run on ONNX Runtime directly, and the steps around them
 * are ported here from PaddleOCR's own code (`paddleocr-js/packages/core/src/
 * models/{det,rec,common}.ts` and `pipelines/ocr/`, Apache-2.0), with the same
 * constants:
 *
 *  1. detect at the page's own resolution, both sides a multiple of 32 — the
 *     OCR pipeline's setting, not the detector file's "long side 960";
 *  2. normalise it as the detector was trained — BGR, ImageNet mean and std;
 *  3. find the text boxes in the detector's probability map — threshold 0.3,
 *     fit a **rotated** rectangle to each region (OpenCV's `minAreaRect`, here
 *     a convex hull and rotating calipers), keep it if the mean probability
 *     inside that rectangle is at least 0.6, and grow it by area x 1.5 /
 *     perimeter, because the map is drawn deliberately tight;
 *  4. warp each rotated box upright (`get_rotate_crop_image`), scale it to 48
 *     pixels tall, pad it to at least 320 wide;
 *  5. read the recogniser's output with CTC: class 0 is blank, repeats
 *     collapse, class i is character i - 1 of the model's own list.
 *
 * Step 3's rotated rectangle is not a nicety. An earlier cut of this port used
 * the upright one, and on the user's own photographed Form-D certificate every
 * long line of the paragraph vanished: an upright box around a slanted line is
 * mostly background, its mean fell below 0.6, and it was discarded.
 *
 * Pure throughout: arrays in, arrays out, no canvas and no engine. That is what
 * lets the arithmetic be tested against PaddleOCR's own numbers without a
 * browser, which is how `CLAUDE.md` asks for this directory to work.
 */

/** RGBA pixels, as a canvas hands them over. */
export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** An upright box on the page, in the page's own pixels. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type Point = readonly [number, number];

/** A rotated rectangle's corners: top-left, top-right, bottom-right, bottom-left. */
export type Quad = readonly [Point, Point, Point, Point];

/** A box, with its rotated corners when it has them. The upright box is their bounds. */
export interface Region extends Box {
  quad?: Quad;
}

export interface ScoredBox extends Box {
  /** The rotated rectangle the text sits in, in page pixels. */
  quad: Quad;
  /** The detector's mean probability inside that rectangle. */
  score: number;
}

export interface DetectionParams {
  limitSideLen: number;
  thresh: number;
  boxThresh: number;
  maxCandidates: number;
  unclipRatio: number;
}

/** How the page-orientation classifier wants its picture, from its own settings file. */
export interface OrientationConfig {
  /** The page's short side is brought to this … */
  resizeShort: number;
  /** … and the middle square of this size is what the classifier sees. */
  cropSize: number;
  mean: number[];
  std: number[];
  scale: number;
  /** What each class means, in class order: degrees the page has been turned. */
  labels: number[];
}

export interface ModelConfig {
  modelName: string;
  /** The recogniser's alphabet, in class order, with PaddleOCR's trailing space. */
  characters?: string[];
  detection?: DetectionParams;
  orientation?: OrientationConfig;
}

/** Quarter turns clockwise. */
export type QuarterTurns = 0 | 1 | 2 | 3;

/** PaddleOCR's own fallbacks, for a settings file that leaves one out. */
const DETECTION_DEFAULTS: DetectionParams = {
  limitSideLen: 960,
  thresh: 0.3,
  boxThresh: 0.6,
  maxCandidates: 1000,
  unclipRatio: 2.0,
};

/** Neither side of the detector's input may exceed this. */
export const MAX_SIDE_LIMIT = 4000;

export interface DetectionScaling {
  limitSideLen: number;
  /** `max`: bring the long side down to the limit. `min`: bring the short side up to it. */
  limitType: 'min' | 'max';
  maxSideLimit: number;
}

/**
 * How PaddleOCR's OCR pipeline scales a page for detection.
 *
 * Not the detector's own settings file, which says "long side 960": the
 * pipeline (`paddleocr-js/.../pipelines/ocr/default-config.ts`) overrides it
 * with a short side of at least 64 and a long side of at most 4000 — in effect,
 * detection at the page's own resolution. Measured on the user's documents,
 * following the file instead cost both accuracy (small print went unread) and
 * speed (neighbouring words merged into long lines, and a long line costs the
 * recogniser more than its share).
 */
export const PIPELINE_DETECTION: DetectionScaling = {
  limitSideLen: 64,
  limitType: 'min',
  maxSideLimit: MAX_SIDE_LIMIT,
};

/** How the detector was trained: ImageNet's mean and deviation, BGR order. */
const DETECTION_NORMALISE = {
  mean: [0.485, 0.456, 0.406] as const,
  std: [0.229, 0.224, 0.225] as const,
  scale: 1 / 255,
};

/** How the recogniser was trained: every channel to minus one .. one. */
const RECOGNITION_NORMALISE = {
  mean: [0.5, 0.5, 0.5] as const,
  std: [0.5, 0.5, 0.5] as const,
  scale: 1 / 255,
};

/** PaddleOCR's minimum box side, before and after growing it. */
const MIN_BOX_SIDE = 3;

/** The recogniser's training width at 48 pixels tall: 320, a ratio of 20 : 3. */
const RECOGNITION_BASE_WIDTH = 320;
const RECOGNITION_MAX_WIDTH = 3200;

// ---------------------------------------------------------------------------
// Scaling
// ---------------------------------------------------------------------------

const round32 = (n: number) => Math.max(32, Math.round(n / 32) * 32);

/**
 * The size the detector sees the page at.
 *
 * PaddleOCR's two `limit_type`s: `max` brings the long side down to
 * `limitSideLen`, `min` brings the short side up to it. Either way both sides
 * then round to a multiple of 32, which the network's downsampling needs, and
 * neither exceeds `maxSideLimit`.
 */
export function detectionSize(
  width: number,
  height: number,
  limits: { limitSideLen: number; limitType?: 'min' | 'max'; maxSideLimit: number },
): { width: number; height: number } {
  const limitSideLen = Math.max(32, limits.limitSideLen);
  const maxSideLimit = Math.max(32, limits.maxSideLimit);

  let scale = 1;
  if ((limits.limitType ?? 'max') === 'max') {
    const longest = Math.max(width, height);
    if (longest > limitSideLen) scale = limitSideLen / Math.max(1, longest);
  } else {
    const shortest = Math.min(width, height);
    if (shortest < limitSideLen) scale = limitSideLen / Math.max(1, shortest);
  }

  let dstW = round32(width * scale);
  let dstH = round32(height * scale);

  if (Math.max(dstW, dstH) > maxSideLimit) {
    const limitScale = maxSideLimit / Math.max(dstW, dstH);
    dstW = Math.max(32, Math.floor(dstW * limitScale));
    dstH = Math.max(32, Math.floor(dstH * limitScale));
  }

  return {
    width: round32(Math.min(Math.max(dstW, 32), maxSideLimit)),
    height: round32(Math.min(Math.max(dstH, 32), maxSideLimit)),
  };
}

/**
 * Bilinear resampling, as `cv2.resize(..., INTER_LINEAR)` does it.
 *
 * Not the canvas's own scaler: PaddleOCR's models were trained on pages scaled
 * this way, and matching the training is worth more than a prettier resample.
 */
export function resizeBilinear(image: RgbaImage, width: number, height: number): RgbaImage {
  const out = new Uint8ClampedArray(width * height * 4);
  const { data, width: sw, height: sh } = image;
  const xRatio = sw / width;
  const yRatio = sh / height;

  for (let y = 0; y < height; y += 1) {
    // Pixel-centre alignment, which is OpenCV's convention.
    const fy = Math.min(Math.max((y + 0.5) * yRatio - 0.5, 0), sh - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, sh - 1);
    const wy = fy - y0;

    for (let x = 0; x < width; x += 1) {
      const fx = Math.min(Math.max((x + 0.5) * xRatio - 0.5, 0), sw - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, sw - 1);
      const wx = fx - x0;

      const a = (y0 * sw + x0) * 4;
      const b = (y0 * sw + x1) * 4;
      const c = (y1 * sw + x0) * 4;
      const d = (y1 * sw + x1) * 4;
      const o = (y * width + x) * 4;

      for (let ch = 0; ch < 4; ch += 1) {
        const top = data[a + ch]! * (1 - wx) + data[b + ch]! * wx;
        const bottom = data[c + ch]! * (1 - wx) + data[d + ch]! * wx;
        out[o + ch] = top * (1 - wy) + bottom * wy;
      }
    }
  }

  return { data: out, width, height };
}

// ---------------------------------------------------------------------------
// Which way up the page is
// ---------------------------------------------------------------------------

/**
 * The page, turned clockwise by quarter turns.
 *
 * Whole pixels moved and none resampled, so a page turned upright is exactly
 * as sharp as it was sideways.
 */
export function rotateQuarter(image: RgbaImage, turns: QuarterTurns): RgbaImage {
  if (turns === 0) return image;

  const { width: sw, height: sh } = image;
  // A pixel is moved as one 32-bit word, which needs the bytes to start on one.
  const bytes = image.data.byteOffset % 4 === 0 ? image.data : image.data.slice();
  const source = new Uint32Array(bytes.buffer, bytes.byteOffset, sw * sh);
  const width = turns === 2 ? sw : sh;
  const height = turns === 2 ? sh : sw;
  const data = new Uint8ClampedArray(width * height * 4);
  const out = new Uint32Array(data.buffer);

  for (let y = 0; y < sh; y += 1) {
    for (let x = 0; x < sw; x += 1) {
      // Where (x, y) lands. Clockwise, the left column becomes the top row.
      const to =
        turns === 1
          ? x * width + (sh - 1 - y)
          : turns === 2
            ? (sh - 1 - y) * width + (sw - 1 - x)
            : (sw - 1 - x) * width + y;
      out[to] = source[y * sw + x]!;
    }
  }
  return { data, width, height };
}

/**
 * The page as the orientation classifier's input: the middle square, planar,
 * normalised — and **red first**.
 *
 * Not the detector's order. PaddleOCR's text models were trained on OpenCV's
 * BGR pictures, its classifiers on RGB ones, and each loses accuracy quietly
 * when handed the other.
 */
export function normaliseForOrientation(image: RgbaImage, config: OrientationConfig): Float32Array {
  const ratio = config.resizeShort / Math.min(image.width, image.height);
  const resized = resizeBilinear(
    image,
    Math.max(config.cropSize, Math.round(image.width * ratio)),
    Math.max(config.cropSize, Math.round(image.height * ratio)),
  );

  const size = config.cropSize;
  const left = Math.floor((resized.width - size) / 2);
  const top = Math.floor((resized.height - size) / 2);
  const plane = size * size;
  const out = new Float32Array(3 * plane);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const from = ((top + y) * resized.width + left + x) * 4;
      const to = y * size + x;
      for (let channel = 0; channel < 3; channel += 1) {
        out[to + channel * plane] =
          (resized.data[from + channel]! * config.scale - config.mean[channel]!) / config.std[channel]!;
      }
    }
  }
  return out;
}

/**
 * How far to turn the page to stand it upright, from the classifier's scores.
 *
 * The classifier's label is how far the page **has been** turned clockwise, so
 * it is turned back by the rest of the circle.
 */
export function turnsFrom(
  scores: ArrayLike<number>,
  labels: readonly number[],
): { turns: QuarterTurns; confidence: number } {
  let best = 0;
  for (let i = 1; i < labels.length; i += 1) if (scores[i]! > scores[best]!) best = i;
  const turned = Math.round((labels[best] ?? 0) / 90) % 4;
  return { turns: ((4 - turned) % 4) as QuarterTurns, confidence: scores[best] ?? 0 };
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * The page as the detector's input tensor: planar, BGR, normalised.
 *
 * Channel 0 is **blue**. The models were trained on OpenCV images, which are
 * BGR, and a port that feeds RGB loses accuracy quietly rather than failing.
 */
export function normaliseForDetection(
  image: RgbaImage,
  norm: { mean: readonly number[]; std: readonly number[]; scale: number } = DETECTION_NORMALISE,
): Float32Array {
  const { data, width, height } = image;
  const plane = width * height;
  const out = new Float32Array(3 * plane);
  for (let i = 0, p = 0; i < plane; i += 1, p += 4) {
    out[i] = (data[p + 2]! * norm.scale - norm.mean[0]!) / norm.std[0]!;
    out[i + plane] = (data[p + 1]! * norm.scale - norm.mean[1]!) / norm.std[1]!;
    out[i + 2 * plane] = (data[p]! * norm.scale - norm.mean[2]!) / norm.std[2]!;
  }
  return out;
}

/** A rotated rectangle: two unit axes and the extent of the region along each. */
interface Rotated {
  ux: number;
  uy: number;
  minA: number;
  maxA: number;
  minB: number;
  maxB: number;
}

/** Andrew's monotone chain: the convex hull, counter-clockwise, no repeats. */
function convexHull(points: Point[]): Point[] {
  const sorted = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  if (sorted.length < 3) return sorted;
  const cross = (o: Point, a: Point, b: Point) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: Point[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const p = sorted[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/**
 * The smallest rectangle around a set of points, at any angle — OpenCV's
 * `minAreaRect`, by rotating calipers: the best rectangle has one side along
 * an edge of the convex hull, so each edge is tried and the smallest kept.
 */
function minAreaRect(points: Point[]): Rotated {
  const hull = convexHull(points);
  let best: Rotated | null = null;
  let bestArea = Infinity;

  const edges = hull.length < 2 ? 1 : hull.length;
  for (let i = 0; i < edges; i += 1) {
    let ux = 1;
    let uy = 0;
    if (hull.length >= 2) {
      const a = hull[i]!;
      const b = hull[(i + 1) % hull.length]!;
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length === 0) continue;
      ux = (b[0] - a[0]) / length;
      uy = (b[1] - a[1]) / length;
    }
    let minA = Infinity;
    let maxA = -Infinity;
    let minB = Infinity;
    let maxB = -Infinity;
    for (const [x, y] of hull) {
      const along = x * ux + y * uy;
      const across = -x * uy + y * ux;
      if (along < minA) minA = along;
      if (along > maxA) maxA = along;
      if (across < minB) minB = across;
      if (across > maxB) maxB = across;
    }
    const area = (maxA - minA) * (maxB - minB);
    if (area < bestArea) {
      bestArea = area;
      best = { ux, uy, minA, maxA, minB, maxB };
    }
  }
  return best ?? { ux: 1, uy: 0, minA: 0, maxA: 0, minB: 0, maxB: 0 };
}

/** A rotated rectangle's four corners, in its own axes' order. */
function cornersOf(r: Rotated): Point[] {
  const at = (a: number, b: number): Point => [a * r.ux - b * r.uy, a * r.uy + b * r.ux];
  return [at(r.minA, r.minB), at(r.maxA, r.minB), at(r.maxA, r.maxB), at(r.minA, r.maxB)];
}

/**
 * Corners in reading order — top-left, top-right, bottom-right, bottom-left —
 * as PaddleOCR's `order_points` puts them: the two leftmost are the left side,
 * and of each pair the higher one is on top.
 */
function orderQuad(corners: Point[]): Quad {
  const byX = [...corners].sort((p, q) => p[0] - q[0]);
  const [l1, l2, r1, r2] = byX as [Point, Point, Point, Point];
  const [tl, bl] = l1[1] <= l2[1] ? [l1, l2] : [l2, l1];
  const [tr, br] = r1[1] <= r2[1] ? [r1, r2] : [r2, r1];
  return [tl, tr, br, bl];
}

/**
 * PaddleOCR's `box_score_fast`: the mean probability inside the rotated
 * rectangle — not inside its upright bounds, which for a slanted line are
 * mostly background.
 */
function scoreInside(data: Float32Array, w: number, h: number, r: Rotated): number {
  const corners = cornersOf(r);
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(w - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));

  let sum = 0;
  let count = 0;
  for (let y = y0; y <= y1; y += 1) {
    const cy = y + 0.5;
    for (let x = x0; x <= x1; x += 1) {
      const cx = x + 0.5;
      const along = cx * r.ux + cy * r.uy;
      const across = -cx * r.uy + cy * r.ux;
      if (along < r.minA || along > r.maxA || across < r.minB || across > r.maxB) continue;
      sum += data[y * w + x]!;
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
}

/**
 * The text boxes in the detector's probability map, in page coordinates.
 *
 * PaddleOCR's DB post-processing: threshold the map, take each connected
 * region, fit it a rotated rectangle, score the rectangle by its mean
 * probability, and grow it by the "unclip" distance — `area x ratio /
 * perimeter` — because the network is trained to draw each region smaller than
 * the text it covers, so that neighbouring lines never merge.
 */
export function findTextBoxes(
  map: { data: Float32Array; width: number; height: number },
  page: { width: number; height: number },
  params: Omit<DetectionParams, 'limitSideLen'>,
): ScoredBox[] {
  const { data, width: w, height: h } = map;
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  // Each row's leftmost and rightmost pixel in the current region: every pixel
  // lies between its row's two, so their corners carry the region's hull.
  const rowMin = new Int32Array(h).fill(-1);
  const rowMax = new Int32Array(h).fill(-1);
  const rows: number[] = [];
  const boxes: ScoredBox[] = [];
  let candidates = 0;

  for (let start = 0; start < w * h; start += 1) {
    if (seen[start] === 1 || data[start]! <= params.thresh) continue;
    if (candidates >= params.maxCandidates) break;
    candidates += 1;

    // One region, flood-filled with eight-way connectivity, as `findContours`
    // treats a blob.
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    rows.length = 0;

    while (top > 0) {
      const at = stack[--top]!;
      const x = at % w;
      const y = (at - x) / w;
      if (rowMin[y] === -1) {
        rowMin[y] = x;
        rowMax[y] = x;
        rows.push(y);
      } else {
        if (x < rowMin[y]!) rowMin[y] = x;
        if (x > rowMax[y]!) rowMax[y] = x;
      }

      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const next = ny * w + nx;
          if (seen[next] === 1 || data[next]! <= params.thresh) continue;
          seen[next] = 1;
          stack[top++] = next;
        }
      }
    }

    // Pixel corners, so a region's extent is edge to edge.
    const points: Point[] = [];
    for (const y of rows) {
      points.push([rowMin[y]!, y], [rowMax[y]! + 1, y], [rowMin[y]!, y + 1], [rowMax[y]! + 1, y + 1]);
      rowMin[y] = -1;
      rowMax[y] = -1;
    }

    const rect = minAreaRect(points);
    const long = rect.maxA - rect.minA;
    const short = rect.maxB - rect.minB;
    if (Math.min(long, short) < MIN_BOX_SIDE) continue;

    const score = scoreInside(data, w, h, rect);
    if (score < params.boxThresh) continue;

    // Unclip: grow every side by area x ratio / perimeter. For a rectangle,
    // Clipper's rounded offset followed by `minAreaRect` is exactly this.
    const grow = (long * short * params.unclipRatio) / (2 * (long + short));
    const grown: Rotated = {
      ...rect,
      minA: rect.minA - grow,
      maxA: rect.maxA + grow,
      minB: rect.minB - grow,
      maxB: rect.maxB + grow,
    };
    if (Math.min(long, short) + 2 * grow < MIN_BOX_SIDE + 2) continue;

    const sx = page.width / w;
    const sy = page.height / h;
    const quad = orderQuad(
      cornersOf(grown).map(
        ([x, y]): Point => [
          Math.min(Math.max(x * sx, 0), page.width),
          Math.min(Math.max(y * sy, 0), page.height),
        ],
      ),
    );
    boxes.push({
      x0: Math.min(...quad.map((p) => p[0])),
      y0: Math.min(...quad.map((p) => p[1])),
      x1: Math.max(...quad.map((p) => p[0])),
      y1: Math.max(...quad.map((p) => p[1])),
      quad,
      score,
    });
  }

  // Reading order, as PaddleOCR sorts: top to bottom, and left to right among
  // boxes whose tops are within ten pixels of each other.
  boxes.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  for (let i = 0; i < boxes.length - 1; i += 1) {
    for (let j = i; j >= 0; j -= 1) {
      const current = boxes[j]!;
      const next = boxes[j + 1]!;
      if (Math.abs(next.y0 - current.y0) < 10 && next.x0 < current.x0) {
        boxes[j] = next;
        boxes[j + 1] = current;
      } else {
        break;
      }
    }
  }

  return boxes;
}

// ---------------------------------------------------------------------------
// Recognition
// ---------------------------------------------------------------------------

export interface RecognitionInput {
  /** Planar BGR, normalised to -1 .. 1, `3 x height x width`. */
  tensor: Float32Array;
  width: number;
  height: number;
  /** How much of `width` is the crop; the rest is zero padding. */
  contentWidth: number;
}

/** One channel of the image at a fractional position, bilinear, clamped to the edge. */
function sample(image: RgbaImage, x: number, y: number, out: Float32Array): void {
  const { data, width, height } = image;
  const fx = Math.min(Math.max(x - 0.5, 0), width - 1);
  const fy = Math.min(Math.max(y - 0.5, 0), height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const wx = fx - x0;
  const wy = fy - y0;
  const a = (y0 * width + x0) * 4;
  const b = (y0 * width + x1) * 4;
  const c = (y1 * width + x0) * 4;
  const d = (y1 * width + x1) * 4;
  for (let ch = 0; ch < 3; ch += 1) {
    const topRow = data[a + ch]! * (1 - wx) + data[b + ch]! * wx;
    const bottomRow = data[c + ch]! * (1 - wx) + data[d + ch]! * wx;
    out[ch] = topRow * (1 - wy) + bottomRow * wy;
  }
}

const distance = (p: Point, q: Point) => Math.hypot(q[0] - p[0], q[1] - p[1]);

/**
 * One box, ready for the recogniser.
 *
 * PaddleOCR's `get_rotate_crop_image` then `resize_norm_img`, in one pass: the
 * rotated box is warped upright — a slanted line comes out straight — scaled to
 * `targetHeight` keeping its proportions, and padded with zeros to at least the
 * width the recogniser was trained on, rather than stretching a short word. A
 * box half again as tall as it is wide is read on its side, as PaddleOCR reads
 * vertical text.
 */
export function cropForRecognition(image: RgbaImage, region: Region, targetHeight: number): RecognitionInput {
  let [tl, tr, br, bl]: Quad = region.quad ?? [
    [region.x0, region.y0],
    [region.x1, region.y0],
    [region.x1, region.y1],
    [region.x0, region.y1],
  ];

  let cw = Math.max(distance(tl, tr), distance(bl, br));
  let ch = Math.max(distance(tl, bl), distance(tr, br));
  if (ch >= cw * 1.5) {
    // Rotate a quarter turn anticlockwise, as `np.rot90` does to the crop.
    [tl, tr, br, bl] = [tr, br, bl, tl];
    [cw, ch] = [ch, cw];
  }
  cw = Math.max(1, cw);
  ch = Math.max(1, ch);

  const ratio = cw / ch;
  const contentWidth = Math.max(1, Math.min(RECOGNITION_MAX_WIDTH, Math.ceil(targetHeight * ratio)));
  const minWidth = Math.trunc(targetHeight * Math.max(RECOGNITION_BASE_WIDTH / 48, ratio));
  const width = Math.min(RECOGNITION_MAX_WIDTH, Math.max(contentWidth, minWidth));

  const plane = targetHeight * width;
  const tensor = new Float32Array(3 * plane);
  const { mean, std, scale } = RECOGNITION_NORMALISE;
  const pixel = new Float32Array(3);

  for (let v = 0; v < targetHeight; v += 1) {
    const t = (v + 0.5) / targetHeight;
    for (let u = 0; u < contentWidth; u += 1) {
      const s = (u + 0.5) / contentWidth;
      // Bilinear across the quad: exact for a rectangle at any angle.
      const x =
        tl[0] * (1 - s) * (1 - t) + tr[0] * s * (1 - t) + br[0] * s * t + bl[0] * (1 - s) * t;
      const y =
        tl[1] * (1 - s) * (1 - t) + tr[1] * s * (1 - t) + br[1] * s * t + bl[1] * (1 - s) * t;
      sample(image, x, y, pixel);

      const i = v * width + u;
      tensor[i] = (pixel[2]! * scale - mean[0]) / std[0];
      tensor[i + plane] = (pixel[1]! * scale - mean[1]) / std[1];
      tensor[i + 2 * plane] = (pixel[0]! * scale - mean[2]) / std[2];
    }
  }

  return { tensor, width, height: targetHeight, contentWidth };
}

/**
 * The recogniser's output, as text.
 *
 * CTC greedy decoding, exactly as PaddleOCR's `CTCLabelDecode`: the most likely
 * class at each step, class 0 is "no character", a class repeated across steps
 * is one character unless a blank separates the repeats. The score is the mean
 * probability of the characters kept.
 */
export function decodeCtc(
  data: Float32Array,
  timeSteps: number,
  classes: number,
  characters: readonly string[],
  offset = 0,
): { text: string; score: number } {
  let text = '';
  let previous = -1;
  let total = 0;
  let kept = 0;

  for (let step = 0; step < timeSteps; step += 1) {
    const base = offset + step * classes;
    let best = 0;
    let bestValue = -Infinity;
    for (let cls = 0; cls < classes; cls += 1) {
      const value = data[base + cls]!;
      if (value > bestValue) {
        bestValue = value;
        best = cls;
      }
    }

    if (best > 0 && best !== previous) {
      const character = characters[best - 1];
      if (character !== undefined) {
        text += character;
        total += bestValue;
        kept += 1;
      }
    }
    previous = best;
  }

  return { text, score: kept === 0 ? 0 : total / kept };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

type Loose = Record<string, unknown>;

const isObject = (value: unknown): value is Loose =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * What the extension needs from a model's `inference.yml`, already parsed.
 *
 * Parsed at build time by a real YAML parser and shipped as JSON, so the
 * extension carries no YAML parser — the character list alone has hundreds of
 * entries in every quoting style YAML allows, and getting one wrong makes every
 * character read as its neighbour.
 */
export function modelConfigFrom(parsed: unknown): ModelConfig {
  if (!isObject(parsed)) throw new Error('A model settings file must be a mapping.');

  const global = isObject(parsed.Global) ? parsed.Global : {};
  const modelName = global.model_name;
  if (typeof modelName !== 'string' || modelName.trim() === '') {
    throw new Error('A model settings file must name its model (Global.model_name).');
  }

  const config: ModelConfig = { modelName };
  const post = isObject(parsed.PostProcess) ? parsed.PostProcess : {};

  if (Array.isArray(post.character_dict)) {
    const characters = post.character_dict.map((entry: unknown) => {
      if (typeof entry !== 'string' && typeof entry !== 'number') {
        throw new Error(`A character list entry is not text: ${JSON.stringify(entry)}`);
      }
      return String(entry);
    });
    // PaddleOCR appends a space to every list (`use_space_char`).
    config.characters = [...characters, ' '];
  }

  if (post.name === 'DBPostProcess') {
    const pre = isObject(parsed.PreProcess) ? parsed.PreProcess : {};
    const ops = Array.isArray(pre.transform_ops) ? pre.transform_ops : [];
    const resize = ops.find((op): op is Loose => isObject(op) && 'DetResizeForTest' in op);
    const resizeArgs = resize !== undefined && isObject(resize.DetResizeForTest) ? resize.DetResizeForTest : {};

    config.detection = {
      limitSideLen: numberOr(resizeArgs.resize_long ?? resizeArgs.limit_side_len, DETECTION_DEFAULTS.limitSideLen),
      thresh: numberOr(post.thresh, DETECTION_DEFAULTS.thresh),
      boxThresh: numberOr(post.box_thresh, DETECTION_DEFAULTS.boxThresh),
      maxCandidates: numberOr(post.max_candidates, DETECTION_DEFAULTS.maxCandidates),
      unclipRatio: numberOr(post.unclip_ratio, DETECTION_DEFAULTS.unclipRatio),
    };
  }

  if (isObject(post.Topk) && Array.isArray(post.Topk.label_list)) {
    const pre = isObject(parsed.PreProcess) ? parsed.PreProcess : {};
    const ops = Array.isArray(pre.transform_ops) ? pre.transform_ops : [];
    const argsOf = (name: string): Loose => {
      const op = ops.find((entry): entry is Loose => isObject(entry) && name in entry);
      return op !== undefined && isObject(op[name]) ? op[name] : {};
    };
    const normalise = argsOf('NormalizeImage');
    const triple = (value: unknown, fallback: readonly number[]): number[] =>
      Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number')
        ? [...(value as number[])]
        : [...fallback];

    const labels = post.Topk.label_list.map((label: unknown) => Number(label));
    if (labels.some((label) => !Number.isFinite(label) || label % 90 !== 0)) {
      throw new Error('An orientation model must label its classes in quarter turns.');
    }

    config.orientation = {
      resizeShort: numberOr(argsOf('ResizeImage').resize_short, 256),
      cropSize: numberOr(argsOf('CropImage').size, 224),
      mean: triple(normalise.mean, DETECTION_NORMALISE.mean),
      std: triple(normalise.std, DETECTION_NORMALISE.std),
      scale: numberOr(normalise.scale, 1 / 255),
      labels,
    };
  }

  return config;
}
