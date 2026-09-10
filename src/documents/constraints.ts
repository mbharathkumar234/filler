/**
 * Portal document-constraint parsing (§ Phase 2).
 *
 * Portals state their upload rules as prose: "Photograph must be JPEG/JPG,
 * 20 KB to 50 KB, 3.5 cm × 4.5 cm." This module turns that prose into a
 * `DocConstraint` the derivation pipeline can satisfy.
 *
 * Design rules:
 *
 *  - **Pure and total.** No DOM, no I/O, never throws. Unparseable text yields
 *    a constraint with fewer fields, not an exception.
 *  - **Under-constrain rather than guess.** A field we are not confident about
 *    is left undefined. A wrong `maxBytes` produces a file the portal rejects;
 *    a missing one just means we keep the source size. The first failure is
 *    silent and confusing, the second is visible and fixable.
 *  - **Report what was recognised.** `matched` drives the UI's "we read this as
 *    …" confirmation, so the user can catch a misparse before upload.
 */

import type { DocConstraint } from '@/shared/types';

export type { DocConstraint };

export interface ParsedConstraint {
  constraint: DocConstraint;
  /** Human-readable summary of each clause understood, for UI confirmation. */
  matched: string[];
  /** True when nothing at all was recognised. */
  empty: boolean;
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

const KB = 1024;
const MB = 1024 * 1024;

/**
 * Portals mean KiB when they write KB — a "50 KB" limit is enforced by a
 * validator that almost always read 51200 from a config file. Using 1000 here
 * would silently produce files a few hundred bytes over the real limit.
 */
function toBytes(value: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith('mb')) return Math.round(value * MB);
  if (u.startsWith('kb')) return Math.round(value * KB);
  return Math.round(value);
}

function mmFrom(value: number, unit: string): number {
  return unit.toLowerCase().startsWith('cm') ? value * 10 : value;
}

// ---------------------------------------------------------------------------
// MIME
// ---------------------------------------------------------------------------

const MIME_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(jpe?g)\b/gi, 'image/jpeg'],
  [/\bpng\b/gi, 'image/png'],
  [/\bpdf\b/gi, 'application/pdf'],
];

function parseMime(text: string): string[] {
  const found = new Set<string>();
  for (const [pattern, mime] of MIME_ALIASES) {
    if (new RegExp(pattern.source, 'i').test(text)) found.add(mime);
  }
  // Stable, predictable order — image types before PDF.
  const order = ['image/jpeg', 'image/png', 'application/pdf'];
  return order.filter((m) => found.has(m));
}

// ---------------------------------------------------------------------------
// Byte windows
// ---------------------------------------------------------------------------

const SIZE_UNIT = '(kb|kilobytes?|mb|megabytes?|bytes?)';

/** "between 20 KB and 50 KB", "20 KB to 50 KB", "20KB-50KB", "20 to 50 KB". */
const RANGE_PATTERNS: RegExp[] = [
  new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${SIZE_UNIT}\\s*(?:-|–|to|and|until)\\s*(\\d+(?:\\.\\d+)?)\\s*${SIZE_UNIT}`, 'i'),
  new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:-|–|to|and)\\s*(\\d+(?:\\.\\d+)?)\\s*${SIZE_UNIT}`, 'i'),
];

const MAX_PATTERNS: RegExp[] = [
  new RegExp(`(?:max(?:imum)?|not\\s+(?:be\\s+)?(?:more|greater|larger|bigger)\\s+than|no\\s+more\\s+than|(?<!not\\s)(?<!not\\sbe\\s)(?<!no\\s)less\\s+than|under|upto|up\\s+to|(?:should|must|shall)\\s+not\\s+(?:be\\s+)?exceed|not\\s+exceed(?:ing)?|within|below)\\D{0,20}?(\\d+(?:\\.\\d+)?)\\s*${SIZE_UNIT}`, 'i'),
  new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${SIZE_UNIT}\\s*(?:max(?:imum)?|or\\s+less|at\\s+most)`, 'i'),
];

const MIN_PATTERNS: RegExp[] = [
  new RegExp(`(?:min(?:imum)?|(?:should|must|shall)?\\s*not\\s+(?:be\\s+)?less\\s+than|no\\s+less\\s+than|at\\s+least|greater\\s+than|more\\s+than|above)\\D{0,20}?(\\d+(?:\\.\\d+)?)\\s*${SIZE_UNIT}`, 'i'),
  new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${SIZE_UNIT}\\s*(?:min(?:imum)?|or\\s+more|at\\s+least)`, 'i'),
];

