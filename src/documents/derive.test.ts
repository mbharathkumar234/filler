import { describe, expect, it, vi } from 'vitest';
import { chooseOutputMime, derive, describeDerivation, type RasterBackend, type RasterSource } from './derive';
import { parseConstraint } from './constraints';
import { mmToPx } from './geometry';

const KB = 1024;

/**
 * A fake raster backend. It models size-vs-quality without encoding anything,
 * which is what keeps this whole suite DOM-free (§6.1) and fast enough to run
 * on every save.
 */
interface CallCounts {
  decode: number;
  resize: number;
  encodeJpeg: number;
  encodePng: number;
  rasterisePdf: number;
  wrapJpegInPdf: number;
  release: number;
}

function fakeBackend(
  overrides: Partial<RasterBackend> & { curve?: (q: number, px: number) => number } = {},
): RasterBackend & { calls: CallCounts } {
  const calls: CallCounts = {
    decode: 0,
    resize: 0,
    encodeJpeg: 0,
    encodePng: 0,
    rasterisePdf: 0,
    wrapJpegInPdf: 0,
    release: 0,
  };
  // Bytes scale with pixel count and with quality, as JPEG does.
  const curve = overrides.curve ?? ((q: number, px: number) => px * (0.02 + 0.5 * Math.pow(q, 2.2)));

  const backend: RasterBackend & { calls: CallCounts } = {
    calls,
    async decode(_bytes, _mime) {
      calls.decode += 1;
      return { width: 3024, height: 4032, handle: 'decoded' };
    },
    async resize(_source, box) {
      calls.resize += 1;
      return { width: box.width, height: box.height, handle: 'resized' };
    },
    async encodeJpeg(source, quality) {
      calls.encodeJpeg += 1;
      const size = Math.max(1, Math.round(curve(quality, source.width * source.height)));
      return new Uint8Array(size);
    },
    async encodePng(source) {
      calls.encodePng += 1;
      return new Uint8Array(source.width * source.height * 3);
    },
    async rasterisePdf(_bytes, targetWidth) {
      calls.rasterisePdf += 1;
      return { width: targetWidth, height: Math.round(targetWidth * 1.414), handle: 'pdf' };
    },
    async wrapJpegInPdf(jpeg) {
      calls.wrapJpegInPdf += 1;
      return new Uint8Array(jpeg.length + 1200);
    },
    release() {
      calls.release += 1;
    },
    ...overrides,
  };
  return backend;
}

const SOURCE = new Uint8Array(4 * 1024 * 1024); // a 4 MB "phone photo"

describe('chooseOutputMime', () => {
  it('prefers JPEG, the only format with a quality dial', () => {
    expect(chooseOutputMime({ mime: ['image/jpeg', 'image/png'] }, 'image/png')).toBe('image/jpeg');
  });

  it('falls back to PNG only when JPEG is not allowed', () => {
    expect(chooseOutputMime({ mime: ['image/png'] }, 'image/jpeg')).toBe('image/png');
  });

  it('uses PDF when the portal demands it', () => {
    expect(chooseOutputMime({ mime: ['application/pdf'] }, 'image/jpeg')).toBe('application/pdf');
  });

  it('keeps the source format when the portal states none', () => {
    expect(chooseOutputMime({ mime: [] }, 'image/png')).toBe('image/png');
  });

  it('honours an explicit preference inside the allowed set', () => {
    expect(
      chooseOutputMime({ mime: ['image/jpeg', 'application/pdf'] }, 'image/jpeg', 'application/pdf'),
    ).toBe('application/pdf');
  });

  it('ignores a preference the portal does not allow', () => {
    expect(chooseOutputMime({ mime: ['image/jpeg'] }, 'image/jpeg', 'application/pdf')).toBe(
      'image/jpeg',
    );
  });

  it('returns null when nothing can be produced', () => {
    expect(chooseOutputMime({ mime: ['image/tiff'] }, 'image/jpeg')).toBeNull();
  });
});

describe('the plan’s worked example', () => {
  const { constraint } = parseConstraint(
    'Photograph must be JPEG/JPG, 20 KB to 50 KB, 3.5 cm × 4.5 cm.',
  );

  it('takes a 4 MB photo to a compliant 20–50 KB, 3.5×4.5 cm JPEG', async () => {
    const backend = fakeBackend();
    const result = await derive(backend, SOURCE, 'image/jpeg', constraint);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.mime).toBe('image/jpeg');
    expect(result.width).toBe(mmToPx(35, 200));
    expect(result.height).toBe(mmToPx(45, 200));
    expect(result.bytes.length).toBeGreaterThanOrEqual(20 * KB);
    expect(result.bytes.length).toBeLessThanOrEqual(50 * KB);
  });

  it('crops rather than distorts, because the physical size fixes the aspect', async () => {
    const result = await derive(fakeBackend(), SOURCE, 'image/jpeg', constraint);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fit).toBe('cover');
  });

  it('reports the quality it settled on', async () => {
    const result = await derive(fakeBackend(), SOURCE, 'image/jpeg', constraint);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quality).toBeGreaterThan(0);
    expect(result.quality).toBeLessThanOrEqual(1);
  });

  it('records the attempts it made', async () => {
    const result = await derive(fakeBackend(), SOURCE, 'image/jpeg', constraint);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempts.length).toBeGreaterThan(0);
  });
});

