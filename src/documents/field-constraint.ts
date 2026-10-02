/**
 * What one upload box on a live page asks for.
 *
 * The Phase 2 pipeline can satisfy any `DocConstraint`; this module decides
 * *which* constraint a particular field means, and whether the stored master
 * already satisfies it. Pure, like the rest of `documents/`: strings and
 * numbers in, data out, so it is testable without a browser.
 *
 * The precedence is the product's usual one. A constraint the user taught for
 * this form wins outright. Otherwise the page is read — its label, the hint
 * beside the box, and the box's own `accept` list. Where the page says nothing,
 * nothing is added: `constraints.ts`'s "under-constrain rather than guess" rule
 * applies here too, because a guessed 50 KB cap on a form that allows 10 MB
 * produces a needlessly degraded scan, and nobody would know why.
 */

import type { FieldKey } from '@/matching/taxonomy';
import type { DocConstraint, DocumentMeta } from '@/shared/types';
import { READABLE_SOURCE_MIMES, parseConstraint, shortMime } from './constraints';

/** The formats the derivation pipeline can produce, in its preferred order. */
const PRODUCIBLE = ['image/jpeg', 'image/png', 'application/pdf'] as const;

const ACCEPT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'image/*': ['image/jpeg', 'image/png'],
  'image/jpeg': ['image/jpeg'],
  'image/jpg': ['image/jpeg'],
  'image/pjpeg': ['image/jpeg'],
  'image/png': ['image/png'],
  'application/pdf': ['application/pdf'],
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.jpe': ['image/jpeg'],
  '.jfif': ['image/jpeg'],
  '.png': ['image/png'],
  '.pdf': ['application/pdf'],
};

/**
 * The producible formats an `accept` attribute allows.
 *
 * Empty means "no restriction we can act on": an absent list, a match-all
 * list, or one naming only formats the pipeline could never make (a `.docx`
 * box). The last case is deliberately not an error here — the site's own
 * validator will say so, and inventing a format for it would be a guess.
 */
export function acceptedMimes(accept: string | undefined): string[] {
  if (!accept) return [];
  const found = new Set<string>();
  for (const raw of accept.split(',')) {
    const entry = raw.trim().toLowerCase();
    if (entry === '*' || entry === '*/*') return [];
    for (const mime of ACCEPT_ALIASES[entry] ?? []) found.add(mime);
  }
  return PRODUCIBLE.filter((mime) => found.has(mime));
}

export interface FieldRequirementInput {
  labelText: string;
  /** The hint beside the box — "JPEG, 20–50 KB", "Max 10 MB". */
  requirementText?: string;
  /** The box's own `accept` attribute, verbatim. */
  accept?: string;
  /** A constraint the user taught for this field. Wins outright. */
  taught?: DocConstraint | null;
}

export interface FieldRequirement {
  constraint: DocConstraint;
  /** Where it came from — surfaced so the user can tell a taught rule from a read one. */
  source: 'taught' | 'page' | 'none';
  /** Each clause understood, in words, for the panel to show. */
  matched: string[];
}

export function constraintForField(input: FieldRequirementInput): FieldRequirement {
  if (input.taught) {
    return { constraint: input.taught, source: 'taught', matched: ['taught for this form'] };
  }

  const text = [input.labelText, input.requirementText ?? '']
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join('. ');
  const parsed = parseConstraint(text);
  const constraint: DocConstraint = { ...parsed.constraint };
  const matched = [...parsed.matched];

  /*
   * The box's `accept` list beats the prose when they disagree.
   *
   * Prose is a regex's reading of a hint that may cover several boxes at once
   * ("Photographs in JPEG, certificates in PDF"); `accept` is the portal's
   * machine-readable statement about *this* box. When both name formats and
   * overlap, the overlap is the answer.
   */
  const accepted = acceptedMimes(input.accept);
  if (accepted.length > 0) {
    const overlap = constraint.mime.filter((mime) => accepted.includes(mime));
    const chosen = overlap.length > 0 ? overlap : accepted;
    if (chosen.join() !== constraint.mime.join()) {
      const prose = matched.findIndex((clause) => clause.startsWith('format '));
      if (prose >= 0) matched.splice(prose, 1);
      matched.unshift(`format ${chosen.map(shortMime).join(' or ')} (from the upload box)`);
    }
    constraint.mime = chosen;
  }

  return { constraint, source: matched.length > 0 ? 'page' : 'none', matched };
}

/**
 * Does the stored master already satisfy this constraint as it stands?
 *
 * When it does, it is attached untouched: re-encoding a file that already fits
 * only costs quality, and for a PDF it would mean rasterising a text document
 * into a picture of one. A physical size, an aspect or a DPI always goes
 * through the pipeline, because whether a file "is 3.5 × 4.5 cm" depends on a
 * plan, not on a measurement.
 *
 * Never a locked PDF: whoever opens it on the portal's side has no password.
 * The copy made from it, opened with the password the vault keeps, is an
 * ordinary file.
 */
export function canPassThrough(
  meta: Pick<DocumentMeta, 'mime' | 'bytes' | 'width' | 'height'> & { locked?: true },
  constraint: DocConstraint,
): boolean {
  if (meta.locked === true) return false;
  if (!READABLE_SOURCE_MIMES.has(meta.mime)) return false;
  if (constraint.mime.length > 0 && !constraint.mime.includes(meta.mime)) return false;

  if (constraint.minBytes !== undefined && meta.bytes < constraint.minBytes) return false;
  if (constraint.maxBytes !== undefined && meta.bytes > constraint.maxBytes) return false;

  if (
    constraint.dimensionsMm !== undefined ||
    constraint.aspect !== undefined ||
    constraint.dpi !== undefined
  ) {
    return false;
  }

  const bounded =
    constraint.minW !== undefined ||
    constraint.minH !== undefined ||
    constraint.maxW !== undefined ||
    constraint.maxH !== undefined;
  if (bounded) {
    // Zero means "never measured" (a PDF has no bitmap), not "tiny".
    if (meta.width <= 0 || meta.height <= 0) return false;
    if (constraint.minW !== undefined && meta.width < constraint.minW) return false;
    if (constraint.minH !== undefined && meta.height < constraint.minH) return false;
    if (constraint.maxW !== undefined && meta.width > constraint.maxW) return false;
    if (constraint.maxH !== undefined && meta.height > constraint.maxH) return false;
  }

  return true;
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
};

/**
 * The name the portal sees.
 *
 * Built from the taxonomy key, never from anything the user typed: the
 * original filename is not stored (`document-store.ts`), and a name like
 * `Aadhaar_Ravi_Kumar.jpg` would hand the portal — and anything it logs — a
 * second copy of the person's name for no reason.
 */
export function fileNameFor(key: FieldKey, mime: string): string {
  const base = key.replace(/^doc\./, '').replace(/[^a-z0-9_]+/gi, '_');
  return `${base}.${EXTENSIONS[mime] ?? 'bin'}`;
}