interface ByteWindow {
  minBytes?: number;
  maxBytes?: number;
  notes: string[];
}

function parseBytes(text: string): ByteWindow {
  const notes: string[] = [];

  for (const pattern of RANGE_PATTERNS) {
    const m = pattern.exec(text);
    if (!m) continue;
    // The two-group form shares one trailing unit ("20 to 50 KB").
    const hasTwoUnits = m.length > 4;
    const lo = Number(m[1]);
    const loUnit = hasTwoUnits ? m[2]! : m[3]!;
    const hi = Number(hasTwoUnits ? m[3] : m[2]);
    const hiUnit = m[hasTwoUnits ? 4 : 3]!;

    const minBytes = toBytes(lo, loUnit);
    const maxBytes = toBytes(hi, hiUnit);
    if (minBytes <= maxBytes) {
      notes.push(`size between ${describeBytes(minBytes)} and ${describeBytes(maxBytes)}`);
      return { minBytes, maxBytes, notes };
    }
  }

  const window: ByteWindow = { notes };

  for (const pattern of MAX_PATTERNS) {
    const m = pattern.exec(text);
    if (m) {
      window.maxBytes = toBytes(Number(m[1]), m[2]!);
      notes.push(`at most ${describeBytes(window.maxBytes)}`);
      break;
    }
  }

  for (const pattern of MIN_PATTERNS) {
    const m = pattern.exec(text);
    if (m) {
      const value = toBytes(Number(m[1]), m[2]!);
      // Guard against a "minimum" clause that actually re-matched the maximum.
      if (window.maxBytes === undefined || value < window.maxBytes) {
        window.minBytes = value;
        notes.push(`at least ${describeBytes(value)}`);
      }
      break;
    }
  }

  return window;
}

export function describeBytes(bytes: number): string {
  if (bytes >= MB) return `${(bytes / MB).toFixed(bytes % MB === 0 ? 0 : 1)} MB`;
  if (bytes >= KB) return `${Math.round(bytes / KB)} KB`;
  return `${bytes} bytes`;
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

const X = '(?:x|×|\\*|by)';

/** "3.5 cm x 4.5 cm", "35mm × 45mm", "3.5 x 4.5 cm". */
const PHYSICAL_PATTERNS: RegExp[] = [
  new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(cm|mm)\\s*${X}\\s*(\\d+(?:\\.\\d+)?)\\s*(cm|mm)`, 'i'),
  new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${X}\\s*(\\d+(?:\\.\\d+)?)\\s*(cm|mm)`, 'i'),
];

/** "200 x 230 pixels", "350x450 px". */
const PIXEL_PATTERN = new RegExp(`(\\d{2,5})\\s*${X}\\s*(\\d{2,5})\\s*(?:px|pixels?)`, 'i');

/** "width 3.5 cm, height 4.5 cm" — stated separately. */
const WIDTH_PATTERN = /width\s*(?:of|:|=)?\s*(\d+(?:\.\d+)?)\s*(cm|mm)/i;
const HEIGHT_PATTERN = /height\s*(?:of|:|=)?\s*(\d+(?:\.\d+)?)\s*(cm|mm)/i;

const DPI_PATTERN = /(\d{2,4})\s*(?:dpi|ppi)/i;

interface Dimensions {
  dimensionsMm?: [number, number];
  minW?: number;
  minH?: number;
  maxW?: number;
  maxH?: number;
  dpi?: number;
  notes: string[];
}

