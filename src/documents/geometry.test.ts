import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DPI,
  fitInside,
  growToCover,
  inspectQuality,
  mmToPx,
  planTargetBox,
  pxToMm,
} from './geometry';
import { parseConstraint } from './constraints';

describe('unit conversion', () => {
  it('converts mm to px at a given DPI', () => {
    // 35 mm at 200 DPI = 35/25.4*200 ≈ 276 px — the standard passport-photo width.
    expect(mmToPx(35, 200)).toBe(276);
    expect(mmToPx(45, 200)).toBe(354);
  });

  it('round-trips within a pixel', () => {
    expect(pxToMm(mmToPx(35, 300), 300)).toBeCloseTo(35, 1);
  });

  it('scales with DPI, to within the rounding at each step', () => {
    expect(Math.abs(mmToPx(35, 400) - mmToPx(35, 200) * 2)).toBeLessThanOrEqual(1);
  });
});

describe('fitInside', () => {
  it('shrinks to the tighter bound and preserves aspect', () => {
    const out = fitInside({ width: 4000, height: 3000 }, 800, 800);
    expect(out).toEqual({ width: 800, height: 600 });
  });

  it('never enlarges', () => {
    expect(fitInside({ width: 100, height: 100 }, 800, 800)).toEqual({ width: 100, height: 100 });
  });

  it('handles a single bound', () => {
    expect(fitInside({ width: 4000, height: 3000 }, 400, undefined)).toEqual({
      width: 400,
      height: 300,
    });
  });

  it('never returns a zero dimension', () => {
    const out = fitInside({ width: 4000, height: 10 }, 1, undefined);
    expect(out.width).toBeGreaterThanOrEqual(1);
    expect(out.height).toBeGreaterThanOrEqual(1);
  });
});

describe('growToCover', () => {
  it('enlarges to satisfy a floor and preserves aspect', () => {
    expect(growToCover({ width: 100, height: 100 }, 350, 450)).toEqual({ width: 450, height: 450 });
  });

  it('never shrinks', () => {
    expect(growToCover({ width: 4000, height: 3000 }, 100, 100)).toEqual({
      width: 4000,
      height: 3000,
    });
  });
});

describe('planTargetBox', () => {
  it('converts a physical requirement at its stated DPI', () => {
    const { constraint } = parseConstraint('JPEG, 3.5 cm x 4.5 cm, 200 dpi');
    const box = planTargetBox({ width: 3000, height: 4000 }, constraint);

    expect(box.width).toBe(mmToPx(35, 200));
    expect(box.height).toBe(mmToPx(45, 200));
    expect(box.exact).toBe(true);
    expect(box.fit).toBe('cover');
  });

  it('falls back to the default DPI when none is stated', () => {
    const { constraint } = parseConstraint('JPEG, 3.5 cm x 4.5 cm');
    const box = planTargetBox({ width: 3000, height: 4000 }, constraint);
    expect(box.width).toBe(mmToPx(35, DEFAULT_DPI));
  });

  it('uses an exact pixel box when the portal states one', () => {
    const { constraint } = parseConstraint('JPEG, 200 x 230 pixels');
    const box = planTargetBox({ width: 3000, height: 4000 }, constraint);
    expect(box).toMatchObject({ width: 200, height: 230, exact: true, fit: 'cover' });
  });

  it('only shrinks for a maximum bound, preserving aspect', () => {
    const box = planTargetBox({ width: 4000, height: 3000 }, { mime: [], maxW: 800, maxH: 800 });
    expect(box).toMatchObject({ width: 800, height: 600, exact: false, fit: 'contain' });
  });

  it('grows to satisfy a pixel floor', () => {
    const { constraint } = parseConstraint('JPEG, minimum dimensions of 350 x 450 pixels');
    const box = planTargetBox({ width: 175, height: 225 }, constraint);
    expect(box.width).toBeGreaterThanOrEqual(350);
    expect(box.height).toBeGreaterThanOrEqual(450);
  });

  it('keeps the source size when nothing is stated', () => {
    const box = planTargetBox({ width: 1234, height: 567 }, { mime: ['image/jpeg'] });
    expect(box).toMatchObject({ width: 1234, height: 567, scale: 1, exact: false });
  });

  it('reports scale so callers can detect upscaling', () => {
    const down = planTargetBox({ width: 4000, height: 3000 }, { mime: [], maxW: 400 });
    expect(down.scale).toBeLessThan(1);

    const up = planTargetBox({ width: 100, height: 100 }, { mime: [], minW: 400, minH: 400 });
    expect(up.scale).toBeGreaterThan(1);
  });

  it('produces the plan’s worked example: a 4 MB phone photo to 3.5×4.5 cm', () => {
    const { constraint } = parseConstraint('JPEG, 20 KB to 50 KB, 3.5 cm × 4.5 cm');
    const box = planTargetBox({ width: 3024, height: 4032 }, constraint);

    expect(box.width).toBe(276);
    expect(box.height).toBe(354);
    expect(box.scale).toBeLessThan(1); // downscaling a phone photo, as expected
    expect(box.exact).toBe(true);
  });
});

describe('inspectQuality', () => {
  it('warns when the source must be enlarged', () => {
    const source = { width: 100, height: 130 };
    const box = planTargetBox(source, { mime: [], minW: 400, minH: 520 });
    const warnings = inspectQuality(source, box);

    expect(warnings.map((w) => w.code)).toContain('upscaled');
    expect(warnings.find((w) => w.code === 'upscaled')?.message).toMatch(/soft|re-scan/i);
  });

  it('stays quiet when downscaling a good source', () => {
    const source = { width: 3024, height: 4032 };
    const { constraint } = parseConstraint('JPEG, 3.5 cm × 4.5 cm');
    const box = planTargetBox(source, constraint);
    expect(inspectQuality(source, box).map((w) => w.code)).not.toContain('upscaled');
  });

  it('warns when a fixed aspect will crop a lot away', () => {
    // A wide landscape photo forced into a tall passport box.
    const source = { width: 4000, height: 1200 };
    const { constraint } = parseConstraint('JPEG, 3.5 cm × 4.5 cm');
    const box = planTargetBox(source, constraint);

    expect(inspectQuality(source, box).map((w) => w.code)).toContain('heavy-crop');
  });

  it('does not warn about cropping when the aspect already matches', () => {
    const source = { width: 350, height: 450 };
    const { constraint } = parseConstraint('JPEG, 3.5 cm × 4.5 cm');
    const box = planTargetBox(source, constraint);
    expect(inspectQuality(source, box).map((w) => w.code)).not.toContain('heavy-crop');
  });

  it('never produces a message containing a placeholder', () => {
    const source = { width: 50, height: 900 };
    const { constraint } = parseConstraint('JPEG, 3.5 cm × 4.5 cm, 200 dpi');
    for (const warning of inspectQuality(source, planTargetBox(source, constraint))) {
      expect(warning.message).not.toMatch(/undefined|NaN|\[object/);
    }
  });
});
