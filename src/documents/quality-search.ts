/**
 * The binary-search quality loop (§ Phase 2).
 *
 * Given an encoder and a byte window, find a JPEG quality that lands inside it.
 * The encoder is injected, so this — the part with all the tricky logic — is
 * pure control flow and unit-testable with no canvas.
 *
 * Why binary search rather than a fixed quality table: the bytes-per-quality
 * curve depends entirely on image content. A flat scanned signature at q=0.8
 * might be 12 KB while a detailed photograph at the same quality is 180 KB. Any
 * fixed table is wrong for one of them.
 *
 * The search assumes size increases monotonically with quality, which holds for
 * JPEG in practice. It does not assume the curve is smooth, and it always
 * returns the best candidate it actually measured rather than an extrapolation.
 */

export interface ByteWindow {
  minBytes?: number;
  maxBytes?: number;
}

export interface QualityAttempt {
  quality: number;
  bytes: number;
}

export type EncodeAt = (quality: number) => Promise<{ bytes: number; data: Uint8Array }>;

export interface SearchOptions {
  /** Lowest quality worth trying. Below this JPEG artefacts dominate. */
  minQuality?: number;
  maxQuality?: number;
  /** Stop when the bracket is narrower than this. */
  tolerance?: number;
  /** Hard cap on encoder calls — each one is real CPU work. */
  maxIterations?: number;
}

export const DEFAULT_SEARCH: Required<SearchOptions> = {
  minQuality: 0.05,
  maxQuality: 0.98,
  tolerance: 0.01,
  maxIterations: 12,
};

export type SearchOutcome =
  | { ok: true; quality: number; bytes: number; data: Uint8Array; attempts: QualityAttempt[] }
  | { ok: false; reason: UnsatisfiableReason; attempts: QualityAttempt[]; best?: QualityAttempt };

export type UnsatisfiableReason =
  /** Even the lowest quality is bigger than maxBytes — the box is too large. */
  | 'too-large-at-min-quality'
  /** Even the highest quality is smaller than minBytes — the source is too plain. */
  | 'too-small-at-max-quality';

function within(bytes: number, window: ByteWindow): boolean {
  if (window.maxBytes !== undefined && bytes > window.maxBytes) return false;
  if (window.minBytes !== undefined && bytes < window.minBytes) return false;
  return true;
}

/**
 * Search for a quality whose encoded size falls inside `window`.
 *
 * Returns the encoded bytes on success. On failure it reports *which* end of
 * the window could not be reached, which is what lets the caller give the user
 * a real reason ("your photo is too detailed for a 20 KB limit at this size")
 * instead of a generic failure.
 */
export async function searchQuality(
  encode: EncodeAt,
  window: ByteWindow,
  options: SearchOptions = {},
): Promise<SearchOutcome> {
  const { minQuality, maxQuality, tolerance, maxIterations } = { ...DEFAULT_SEARCH, ...options };
  const attempts: QualityAttempt[] = [];

  // No upper bound: encode once at the top and accept, unless a floor fails.
  if (window.maxBytes === undefined) {
    const top = await encode(maxQuality);
    attempts.push({ quality: maxQuality, bytes: top.bytes });
    if (within(top.bytes, window)) {
      return { ok: true, quality: maxQuality, bytes: top.bytes, data: top.data, attempts };
    }
    return {
      ok: false,
      reason: 'too-small-at-max-quality',
      attempts,
      best: { quality: maxQuality, bytes: top.bytes },
    };
  }

  // Probe the ceiling first: most images fit at high quality, so this is
  // usually a one-call success rather than a full search.
  const high = await encode(maxQuality);
  attempts.push({ quality: maxQuality, bytes: high.bytes });
  if (within(high.bytes, window)) {
    return { ok: true, quality: maxQuality, bytes: high.bytes, data: high.data, attempts };
  }

  if (high.bytes < (window.minBytes ?? 0)) {
    // Highest quality is still under the floor. More quality is not available;
    // the caller's remedy is a larger pixel box, not a different quality.
    return {
      ok: false,
      reason: 'too-small-at-max-quality',
      attempts,
      best: { quality: maxQuality, bytes: high.bytes },
    };
  }

  // Ceiling is over the limit. Check the floor before searching between them.
  const low = await encode(minQuality);
  attempts.push({ quality: minQuality, bytes: low.bytes });
  if (low.bytes > window.maxBytes) {
    return {
      ok: false,
      reason: 'too-large-at-min-quality',
      attempts,
      best: { quality: minQuality, bytes: low.bytes },
    };
  }
  // The floor encode is a usable answer if it already fits; the search below
  // only ever replaces it with something larger (and so higher fidelity).
  let best: { quality: number; bytes: number; data: Uint8Array } | null = within(
    low.bytes,
    window,
  )
    ? { quality: minQuality, bytes: low.bytes, data: low.data }
    : null;

  let lo = minQuality;
  let hi = maxQuality;

  for (let i = 0; i < maxIterations && hi - lo > tolerance; i += 1) {
    const mid = (lo + hi) / 2;
    const result = await encode(mid);
    attempts.push({ quality: mid, bytes: result.bytes });

    if (result.bytes > window.maxBytes) {
      hi = mid;
      continue;
    }

    // Under the ceiling. Keep it if it is the best seen so far — "best" means
    // the largest file that still fits, which is the highest fidelity.
    if (!best || result.bytes > best.bytes) {
      best = { quality: mid, bytes: result.bytes, data: result.data };
    }
    lo = mid;

    if (within(result.bytes, window)) {
      // Inside the window on both ends; nothing further to gain.
      if (window.minBytes === undefined) break;
    }
  }

  if (best && within(best.bytes, window)) {
    return { ok: true, quality: best.quality, bytes: best.bytes, data: best.data, attempts };
  }

  // Everything under the ceiling was also under the floor.
  return {
    ok: false,
    reason: 'too-small-at-max-quality',
    attempts,
    ...(best ? { best: { quality: best.quality, bytes: best.bytes } } : {}),
  };
}

/** Human-readable explanation for a failed search — the "fail loudly" path. */
export function explainFailure(
  reason: UnsatisfiableReason,
  window: ByteWindow,
  box: { width: number; height: number },
  best?: QualityAttempt,
): string {
  const dims = `${box.width}×${box.height}`;
  const measured = best ? ` The smallest we could produce was ${formatKb(best.bytes)}.` : '';

  switch (reason) {
    case 'too-large-at-min-quality':
      return (
        `This image cannot be squeezed under ${formatKb(window.maxBytes ?? 0)} at ${dims} pixels ` +
        `without destroying it.${measured} The portal's limit and its required dimensions are ` +
        'hard to satisfy together — try a simpler image, or one with a plain background.'
      );
    case 'too-small-at-max-quality':
      return (
        `This image encodes smaller than the portal's ${formatKb(window.minBytes ?? 0)} minimum ` +
        `even at full quality at ${dims} pixels.${measured} That usually means the source is a ` +
        'low-detail scan. Re-scan at a higher resolution.'
      );
  }
}

function formatKb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}