function parsePhysical(text: string): [number, number] | undefined {
  for (const pattern of PHYSICAL_PATTERNS) {
    const m = pattern.exec(text);
    if (!m) continue;
    const hasTwoUnits = m.length > 4;
    const w = Number(m[1]);
    const wUnit = hasTwoUnits ? m[2]! : m[3]!;
    const h = Number(hasTwoUnits ? m[3] : m[2]);
    const hUnit = m[hasTwoUnits ? 4 : 3]!;
    return [mmFrom(w, wUnit), mmFrom(h, hUnit)];
  }

  const w = WIDTH_PATTERN.exec(text);
  const h = HEIGHT_PATTERN.exec(text);
  if (w && h) {
    return [mmFrom(Number(w[1]), w[2]!), mmFrom(Number(h[1]), h[2]!)];
  }
  return undefined;
}

function parseDimensions(text: string): Dimensions {
  const notes: string[] = [];
  const out: Dimensions = { notes };

  const physical = parsePhysical(text);
  if (physical) {
    out.dimensionsMm = physical;
    notes.push(`${physical[0]} mm × ${physical[1]} mm`);
  }

  const px = PIXEL_PATTERN.exec(text);
  if (px) {
    const w = Number(px[1]);
    const h = Number(px[2]);
    // "minimum dimensions of 350 x 450 pixels" is a floor, not an exact size.
    if (/\b(min(?:imum)?|at\s+least|not\s+less\s+than)\b/i.test(text)) {
      out.minW = w;
      out.minH = h;
      notes.push(`at least ${w} × ${h} px`);
    } else if (/\b(max(?:imum)?|not\s+(?:more|greater)\s+than|up\s+to)\b/i.test(text)) {
      out.maxW = w;
      out.maxH = h;
      notes.push(`at most ${w} × ${h} px`);
    } else {
      out.minW = w;
      out.minH = h;
      out.maxW = w;
      out.maxH = h;
      notes.push(`exactly ${w} × ${h} px`);
    }
  }

  const dpi = DPI_PATTERN.exec(text);
  if (dpi) {
    out.dpi = Number(dpi[1]);
    notes.push(`${out.dpi} DPI`);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parse portal instruction text into a `DocConstraint`.
 *
 * Never throws. Anything not confidently recognised is simply absent from the
 * result — see the "under-constrain rather than guess" rule above.
 */
export function parseConstraint(text: string): ParsedConstraint {
  const normalised = text.replace(/\s+/g, ' ').trim();

  const mime = parseMime(normalised);
  const bytes = parseBytes(normalised);
  const dims = parseDimensions(normalised);

  const constraint: DocConstraint = { mime };
  if (bytes.minBytes !== undefined) constraint.minBytes = bytes.minBytes;
  if (bytes.maxBytes !== undefined) constraint.maxBytes = bytes.maxBytes;
  if (dims.minW !== undefined) constraint.minW = dims.minW;
  if (dims.minH !== undefined) constraint.minH = dims.minH;
  if (dims.maxW !== undefined) constraint.maxW = dims.maxW;
  if (dims.maxH !== undefined) constraint.maxH = dims.maxH;
  if (dims.dimensionsMm !== undefined) constraint.dimensionsMm = dims.dimensionsMm;
  if (dims.dpi !== undefined) constraint.dpi = dims.dpi;

  if (constraint.dimensionsMm) {
    const [w, h] = constraint.dimensionsMm;
    if (h > 0) constraint.aspect = w / h;
  } else if (constraint.minW && constraint.minH && constraint.minW === constraint.maxW) {
    constraint.aspect = constraint.minW / constraint.minH;
  }

  const matched = [
    ...(mime.length > 0 ? [`format ${mime.map(shortMime).join(' or ')}`] : []),
    ...bytes.notes,
    ...dims.notes,
  ];

  return { constraint, matched, empty: matched.length === 0 };
}

/**
 * The source formats the derivation pipeline can actually open.
 *
 * Deliberately the *pipeline's* answer rather than the browser's. Chrome will
 * happily decode WebP and AVIF into a bitmap, but `derive.ts` refuses them as a
 * source, so treating them as readable here would move the failure from intake
 * — where the user still has the original — to derivation, where they no longer
 * do. That is the exact inversion this module exists to prevent.
 */
export const READABLE_SOURCE_MIMES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'application/pdf',
]);

