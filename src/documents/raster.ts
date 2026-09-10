/**
 * The real raster backend (§ Phase 2).
 *
 * `OffscreenCanvas` + `createImageBitmap`, so it runs in the service worker or
 * an offscreen document without touching a page. Nothing here uploads anything:
 * every byte stays in this process (§1, "client-side only").
 *
 * All the decision logic lives in `derive.ts` / `geometry.ts` / `quality-search.ts`.
 * This module only pushes pixels, which is why it is the one part of the
 * pipeline that unit tests cannot reach — it is covered by the Playwright
 * derivation spec instead.
 */

import type { RasterBackend, RasterSource } from './derive';
import type { TargetBox } from './geometry';
import { readShape, type ContentBox, type LuminanceImage, type ShapeReading } from './trim';

/** White, so a letterboxed photograph looks like a photograph and not a hole. */
const PAD_COLOUR = '#ffffff';

function bitmapOf(source: RasterSource): ImageBitmap {
  return source.handle as ImageBitmap;
}

async function toBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Compute the source rectangle to draw for a given fit mode.
 *
 * `cover` centre-crops: the portal fixed the aspect, and distorting a face to
 * fit is worse than trimming its edges.
 */
function drawRect(source: ImageBitmap, box: TargetBox) {
  const sourceAspect = source.width / source.height;
  const targetAspect = box.width / box.height;

  if (box.fit === 'contain' || Math.abs(sourceAspect - targetAspect) < 1e-6) {
    return { sx: 0, sy: 0, sw: source.width, sh: source.height, dx: 0, dy: 0, dw: box.width, dh: box.height };
  }

  if (box.fit === 'cover') {
    if (sourceAspect > targetAspect) {
      // Source is wider: trim the sides.
      const sw = Math.round(source.height * targetAspect);
      return {
        sx: Math.round((source.width - sw) / 2),
        sy: 0,
        sw,
        sh: source.height,
        dx: 0,
        dy: 0,
        dw: box.width,
        dh: box.height,
      };
    }
    // Source is taller: trim top and bottom.
    const sh = Math.round(source.width / targetAspect);
    return {
      sx: 0,
      sy: Math.round((source.height - sh) / 2),
      sw: source.width,
      sh,
      dx: 0,
      dy: 0,
      dw: box.width,
      dh: box.height,
    };
  }

  // 'pad' — fit the whole image inside and letterbox the remainder.
  const scale = Math.min(box.width / source.width, box.height / source.height);
  const dw = Math.round(source.width * scale);
  const dh = Math.round(source.height * scale);
  return {
    sx: 0,
    sy: 0,
    sw: source.width,
    sh: source.height,
    dx: Math.round((box.width - dw) / 2),
    dy: Math.round((box.height - dh) / 2),
    dw,
    dh,
  };
}

/**
 * Downsample an image to a luminance buffer for `trim.ts`.
 *
 * Two decisions worth stating.
 *
 * **It samples rather than reading every pixel.** A 12-megapixel phone photo is
 * 48 MB of RGBA, and the answer we want — where the ink stops — does not change
 * at full resolution. Capping the long edge at `SAMPLE_EDGE` keeps the read
 * under a megabyte and the cost flat regardless of what the user uploads.
 *
 * **It flattens onto white.** A PNG signature is usually ink on transparency,
 * and transparent pixels read as black in raw RGBA — which would make the
 * entire canvas "ink" and find nothing to trim. Compositing first means the
 * measurement sees what the user sees.
 */
const SAMPLE_EDGE = 512;

/** Rec. 709 luma. Green dominates because human vision does. */
function luma(r: number, g: number, b: number): number {
  return (r * 218 + g * 732 + b * 74) >> 10;
}

export async function readLuminance(bitmap: ImageBitmap): Promise<LuminanceImage | null> {
  const scale = Math.min(1, SAMPLE_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  ctx.fillStyle = PAD_COLOUR;
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);

  let rgba: ImageData;
  try {
    rgba = ctx.getImageData(0, 0, width, height);
  } catch {
    // A cross-origin or otherwise tainted canvas. Not fatal: callers fall back
    // to judging by the canvas, which is what they did before this existed.
    return null;
  }

  const data = new Uint8Array(width * height);
  for (let i = 0, p = 0; p < data.length; i += 4, p++) {
    data[p] = luma(rgba.data[i]!, rgba.data[i + 1]!, rgba.data[i + 2]!);
  }
  return { width, height, data };
}

/**
 * Measure where the content sits inside an image file.
 *
 * The returned box is in the **original image's** pixels, not the sample's, so
 * callers can crop with it directly. `null` means "could not tell" — a blank
 * page, an unreadable file, a canvas we may not read — and every caller treats
 * that as "fall back to the whole canvas".
 */