describe('failing loudly', () => {
  it('refuses an unsatisfiable window with a specific, actionable reason', async () => {
    // The plan's example: 20 KB max at 600×800 from a detailed source.
    const backend = fakeBackend({ curve: (_q, px) => px * 0.5 });
    const { constraint } = parseConstraint('JPEG, maximum 20 KB, 600 x 800 pixels');

    const result = await derive(backend, SOURCE, 'image/jpeg', constraint);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unsatisfiable-size');
    expect(result.reason).toContain('20 KB');
    expect(result.reason).toContain('600×800');
    expect(result.reason).not.toMatch(/undefined|NaN/);
  });

  it('refuses a source format it cannot read', async () => {
    const result = await derive(fakeBackend(), SOURCE, 'image/tiff', {
      mime: ['image/jpeg'],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unsupported-source');
    expect(result.reason).toMatch(/JPEG, PNG, or PDF/);
  });

  it('refuses when no allowed output format can be produced', async () => {
    const result = await derive(fakeBackend(), SOURCE, 'image/jpeg', { mime: ['image/tiff'] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('no-acceptable-format');
  });

  it('turns a decode failure into a readable message, not a crash', async () => {
    const backend = fakeBackend({
      decode: vi.fn().mockRejectedValue(new Error('invalid marker')),
    });
    const result = await derive(backend, SOURCE, 'image/jpeg', { mime: ['image/jpeg'] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('decode-failed');
    expect(result.reason).toMatch(/corrupt/i);
  });

  it('explains that PNG has no quality dial when a PNG cap is impossible', async () => {
    const { constraint } = parseConstraint('PNG only, maximum 30 KB, 3.5 cm x 4.5 cm');
    const result = await derive(fakeBackend(), SOURCE, 'image/png', constraint);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/no quality setting/i);
  });
});

describe('PDF paths', () => {
  it('rasterises a PDF source before deriving an image', async () => {
    const backend = fakeBackend();
    const { constraint } = parseConstraint('JPEG, max 200 KB');
    const result = await derive(backend, SOURCE, 'application/pdf', constraint);

    expect(backend.calls.rasterisePdf).toBe(1);
    expect(backend.calls.decode).toBe(0);
    expect(result.ok).toBe(true);
  });

  it('wraps a JPEG into a PDF when the portal demands PDF', async () => {
    const backend = fakeBackend();
    const { constraint } = parseConstraint('PDF only, maximum 500 KB');
    const result = await derive(backend, SOURCE, 'image/jpeg', constraint);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mime).toBe('application/pdf');
    expect(backend.calls.wrapJpegInPdf).toBe(1);
  });

  it('leaves headroom so the PDF container overhead still fits the cap', async () => {
    const backend = fakeBackend();
    const { constraint } = parseConstraint('PDF only, maximum 50 KB, 3.5 cm x 4.5 cm');
    const result = await derive(backend, SOURCE, 'image/jpeg', constraint);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The JPEG search targets 48 KB; the container's ~1.2 KB must still fit.
    expect(result.bytes.length).toBeLessThanOrEqual(50 * KB);
    expect(result.bytes.length).toBeGreaterThan(48 * KB - 2 * KB);
  });

  it('fails loudly when a tight cap is stated with no dimension limit', async () => {
    // A full-resolution phone photo genuinely cannot be a 50 KB PDF. The right
    // behaviour is to say so, not to silently ship something over the limit.
    const { constraint } = parseConstraint('PDF only, maximum 50 KB');
    const result = await derive(fakeBackend(), SOURCE, 'image/jpeg', constraint);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unsatisfiable-size');
  });
});

describe('quality warnings', () => {
  it('warns when the master is too small for the required size', async () => {
    const backend = fakeBackend({
      async decode() {
        return { width: 90, height: 120, handle: 'tiny' } as RasterSource;
      },
    });
    const { constraint } = parseConstraint('JPEG, 20 KB to 50 KB, 3.5 cm × 4.5 cm');
    const result = await derive(backend, SOURCE, 'image/jpeg', constraint);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.map((w) => w.code)).toContain('upscaled');
  });

  it('produces no warnings for a good downscale', async () => {
    const { constraint } = parseConstraint('JPEG, 20 KB to 50 KB, 3.5 cm × 4.5 cm');
    const result = await derive(fakeBackend(), SOURCE, 'image/jpeg', constraint);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
  });
});

describe('resource handling', () => {
  it('releases raster sources even when derivation fails', async () => {
    const backend = fakeBackend({ curve: (_q, px) => px * 0.5 });
    const { constraint } = parseConstraint('JPEG, maximum 20 KB, 600 x 800 pixels');
    await derive(backend, SOURCE, 'image/jpeg', constraint);
    expect(backend.calls.release).toBeGreaterThan(0);
  });

  it('skips the resize when the source is already the target size', async () => {
    const backend = fakeBackend({
      async decode() {
        return { width: 276, height: 354, handle: 'exact' } as RasterSource;
      },
    });
    const { constraint } = parseConstraint('JPEG, 20 KB to 50 KB, 3.5 cm × 4.5 cm');
    await derive(backend, SOURCE, 'image/jpeg', constraint);
    expect(backend.calls.resize).toBe(0);
  });
});

describe('describeDerivation', () => {
  it('states what was produced against what was required', async () => {
    const { constraint } = parseConstraint('JPEG, 20 KB to 50 KB, 3.5 cm × 4.5 cm');
    const result = await derive(fakeBackend(), SOURCE, 'image/jpeg', constraint);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const text = describeDerivation(result, constraint);
    expect(text).toMatch(/^JPEG, \d+ KB, 276×354 px/);
    expect(text).toContain('required: JPEG, 20 KB–50 KB, 3.5 × 4.5 cm');
  });
});
