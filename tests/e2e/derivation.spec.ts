import { expect, test } from '@playwright/test';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Phase 2 Verify step, run for real.
 *
 * The unit suite proves the pipeline's *decisions* against a fake backend. This
 * spec proves the actual output: a real JPEG encoder, real OffscreenCanvas
 * resampling, real pdf-lib output — in a real browser, which is the only place
 * any of that exists.
 *
 * Assertions check file magic bytes rather than trusting the reported mime, so
 * a backend that lied about its output would fail here.
 */

const PHOTO = '/photo-4mb.jpg';
const KB = 1024;

const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // "%PDF"

test.beforeEach(async ({ page }) => {
  await page.goto('/_harness/index.html');
  await page.waitForFunction(() => typeof window.__derive === 'function');
});

test('the source fixture really is an oversized phone photo', () => {
  const path = resolve(fileURLToPath(new URL('../../fixtures/photo-4mb.jpg', import.meta.url)));
  const size = statSync(path).size;
  expect(size).toBeGreaterThan(3 * 1024 * 1024);
});

test('derives the plan’s worked example: 20–50 KB, 3.5×4.5 cm JPEG', async ({ page }) => {
  const result = await page.evaluate(
    ([url]) =>
      window.__derive(
        url!,
        'image/jpeg',
        'Photograph must be JPEG/JPG, 20 KB to 50 KB, 3.5 cm × 4.5 cm.',
      ),
    [PHOTO],
  );

  expect(result.ok, result.reason).toBe(true);

  // Format: claimed and actual.
  expect(result.mime).toBe('image/jpeg');
  expect(result.magic?.slice(0, 3)).toEqual(JPEG_MAGIC);

  // Bytes: inside the window the portal stated.
  expect(result.bytes).toBeGreaterThanOrEqual(20 * KB);
  expect(result.bytes).toBeLessThanOrEqual(50 * KB);

  // Dimensions: 3.5 × 4.5 cm at the default 200 DPI.
  expect(result.width).toBe(276);
  expect(result.height).toBe(354);

  // A 3:4 source into a 35:45 box is a mild crop, not an upscale.
  expect(result.fit).toBe('cover');
  expect(result.warnings).toEqual([]);
});

test('finds the window in a handful of encodes, not by brute force', async ({ page }) => {
  const result = await page.evaluate(
    ([url]) => window.__derive(url!, 'image/jpeg', 'JPEG, 20 KB to 50 KB, 3.5 cm × 4.5 cm'),
    [PHOTO],
  );
  expect(result.ok).toBe(true);
  expect(result.attempts).toBeLessThanOrEqual(14);
});

test('satisfies a much tighter window on the same source', async ({ page }) => {
  const result = await page.evaluate(
    ([url]) => window.__derive(url!, 'image/jpeg', 'JPEG, 10 KB to 15 KB, 200 x 230 pixels'),
    [PHOTO],
  );

  expect(result.ok, result.reason).toBe(true);
  expect(result.bytes).toBeGreaterThanOrEqual(10 * KB);
  expect(result.bytes).toBeLessThanOrEqual(15 * KB);
  expect(result.width).toBe(200);
  expect(result.height).toBe(230);
});

test('honours a bare maximum with no minimum', async ({ page }) => {
  const result = await page.evaluate(
    ([url]) => window.__derive(url!, 'image/jpeg', 'JPEG, maximum 100 KB, 3.5 cm x 4.5 cm'),
    [PHOTO],
  );
  expect(result.ok, result.reason).toBe(true);
  expect(result.bytes).toBeLessThanOrEqual(100 * KB);
});

test('produces a real PNG when the portal forbids JPEG', async ({ page }) => {
  const result = await page.evaluate(
    ([url]) => window.__derive(url!, 'image/jpeg', 'PNG format only, 200 x 230 pixels'),
    [PHOTO],
  );

  expect(result.ok, result.reason).toBe(true);
  expect(result.mime).toBe('image/png');
  expect(result.magic?.slice(0, 4)).toEqual(PNG_MAGIC);
  expect(result.width).toBe(200);
});

test('produces a real PDF when the portal demands PDF', async ({ page }) => {
  const result = await page.evaluate(
    ([url]) => window.__derive(url!, 'image/jpeg', 'PDF only, maximum 200 KB, 3.5 cm x 4.5 cm'),
    [PHOTO],
  );

  expect(result.ok, result.reason).toBe(true);
  expect(result.mime).toBe('application/pdf');
  expect(result.magic?.slice(0, 4)).toEqual(PDF_MAGIC);
  expect(result.bytes).toBeLessThanOrEqual(200 * KB);
});

test('fails loudly, and readably, on an impossible window', async ({ page }) => {
  // The plan's own example of an unsatisfiable request.
  const result = await page.evaluate(
    ([url]) => window.__derive(url!, 'image/jpeg', 'JPEG, maximum 2 KB, 600 x 800 pixels'),
    [PHOTO],
  );

  expect(result.ok).toBe(false);
  expect(result.code).toBe('unsatisfiable-size');
  expect(result.reason).toContain('2 KB');
  expect(result.reason).toContain('600×800');
  expect(result.reason).not.toMatch(/undefined|NaN|\[object/);
});

test('warns rather than silently shipping a blurry upscale', async ({ page }) => {
  // Build a genuinely tiny master in the browser, then demand a passport-size
  // output from it. The file will be valid; the point is that we say it is soft.
  const result = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(60, 80);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#cc8844';
    ctx.fillRect(0, 0, 60, 80);
    ctx.fillStyle = '#222';
    ctx.fillRect(12, 18, 36, 30);

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    const url = URL.createObjectURL(blob);
    try {
      return await window.__derive(url, 'image/jpeg', 'JPEG, 3.5 cm × 4.5 cm');
    } finally {
      URL.revokeObjectURL(url);
    }
  });

  expect(result.ok, result.reason).toBe(true);
  expect(result.width).toBe(276);
  expect(result.warnings).toContain('upscaled');
});

test('rejects a file whose bytes are not the image it claims to be', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    try {
      return await window.__derive(url, 'image/jpeg', 'JPEG, max 50 KB');
    } finally {
      URL.revokeObjectURL(url);
    }
  });

  expect(result.ok).toBe(false);
  expect(result.code).toBe('decode-failed');
  expect(result.reason).toMatch(/corrupt/i);
});
