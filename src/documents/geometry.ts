/**
 * Dimension planning for document derivation (§ Phase 2). Pure arithmetic —
 * no canvas, no DOM, so §6.1's "unit tests, no DOM" rule holds.
 *
 * The job: given a source image and a portal's constraint, decide the exact
 * output pixel box and how the source should be fitted into it.
 */

import type { DocConstraint } from '@/shared/types';

/** Fallback when a constraint gives physical size but no DPI. */
export const DEFAULT_DPI = 200;

/** Below this the output is too soft to be worth submitting. */
export const MIN_USEFUL_UPSCALE = 1.0;

export interface SourceImage {
  width: number;
  height: number;
}

export type FitMode =
  /** Scale to fill the box and crop the overflow. Default when aspect is fixed. */
  | 'cover'
  /** Scale to fit inside the box, leaving letterbox padding. */
  | 'pad'
  /** Scale freely; the box is only a bound, so aspect is preserved. */
  | 'contain';

export interface TargetBox {
  width: number;
  height: number;
  fit: FitMode;
  /** How much the source is being scaled. >1 means upscaling, which loses quality. */
  scale: number;
  /** True when the box came from an explicit portal requirement. */
  exact: boolean;
}

export function mmToPx(mm: number, dpi: number): number {
  return Math.round((mm / 25.4) * dpi);
}

export function pxToMm(px: number, dpi: number): number {
  return (px / dpi) * 25.4;
}

/**
 * Scale a source box to fit inside a bound while preserving aspect.
 * Only ever shrinks — used for max-dimension constraints.
 */
export function fitInside(
  source: SourceImage,
  maxW: number | undefined,
  maxH: number | undefined,
): { width: number; height: number } {
  const wRatio = maxW === undefined ? 1 : maxW / source.width;
  const hRatio = maxH === undefined ? 1 : maxH / source.height;
  const ratio = Math.min(1, wRatio, hRatio);
  return {
    width: Math.max(1, Math.round(source.width * ratio)),
    height: Math.max(1, Math.round(source.height * ratio)),
  };
}

/** Scale a source box up to satisfy a minimum, preserving aspect. */
export function growToCover(
  source: SourceImage,
  minW: number | undefined,
  minH: number | undefined,
): { width: number; height: number } {
  const wRatio = minW === undefined ? 1 : minW / source.width;
  const hRatio = minH === undefined ? 1 : minH / source.height;
  const ratio = Math.max(1, wRatio, hRatio);
  return {
    width: Math.max(1, Math.round(source.width * ratio)),
    height: Math.max(1, Math.round(source.height * ratio)),
  };
}

/**
 * Decide the output pixel box.
 *
 * Priority, highest first:
 *  1. `dimensionsMm` — the portal named a physical size. Convert at its DPI
 *     (or `DEFAULT_DPI`) and treat the result as exact.
 *  2. An exact pixel box (`minW === maxW && minH === maxH`).
 *  3. A min and/or max bound — shrink or grow only as far as needed.
 *  4. Nothing stated — keep the source dimensions.
 */
export function planTargetBox(source: SourceImage, constraint: DocConstraint): TargetBox {
  if (constraint.dimensionsMm) {
    const dpi = constraint.dpi ?? DEFAULT_DPI;
    const [wMm, hMm] = constraint.dimensionsMm;
    const width = mmToPx(wMm, dpi);
    const height = mmToPx(hMm, dpi);
    return {
      width,
      height,
      // A fixed physical size means a fixed aspect: crop rather than distort.
      fit: 'cover',
      scale: scaleOf(source, width, height),
      exact: true,
    };
  }

  const exactPixels =
    constraint.minW !== undefined &&
    constraint.minW === constraint.maxW &&
    constraint.minH !== undefined &&
    constraint.minH === constraint.maxH;

  if (exactPixels) {
    const width = constraint.minW!;
    const height = constraint.minH!;
    return { width, height, fit: 'cover', scale: scaleOf(source, width, height), exact: true };
  }

  let { width, height } = source;

  if (constraint.maxW !== undefined || constraint.maxH !== undefined) {
    ({ width, height } = fitInside({ width, height }, constraint.maxW, constraint.maxH));
  }
  if (constraint.minW !== undefined || constraint.minH !== undefined) {
    ({ width, height } = growToCover({ width, height }, constraint.minW, constraint.minH));
  }

  return {
    width,
    height,
    fit: 'contain',
    scale: scaleOf(source, width, height),
    exact: false,
  };
}

function scaleOf(source: SourceImage, width: number, height: number): number {
  return Math.max(width / source.width, height / source.height);
}

export interface QualityWarning {
  /** `first-page-only`: a PDF of several pages, copied as a picture, which holds one. */
  code: 'upscaled' | 'heavy-crop' | 'first-page-only';
  message: string;
}

/**
 * Warn when the plan degrades the image, without blocking it.
 *
 * Upscaling and heavy cropping produce a *valid* file that may still be a bad
 * photograph. The plan's "quality gate on upload" wants this surfaced at intake
 * rather than discovered by a rejected application.
 */
export function inspectQuality(source: SourceImage, box: TargetBox): QualityWarning[] {
  const warnings: QualityWarning[] = [];

  // Nothing measured, nothing to judge. A PDF is 0 x 0 until it is drawn, at
  // whatever size the portal asks; judged as a picture, every PDF was "being
  // enlarged by Infinity%".
  if (!(source.width > 0) || !(source.height > 0)) return warnings;

  if (box.scale > MIN_USEFUL_UPSCALE) {
    const percent = Math.round((box.scale - 1) * 100);
    warnings.push({
      code: 'upscaled',
      message:
        `This image is smaller than the portal requires and is being enlarged by ${percent}%. ` +
        'It will look soft. Re-scan or re-photograph at a higher resolution if you can.',
    });
  }

  if (box.fit === 'cover') {
    const sourceAspect = source.width / source.height;
    const targetAspect = box.width / box.height;
    const drift = Math.abs(sourceAspect - targetAspect) / targetAspect;
    if (drift > 0.15) {
      warnings.push({
        code: 'heavy-crop',
        message:
          `The required shape differs from your image by ${Math.round(drift * 100)}%, so a ` +
          'noticeable amount will be cropped. Check the preview before you use it.',
      });
    }
  }

  return warnings;
}