export async function measureShape(
  bytes: Uint8Array,
  mime: string,
): Promise<ShapeReading | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
  } catch {
    return null;
  }

  try {
    const sample = await readLuminance(bitmap);
    if (!sample) return null;

    const shape = readShape(sample);
    if (!shape) return null;

    // Scale the box back up. Round outward so a stroke on the boundary of a
    // sampled pixel is kept rather than shaved.
    const kx = bitmap.width / sample.width;
    const ky = bitmap.height / sample.height;
    const content: ContentBox = {
      left: Math.max(0, Math.floor(shape.content.left * kx)),
      top: Math.max(0, Math.floor(shape.content.top * ky)),
      width: Math.min(bitmap.width, Math.ceil(shape.content.width * kx)),
      height: Math.min(bitmap.height, Math.ceil(shape.content.height * ky)),
    };

    return { ...shape, content, canvasAspect: bitmap.width / bitmap.height };
  } finally {
    bitmap.close();
  }
}

export function createRasterBackend(): RasterBackend {
  return {
    async decode(bytes, mime) {
      const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
      return { width: bitmap.width, height: bitmap.height, handle: bitmap };
    },

    async crop(source, box) {
      const bitmap = bitmapOf(source);
      const canvas = new OffscreenCanvas(box.width, box.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable.');

      // Flatten onto white first, for the same reason `resize` does: a cropped
      // PNG keeps its alpha, and JPEG has nowhere to put it.
      ctx.fillStyle = PAD_COLOUR;
      ctx.fillRect(0, 0, box.width, box.height);
      ctx.drawImage(
        bitmap,
        box.left,
        box.top,
        box.width,
        box.height,
        0,
        0,
        box.width,
        box.height,
      );

      const cropped = canvas.transferToImageBitmap();
      return { width: cropped.width, height: cropped.height, handle: cropped };
    },

    async resize(source, box) {
      const bitmap = bitmapOf(source);
      const canvas = new OffscreenCanvas(box.width, box.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable.');

      // Flatten onto white: JPEG has no alpha, and an unflattened transparent
      // PNG would otherwise encode as black.
      ctx.fillStyle = PAD_COLOUR;
      ctx.fillRect(0, 0, box.width, box.height);

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      const r = drawRect(bitmap, box);
      ctx.drawImage(bitmap, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh);

      const resized = canvas.transferToImageBitmap();
      return { width: resized.width, height: resized.height, handle: resized };
    },

    async encodeJpeg(source, quality) {
      const canvas = drawToCanvas(bitmapOf(source));
      return toBytes(await canvas.convertToBlob({ type: 'image/jpeg', quality }));
    },

    async encodePng(source) {
      const canvas = drawToCanvas(bitmapOf(source));
      return toBytes(await canvas.convertToBlob({ type: 'image/png' }));
    },

    async rasterisePdf(bytes, targetWidth) {
      const { getDocument } = await loadPdfJs();
      // `data` is transferred, so hand pdf.js a copy the caller still owns.
      const task = getDocument({ data: new Uint8Array(bytes) });
      const pdf = await task.promise;
      try {
        const page = await pdf.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: targetWidth / base.width });

        const canvas = new OffscreenCanvas(
          Math.round(viewport.width),
          Math.round(viewport.height),
        );
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable.');

        ctx.fillStyle = PAD_COLOUR;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({
          canvas: canvas as unknown as HTMLCanvasElement,
          canvasContext: ctx as unknown as CanvasRenderingContext2D,
          viewport,
        }).promise;

        const bitmap = canvas.transferToImageBitmap();
        return { width: bitmap.width, height: bitmap.height, handle: bitmap };
      } finally {
        // destroy() lives on the loading task, not the document proxy, and
        // releases the transport as well as the document.
        await task.destroy();
      }
    },

    async wrapJpegInPdf(jpeg, width, height) {
      // Loaded lazily, like pdf.js: most derivations never touch a PDF, and a
      // static import would put ~700 KB into the service worker's cold start.
      const { PDFDocument } = await import('pdf-lib');
      const doc = await PDFDocument.create();
      const image = await doc.embedJpg(jpeg);
      const page = doc.addPage([width, height]);
      page.drawImage(image, { x: 0, y: 0, width, height });
      return doc.save({ useObjectStreams: true });
    },

    release(source) {
      const handle = source.handle;
      if (typeof ImageBitmap !== 'undefined' && handle instanceof ImageBitmap) {
        handle.close();
      }
    },
  };
}

function drawToCanvas(bitmap: ImageBitmap): OffscreenCanvas {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable.');
  ctx.drawImage(bitmap, 0, 0);
  return canvas;
}

/**
 * Load pdf.js lazily and with its worker disabled.
 *
 * It is ~1 MB, only needed when a PDF is actually involved, and a separate
 * worker script is awkward to ship under the extension's strict CSP. Running
 * on the calling thread is slower but keeps `script-src 'self'` intact and
 * avoids a second code path to audit (§ Phase 10).
 */
async function loadPdfJs() {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = '';
  return pdfjs;
}
