/**
 * Browser-side harness for the derivation pipeline.
 *
 * Unit tests cover the pipeline's decisions against a fake backend (§6.1: no
 * DOM). This harness exists so the *real* backend — OffscreenCanvas, the JPEG
 * encoder, pdf-lib — can be exercised in a real browser by Playwright. It is a
 * test fixture and is never bundled into the extension.
 */

import { derive, type DerivationResult } from '@/documents/derive';
import { harvest } from '@/content/harvester';
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

/**
 * Harvest the *current* page in a real browser.
 *
 * jsdom has no layout engine, so the unit suite cannot test visibility, and its
 * iframes are not really cross-origin. Both are only real here.
 */
function runHarvest() {
  const { fields, blockers, wizard, labelSources } = harvest(document);
  const visible = fields.filter((f) => f.visible);
  return {
    fields: fields.map((f) => ({
      ref: f.ref,
      tag: f.tag,
      labelText: f.labelText,
      nearbyText: f.nearbyText,
      visible: f.visible,
      enabled: f.enabled,
      required: f.required,
      selectors: f.selectors,
      optionCount: f.options?.length ?? 0,
      source: labelSources.get(f.ref) ?? 'none',
    })),
    blockers: blockers.map((b) => ({ type: b.type, reason: b.reason })),
    wizard,
    visibleCount: visible.length,
    labelledCount: visible.filter((f) => f.labelText.trim() !== '').length,
    domUnchanged: document.body.innerHTML,
  };
}

window.__derive = run;
window.__harvest = runHarvest;
