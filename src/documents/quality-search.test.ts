import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SEARCH,
  explainFailure,
  searchQuality,
  type EncodeAt,
} from './quality-search';

const KB = 1024;

/**
 * A fake encoder with a controllable bytes-vs-quality curve. This is the whole
 * point of injecting the encoder: the search logic can be driven into every
 * corner — unsatisfiable windows, flat curves, pathological steps — without a
 * canvas and without waiting on real JPEG encoding.
 */
function encoder(curve: (quality: number) => number): EncodeAt & { calls: number[] } {
  const calls: number[] = [];
  const fn = (async (quality: number) => {
    calls.push(quality);
    const bytes = Math.max(1, Math.round(curve(quality)));
    return { bytes, data: new Uint8Array(bytes) };
  }) as EncodeAt & { calls: number[] };
  fn.calls = calls;
  return fn;
}

/** Roughly how JPEG behaves: size grows steeply with quality. */
function jpegLike(atMin: number, atMax: number) {
  return (q: number) => atMin + (atMax - atMin) * Math.pow(q, 2.2);
}

describe('happy paths', () => {
  it('accepts the ceiling immediately when it already fits', async () => {
    const encode = encoder(jpegLike(5 * KB, 40 * KB));
    const result = await searchQuality(encode, { minBytes: 20 * KB, maxBytes: 50 * KB });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quality).toBe(DEFAULT_SEARCH.maxQuality);
    expect(encode.calls).toHaveLength(1);
  });

  it('searches down to land inside a tight window', async () => {
    const encode = encoder(jpegLike(2 * KB, 400 * KB));
    const result = await searchQuality(encode, { minBytes: 20 * KB, maxBytes: 50 * KB });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bytes).toBeGreaterThanOrEqual(20 * KB);
    expect(result.bytes).toBeLessThanOrEqual(50 * KB);
  });

  it('returns bytes matching the reported length', async () => {
    const encode = encoder(jpegLike(2 * KB, 400 * KB));
    const result = await searchQuality(encode, { minBytes: 20 * KB, maxBytes: 50 * KB });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(result.bytes);
  });

  it('prefers the largest file that still fits, for maximum fidelity', async () => {
    const encode = encoder(jpegLike(2 * KB, 400 * KB));
    const result = await searchQuality(encode, { maxBytes: 50 * KB, minBytes: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Should be near the ceiling, not scraping the floor.
    expect(result.bytes).toBeGreaterThan(40 * KB);
  });

  it('handles a maximum with no minimum', async () => {
    const encode = encoder(jpegLike(2 * KB, 400 * KB));
    const result = await searchQuality(encode, { maxBytes: 100 * KB });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bytes).toBeLessThanOrEqual(100 * KB);
  });

  it('encodes once when there is no maximum at all', async () => {
    const encode = encoder(jpegLike(2 * KB, 400 * KB));
    const result = await searchQuality(encode, {});

    expect(result.ok).toBe(true);
    expect(encode.calls).toEqual([DEFAULT_SEARCH.maxQuality]);
  });

  it('satisfies a minimum-only window when the ceiling clears it', async () => {
    const encode = encoder(jpegLike(2 * KB, 400 * KB));
    const result = await searchQuality(encode, { minBytes: 100 * KB });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bytes).toBeGreaterThanOrEqual(100 * KB);
  });
});

describe('unsatisfiable windows — the fail-loudly path', () => {
  it('reports too-large when even minimum quality exceeds the cap', async () => {
    // The plan's example: 20 KB max at 600×800 from a detailed source.
    const encode = encoder(jpegLike(80 * KB, 900 * KB));
    const result = await searchQuality(encode, { maxBytes: 20 * KB });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('too-large-at-min-quality');
    // The best it managed is the floor-quality encode, still far over the cap.
    expect(result.best?.quality).toBe(DEFAULT_SEARCH.minQuality);
    expect(result.best?.bytes).toBeGreaterThan(20 * KB);
  });

  it('reports too-small when even maximum quality is under the floor', async () => {
    const encode = encoder(jpegLike(1 * KB, 8 * KB));
    const result = await searchQuality(encode, { minBytes: 50 * KB, maxBytes: 200 * KB });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('too-small-at-max-quality');
  });

  it('fails rather than returning an out-of-window file', async () => {
    // A curve that jumps straight past the window: nothing lands inside.
    const encode = encoder((q) => (q > 0.5 ? 300 * KB : 5 * KB));
    const result = await searchQuality(encode, { minBytes: 50 * KB, maxBytes: 100 * KB });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('too-small-at-max-quality');
  });

  it('never claims success with bytes outside the window', async () => {
    const curves = [
      jpegLike(1 * KB, 5 * KB),
      jpegLike(500 * KB, 900 * KB),
      (q: number) => (q > 0.7 ? 200 * KB : 2 * KB),
      () => 42 * KB,
    ];
    for (const curve of curves) {
      const result = await searchQuality(encoder(curve), { minBytes: 20 * KB, maxBytes: 50 * KB });
      if (result.ok) {
        expect(result.bytes).toBeGreaterThanOrEqual(20 * KB);
        expect(result.bytes).toBeLessThanOrEqual(50 * KB);
      }
    }
  });
});