/**
 * Formats we can *name* but not open.
 *
 * Naming matters. "We could not read that file" invites the user to try the
 * same file again; "we cannot read HEIC" tells them what to change.
 */
const UNREADABLE_LABELS: Readonly<Record<string, string>> = {
  'image/heic': 'HEIC',
  'image/heic-sequence': 'HEIC',
  'image/heif': 'HEIF',
  'image/heif-sequence': 'HEIF',
  'image/tiff': 'TIFF',
  'image/avif': 'AVIF',
  'image/webp': 'WebP',
  'image/bmp': 'BMP',
  'image/gif': 'GIF',
};

/** A human name for a format we cannot read, or null if we do not know it. */
export function unreadableFormatLabel(mime: string): string | null {
  return UNREADABLE_LABELS[mime.toLowerCase()] ?? null;
}

const EXTENSION_MIMES: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  pdf: 'application/pdf',
  heic: 'image/heic',
  heif: 'image/heif',
  hif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  avif: 'image/avif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  gif: 'image/gif',
};

/**
 * Guess a type from a filename.
 *
 * Needed because a browser does not always know. Windows reports no MIME type
 * at all for `.heic` unless an OS codec is registered, so the file arrives as
 * an empty string — and a file with no type cannot be explained to the user,
 * only shrugged at. The extension is the last thing that still says what it is.
 *
 * Only ever used as a *fallback*: a type the browser supplies is better
 * evidence than a name anybody can rename.
 */
export function mimeFromFilename(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return null;
  return EXTENSION_MIMES[name.slice(dot + 1).toLowerCase()] ?? null;
}

export function shortMime(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
      return 'JPEG';
    case 'image/png':
      return 'PNG';
    case 'application/pdf':
      return 'PDF';
    default:
      return mime;
  }
}

/** One-line human summary, for the review screen and the document editor. */
export function describeConstraint(constraint: DocConstraint): string {
  const parts: string[] = [];
  if (constraint.mime.length > 0) parts.push(constraint.mime.map(shortMime).join('/'));

  if (constraint.minBytes !== undefined && constraint.maxBytes !== undefined) {
    parts.push(`${describeBytes(constraint.minBytes)}–${describeBytes(constraint.maxBytes)}`);
  } else if (constraint.maxBytes !== undefined) {
    parts.push(`≤ ${describeBytes(constraint.maxBytes)}`);
  } else if (constraint.minBytes !== undefined) {
    parts.push(`≥ ${describeBytes(constraint.minBytes)}`);
  }

  if (constraint.dimensionsMm) {
    const [w, h] = constraint.dimensionsMm;
    parts.push(`${w / 10} × ${h / 10} cm`);
  } else if (constraint.minW && constraint.minH) {
    const exact = constraint.minW === constraint.maxW && constraint.minH === constraint.maxH;
    parts.push(`${exact ? '' : '≥ '}${constraint.minW} × ${constraint.minH} px`);
  }

  if (constraint.dpi !== undefined) parts.push(`${constraint.dpi} DPI`);

  return parts.length > 0 ? parts.join(', ') : 'no stated requirements';
}

/** Stable key for the variant cache: same constraint ⇒ same string. */
export function canonicalise(constraint: DocConstraint): string {
  return JSON.stringify({
    mime: [...constraint.mime].sort(),
    minBytes: constraint.minBytes ?? null,
    maxBytes: constraint.maxBytes ?? null,
    minW: constraint.minW ?? null,
    minH: constraint.minH ?? null,
    maxW: constraint.maxW ?? null,
    maxH: constraint.maxH ?? null,
    aspect: constraint.aspect ?? null,
    dimensionsMm: constraint.dimensionsMm ?? null,
    dpi: constraint.dpi ?? null,
  });
}
