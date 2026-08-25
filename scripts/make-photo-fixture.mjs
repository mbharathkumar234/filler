#!/usr/bin/env node
/**
 * Generate `fixtures/photo-4mb.jpg` — the oversized source the Phase 2 Verify
 * step calls for ("feed a 4 MB phone photo").
 *
 * Why generated rather than committed: a real photograph of a real person is
 * exactly the kind of PII the fixtures README forbids, and a stock photo drags
 * a licence into the repo. This draws a synthetic portrait-ish scene at phone
 * resolution — smooth gradients, soft shapes, and fine grain, so it compresses
 * roughly like a real photo rather than like flat colour.
 *
 * Uses Playwright's Chromium because JPEG encoding needs a real browser; Node
 * has no image encoder and pulling in a native one for a fixture is not worth it.
 *
 *   node scripts/make-photo-fixture.mjs
 */

import { chromium } from '@playwright/test';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(fileURLToPath(new URL('../fixtures/photo-4mb.jpg', import.meta.url)));

// A typical phone camera: 12 MP, 3:4 portrait.
const WIDTH = 3024;
const HEIGHT = 4032;
const TARGET_BYTES = 4 * 1024 * 1024;

const browser = await chromium.launch();
const page = await browser.newPage();

const base64 = await page.evaluate(
  async ({ width, height, target }) => {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Backdrop: a soft vertical gradient, like a studio wall.
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, '#e8eef5');
    sky.addColorStop(0.55, '#c9d6e4');
    sky.addColorStop(1, '#8fa3b8');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);

    // Subject: overlapping soft ellipses standing in for head and shoulders.
    const cx = width / 2;
    const headR = width * 0.22;
    const headY = height * 0.34;

    const shoulders = ctx.createLinearGradient(0, height * 0.55, 0, height);
    shoulders.addColorStop(0, '#3f5a74');
    shoulders.addColorStop(1, '#22384d');
    ctx.fillStyle = shoulders;
    ctx.beginPath();
    ctx.ellipse(cx, height * 1.02, width * 0.52, height * 0.34, 0, 0, Math.PI * 2);
    ctx.fill();

    const skin = ctx.createRadialGradient(
      cx - headR * 0.3, headY - headR * 0.3, headR * 0.1,
      cx, headY, headR * 1.15,
    );
    skin.addColorStop(0, '#f0d3ba');
    skin.addColorStop(0.7, '#d9ac89');
    skin.addColorStop(1, '#a97a5c');
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.ellipse(cx, headY, headR * 0.82, headR * 1.05, 0, 0, Math.PI * 2);
    ctx.fill();

    // A few darker features, so downscaling has real detail to lose.
    ctx.fillStyle = 'rgba(60,40,30,0.75)';
    for (const [dx, dy, rx, ry] of [
      [-0.32, -0.18, 0.11, 0.055],
      [0.32, -0.18, 0.11, 0.055],
      [0, 0.34, 0.20, 0.07],
    ]) {
      ctx.beginPath();
      ctx.ellipse(cx + headR * dx, headY + headR * dy, headR * rx, headR * ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Fine grain across the whole frame. This is what keeps the file large:
    // smooth gradients alone would compress to a few hundred KB.
    const grain = ctx.getImageData(0, 0, width, height);
    const px = grain.data;
    for (let i = 0; i < px.length; i += 4) {
      const n = (Math.random() - 0.5) * 46;
      px[i] = Math.max(0, Math.min(255, px[i] + n));
      px[i + 1] = Math.max(0, Math.min(255, px[i + 1] + n));
      px[i + 2] = Math.max(0, Math.min(255, px[i + 2] + n));
    }
    ctx.putImageData(grain, 0, 0);

    // Walk quality down until we land near the target size from above.
    let blob = null;
    for (const quality of [0.98, 0.95, 0.92, 0.88, 0.84, 0.8, 0.75, 0.7]) {
      blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      if (blob.size <= target) break;
    }

    const buffer = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < buffer.length; i += CHUNK) {
      binary += String.fromCharCode(...buffer.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  },
  { width: WIDTH, height: HEIGHT, target: TARGET_BYTES },
);

await browser.close();

const bytes = Buffer.from(base64, 'base64');
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, bytes);

console.log(
  `wrote ${OUT} — ${(bytes.length / 1024 / 1024).toFixed(2)} MB, ${WIDTH}x${HEIGHT}`,
);
