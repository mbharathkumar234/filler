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

export function createRasterBackend(): RasterBackend {
  return {
    async decode(bytes, mime) {
      const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
      return { width: bitmap.width, height: bitmap.height, handle: bitmap };
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