describe('search budget', () => {
  it('respects the iteration cap', async () => {
    const encode = encoder(jpegLike(2 * KB, 4000 * KB));
    await searchQuality(encode, { minBytes: 999 * KB, maxBytes: 1000 * KB }, { maxIterations: 4 });
    // Two probes (ceiling, floor) plus at most maxIterations bisections.
    expect(encode.calls.length).toBeLessThanOrEqual(2 + 4);
  });

  it('stops early once the bracket is inside tolerance', async () => {
    const encode = encoder(jpegLike(2 * KB, 4000 * KB));
    await searchQuality(encode, { minBytes: 999 * KB, maxBytes: 1000 * KB }, { tolerance: 0.25 });
    expect(encode.calls.length).toBeLessThan(2 + DEFAULT_SEARCH.maxIterations);
  });

  it('records every attempt for the audit trail', async () => {
    const encode = encoder(jpegLike(2 * KB, 400 * KB));
    const result = await searchQuality(encode, { minBytes: 20 * KB, maxBytes: 50 * KB });
    expect(result.attempts.length).toBe(encode.calls.length);
    expect(result.attempts.every((a) => a.bytes > 0)).toBe(true);
  });

  it('only ever requests qualities inside the configured band', async () => {
    const encode = encoder(jpegLike(2 * KB, 4000 * KB));
    await searchQuality(encode, { minBytes: 999 * KB, maxBytes: 1000 * KB });
    for (const q of encode.calls) {
      expect(q).toBeGreaterThanOrEqual(DEFAULT_SEARCH.minQuality);
      expect(q).toBeLessThanOrEqual(DEFAULT_SEARCH.maxQuality);
    }
  });
});

describe('edge cases', () => {
  it('handles a flat curve that ignores quality', async () => {
    const result = await searchQuality(encoder(() => 30 * KB), {
      minBytes: 20 * KB,
      maxBytes: 50 * KB,
    });
    expect(result.ok).toBe(true);
  });

  it('handles a window with equal min and max', async () => {
    const result = await searchQuality(encoder(() => 30 * KB), {
      minBytes: 30 * KB,
      maxBytes: 30 * KB,
    });
    expect(result.ok).toBe(true);
  });

  it('propagates an encoder failure rather than swallowing it', async () => {
    const boom = vi.fn().mockRejectedValue(new Error('encoder exploded'));
    await expect(searchQuality(boom as unknown as EncodeAt, { maxBytes: 50 * KB })).rejects.toThrow(
      'encoder exploded',
    );
  });
});

describe('explainFailure', () => {
  const box = { width: 600, height: 800 };

  it('names the limit and the measured size when too large', () => {
    const message = explainFailure(
      'too-large-at-min-quality',
      { maxBytes: 20 * KB },
      box,
      { quality: 0.05, bytes: 80 * KB },
    );
    expect(message).toContain('20 KB');
    expect(message).toContain('80 KB');
    expect(message).toContain('600×800');
  });

  it('tells the user to re-scan when the source is too plain', () => {
    const message = explainFailure('too-small-at-max-quality', { minBytes: 50 * KB }, box);
    expect(message).toMatch(/re-scan/i);
    expect(message).toContain('50 KB');
  });

  it('is a complete sentence a non-technical user can act on', () => {
    for (const reason of ['too-large-at-min-quality', 'too-small-at-max-quality'] as const) {
      const message = explainFailure(reason, { minBytes: 20 * KB, maxBytes: 50 * KB }, box);
      expect(message.length).toBeGreaterThan(60);
      expect(message).not.toMatch(/undefined|NaN|\[object/);
    }
  });
});
