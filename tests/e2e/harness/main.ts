/**
 * Browser-side harness for the derivation pipeline.
 *
 * Unit tests cover the pipeline's decisions against a fake backend (§6.1: no
 * DOM). This harness exists so the *real* backend — OffscreenCanvas, the JPEG
 * encoder, pdf-lib — can be exercised in a real browser by Playwright. It is a
 * test fixture and is never bundled into the extension.
 */

import { derive, type DerivationResult } from '@/documents/derive';
import { parseConstraint } from '@/documents/constraints';
import { createRasterBackend } from '@/documents/raster';

import type { HarnessResult } from './harness.d';

async function run(url: string, sourceMime: string, constraintText: string): Promise<HarnessResult> {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const { constraint } = parseConstraint(constraintText);
  const result: DerivationResult = await derive(
    createRasterBackend(),
    bytes,
    sourceMime,
    constraint,
  );

  if (!result.ok) {
    return { ok: false, reason: result.reason, code: result.code };
  }
  return {
    ok: true,
    mime: result.mime,
    bytes: result.bytes.length,
    width: result.width,
    height: result.height,
    ...(result.quality === undefined ? {} : { quality: result.quality }),
    fit: result.fit,
    warnings: result.warnings.map((w) => w.code),
    attempts: result.attempts.length,
    magic: Array.from(result.bytes.slice(0, 8)),
  };
}

window.__derive = run;
