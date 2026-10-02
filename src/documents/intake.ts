/**
 * Upload-time quality checks (§ Phase F).
 *
 *   "Onboarding: … document upload with quality checks …"
 *
 * ## The failure this prevents
 *
 * `derive.ts` is very good at hitting a portal's stated limit — it will get a
 * photo under 50 KB at 200×230 whatever you give it. That is the problem. Feed
 * it a 120px thumbnail and it returns a compliant file that is *visibly
 * blurry*, the portal accepts the upload, and a human rejects the application
 * weeks later. Feed it a landscape holiday snap and it returns a compliant
 * photo of somebody's shoulder.
 *
 * Neither is a bug in derivation. Nothing downstream can recover detail that
 * was never captured, so the only place to catch it is here, at intake, while
 * the user still has the original and can take another picture.
 *
 * ## Blocker vs warning
 *
 * A blocker means the derived file will be rejected or useless, and the user
 * should replace the source. A warning means it will probably pass but is
 * worse than it needs to be. Nothing here refuses an upload on the user's
 * behalf — P1 says the user is present, and they may know something we do not
 * (a portal that really does want a landscape image). It tells them, plainly,
 * before the cost lands.
 *
 * Pure, and free of any browser API, so the rules are testable directly.
 */

import type { DocumentMeta } from '@/shared/types';
import type { FieldKey } from '@/matching/taxonomy';
import type { ShapeReading } from './trim';
import { READABLE_SOURCE_MIMES, unreadableFormatLabel } from './constraints';

export type IntakeRole = 'photo' | 'signature' | 'thumb' | 'document';

/**
 * `blocker` — the derived file will be rejected or useless; replace the source.
 * `warning` — it will probably pass, but it is worse than it needs to be.
 * `note`    — nothing is wrong. Something non-obvious will happen (a crop, a
 *             letterbox) and the user should not be surprised by it.
 *
 * The third exists because the alternative was dressing "we will trim the
 * blank paper for you" as a warning, and a product that shouts at you for
 * uploading a perfectly good signature teaches you to ignore it when it is
 * right.
 */
export type Severity = 'blocker' | 'warning' | 'note';

export interface IntakeFinding {
  severity: Severity;
  /** What is wrong, in the user's terms. */
  message: string;
  /** What to do about it. Never empty — a complaint without a remedy is noise. */
  remedy: string;
}

interface RoleTarget {
  /**
   * The largest output a portal is likely to demand. A master below this can
   * only be upscaled, and upscaling is the blur.
   */
  minWidth: number;
  minHeight: number;
  /**
   * Acceptable width÷height of the *canvas*, or null where any shape is fine.
   *
   * Used only when the ink could not be measured. It has to be strict, because
   * judging a canvas is guessing: a portrait canvas is the one clue available
   * that somebody uploaded a whole sheet of paper.
   */
  aspect: { min: number; max: number } | null;
  /**
   * Acceptable width÷height of the *ink*, once it has been measured.
   *
   * Deliberately far wider than `aspect`, because measuring changes what the
   * number means. A portrait canvas might be a whole sheet of paper; portrait
   * *ink* is just a signature that is taller than it is wide, which is an
   * enormously common way for a person to sign their name. The strict window
   * was catching real signatures and telling their owners to sign differently.
   *
   * What remains here is a guard against the genuinely pathological — a
   * column of text, a whole page whose margins were already trimmed off — and
   * nothing narrower, since the output is letterboxed rather than cut off.
   */
  inkAspect: { min: number; max: number } | null;
  /** Human name for the messages. */
  noun: string;
}

/**
 * Sized from what Indian portals actually ask for, with headroom.
 *
 * Photos cluster at 200×230 and signatures at 140×60; asking for roughly 2×
 * that leaves room to downscale, which is the direction that preserves detail.
 * The aspect windows are wide on purpose — they are meant to catch a landscape
 * photo or a portrait signature, not to police a few degrees of crop.
 */
export const ROLE_TARGETS: Readonly<Record<IntakeRole, RoleTarget>> = {
  photo: {
    minWidth: 400,
    minHeight: 460,
    aspect: { min: 0.6, max: 1.05 },
    // A photograph fills its frame, so the ink box is the frame. Measuring
    // does not tell us anything new here, and the window stays as it was.
    inkAspect: { min: 0.6, max: 1.05 },
    noun: 'photo',
  },
  signature: {
    minWidth: 280,
    minHeight: 120,
    aspect: { min: 1.4, max: 6.0 },
    inkAspect: { min: 0.45, max: 10 },
    noun: 'signature',
  },
  thumb: {
    /*
     * A thumb impression is a signature's sibling, not a signature.
     *
     * Portals ask for it at much the same size, but the ink is a print: about
     * as tall as it is wide, and a signature's landscape window would reject
     * every correct one. The floor is lower than a signature's for the same
     * reason — a thumbprint is a smaller mark, so a smaller scan of it is
     * still all the detail there is.
     */
    minWidth: 200,
    minHeight: 200,
    aspect: { min: 0.5, max: 2.0 },
    inkAspect: { min: 0.4, max: 2.5 },
    noun: 'thumb impression',
  },
  document: {
    // A certificate has to stay legible; shape is whatever the paper was.
    minWidth: 600,
    minHeight: 600,
    aspect: null,
    inkAspect: null,
    noun: 'document',
  },
};

/** Which set of rules applies to this taxonomy key. */
export function roleFor(key: FieldKey): IntakeRole {
  if (key === 'doc.photo') return 'photo';
  if (key === 'doc.signature') return 'signature';
  if (key === 'doc.thumb_impression') return 'thumb';
  return 'document';
}

/**
 * Whether a derivation may trim this document down to where its ink is.
 *
 * Right for anything drawn on paper — a signature, a thumbprint, a scanned
 * certificate — where the margin really is blank and the portal's box should
 * be planned against what is written. Wrong for a photograph, which has no
 * blank paper: the background above the head is part of what a portal asks
 * for, and on a light wall the top of somebody's hair reads as margin. A test
 * portal that asked only for a JPEG of 20–200 KB received a photo with the
 * top of the head cut off, for exactly that reason.
 */
export function trimsToInk(role: IntakeRole): boolean {
  return role !== 'photo';
}

/**
 * Below this many bytes per pixel, a JPEG is already carrying visible
 * artefacts. Re-encoding it to meet a smaller limit compounds them.
 */
const MIN_BYTES_PER_PIXEL = 0.02;

export function assessMaster(
  meta: DocumentMeta,
  role: IntakeRole,
  /**
   * The ink's measured shape, when the caller has one. Optional because
   * documents stored before this existed have none, and because the
   * measurement can legitimately fail on a blank scan.
   */
  shape?: ShapeReading | null,
): IntakeFinding[] {
  const target = ROLE_TARGETS[role];
  const findings: IntakeFinding[] = [];

  /*
   * A PDF has no pixels to judge.
   *
   * Every rule below this point measures a bitmap, and a PDF is not one:
   * `createImageBitmap` cannot open it, so its width and height arrive as
   * zero. Falling through meant a perfectly good PDF certificate was told it
   * was "0x0 pixels, which is too small" — advice that cannot be followed,
   * about the most common format a certificate comes in.
   *
   * Its real page size is settled at derivation, where `rasterisePdf` renders
   * it at whatever the portal asked for.
   */
  if (meta.mime === 'application/pdf') {
    // A PDF cannot be cropped to a headshot, and every portal that wants a
    // photo wants an image. For a certificate it is the normal case.
    if (role !== 'document') {
      findings.push({
        severity: 'blocker',
        message: `This is a PDF, and the form needs an image for your ${target.noun}.`,
        remedy: `Save or export the ${target.noun} as a JPEG or PNG and upload that instead.`,
      });
    }
    return findings;
  }

  /*
   * Nothing could be measured, so nothing below can be judged.
   *
   * This is what a HEIC photograph from an iPhone looks like by the time it
   * reaches here: Chrome ships no HEIC decoder, `createImageBitmap` rejects,
   * and the dimensions default to zero. The old code then reported it as a
   * tiny image. The file is not tiny — it is unreadable, which is a different
   * problem with a different answer.
   */
  if (meta.width <= 0 || meta.height <= 0) {
    return [unreadableFinding(meta.mime, target)];
  }

  const tooSmall = meta.width < target.minWidth || meta.height < target.minHeight;
  if (tooSmall) {
    findings.push({
      severity: 'blocker',
      message:
        `This ${target.noun} is ${meta.width}×${meta.height} pixels, which is too small. ` +
        `Making it fit a form would stretch it and it would look blurry.`,
      remedy: `Upload one at least ${target.minWidth}×${target.minHeight} pixels — a photo straight from a phone camera is comfortably larger.`,
    });
  }

  if (target.aspect !== null && meta.height > 0) {
    findings.push(...assessShape(meta, role, target, shape));
  }

  // Only worth saying when the pixels are otherwise fine. A small image in few
  // bytes is not over-compressed, it is small — and it already has a blocker.
  const pixels = meta.width * meta.height;
  if (!tooSmall && pixels > 0 && meta.bytes / pixels < MIN_BYTES_PER_PIXEL) {
    findings.push({
      severity: 'warning',
      message: `This ${target.noun} has already been compressed heavily, so it may look rough once a form shrinks it further.`,
      remedy: 'If you still have the original, upload that instead of a copy sent over chat.',
    });
  }

  return findings;
}

/**
 * Judge an image's shape, using the ink rather than the canvas where possible.
 *
 * ## Why this is not one comparison
 *
 * The old rule compared `width / height` against a window and, on a miss, told
 * the user to crop. That advice has a hidden premise: that the canvas is bigger
 * than the content, so cropping can change the ratio. When somebody has already
 * cropped tight — which is what a careful user does — the premise is false and
 * the instruction is impossible to follow. A blocker you cannot clear is worse
 * than no blocker, because it says the fault is yours.
 *
 * With a measured content box there are three distinct situations, and they
 * deserve three different sentences:
 *
 *  1. **The canvas is wrong, the ink is right.** Margins. Genuinely croppable,
 *     and we crop it ourselves at derive time, so this is a note and not a
 *     complaint.
 *  2. **The ink itself is out of the window.** The signature really is that
 *     shape. Cropping cannot help, so it is a *warning* — the file still
 *     derives, letterboxed onto the page colour — and the remedy talks about
 *     signing again rather than about cropping.
 *  3. **No measurement.** Fall back to the canvas and the original wording,
 *     which is all the old code could ever do.
 */
function assessShape(
  meta: DocumentMeta,
  role: IntakeRole,
  target: RoleTarget,
  shape?: ShapeReading | null,
): IntakeFinding[] {
  const aspect = target.aspect;
  if (aspect === null) return [];

  const canvasRatio = meta.width / meta.height;
  const withinCanvas = canvasRatio >= aspect.min && canvasRatio <= aspect.max;

  // (3) Nothing measured — the pre-existing behaviour, unchanged.
  if (!shape) {
    return withinCanvas ? [] : [canvasFinding(canvasRatio, role, target, 'blocker')];
  }

  // Measured ink is judged against the wider window; see `inkAspect`.
  const window = target.inkAspect ?? aspect;
  const inkRatio = shape.contentAspect;
  const withinInk = inkRatio >= window.min && inkRatio <= window.max;

  if (withinInk) {
    // (1) The content is a shape we are happy with; only the framing is off.
    if (withinCanvas || !shape.trimmable) return [];
    return [
      {
        severity: 'note',
        message: `Most of this picture is blank space around the ${target.noun}.`,
        remedy: `Nothing to do — it is cropped to the ${target.noun} automatically when a form asks for it.`,
      },
    ];
  }

  // (2) The ink is genuinely out of the window. Say so without blaming a crop.
  return [shapeFinding(inkRatio, role, target, shape.trimmable)];
}

/** The original wording, kept for the case where nothing was measured. */
function canvasFinding(
  ratio: number,
  role: IntakeRole,
  target: RoleTarget,
  severity: Severity,
): IntakeFinding {
  const tooWide = ratio > target.aspect!.max;
  return {
    severity,
    message: `This ${target.noun} is the wrong shape — it is much ${tooWide ? 'wider than it is tall' : 'taller than it is wide'}.`,
    remedy: tooWide
      ? role === 'photo'
        ? 'Crop it to a passport shape, taller than it is wide, with your face filling most of the frame.'
        : `Crop it closer to the ${target.noun} itself.`
      : role === 'signature'
        ? 'A signature strip should be wide and short. Crop away the paper above and below it.'
        : 'Crop it to a passport shape, a little taller than it is wide.',
  };
}

/**
 * The ink is the wrong shape, and we know it, so the message says what was
 * actually measured and the remedy is something the user can do.
 */
function shapeFinding(
  ratio: number,
  role: IntakeRole,
  target: RoleTarget,
  trimmable: boolean,
): IntakeFinding {
  const tooWide = ratio > (target.inkAspect ?? target.aspect!).max;
  const measured = trimmable
    ? `even ignoring the blank space around it`
    : `and there is no blank space left to crop`;

  if (role === 'signature') {
    return {
      severity: 'warning',
      message: `This signature is taller than it is wide, ${measured}. Most forms want a short, wide strip.`,
      remedy:
        'It will still be used — it is placed on the page colour rather than cut off. ' +
        'For a closer fit, sign again along a single line and photograph just that.',
    };
  }

  if (role === 'photo') {
    return {
      severity: 'warning',
      message: `This photo is ${tooWide ? 'much wider than it is tall' : 'much taller than it is wide'}, ${measured}.`,
      remedy: tooWide
        ? 'A passport photo is a little taller than it is wide. Retake or re-crop it with your face filling most of the frame.'
        : 'Re-crop it closer to a passport shape, with your face filling most of the frame.',
    };
  }

  return {
    severity: 'warning',
    message: `This ${target.noun} is an unusual shape, ${measured}.`,
    remedy: `Check that the whole ${target.noun} is in the picture and nothing important is cut off.`,
  };
}

/**
 * Explain a file we could not open, as specifically as the evidence allows.
 *
 * The remedy is the whole point of this function. "Try a different file" is
 * not a remedy — the user has one file, and it is this one. For HEIC, which is
 * what an iPhone produces by default and therefore the case that actually
 * happens, there are two concrete routes and both are worth spelling out.
 */
function unreadableFinding(mime: string, target: RoleTarget): IntakeFinding {
  const label = unreadableFormatLabel(mime);

  if (label === 'HEIC' || label === 'HEIF') {
    return {
      severity: 'blocker',
      message: `This is a ${label} photo, and browsers cannot open ${label}. Your ${target.noun} has not been read.`,
      remedy:
        'On an iPhone, open the photo in Photos and share it to Files or Mail — it is converted ' +
        'to JPEG on the way out. To stop it happening again: Settings → Camera → Formats → Most Compatible.',
    };
  }

  if (label !== null) {
    return {
      severity: 'blocker',
      message: `This is a ${label} file, which cannot be used for a form upload.`,
      remedy: `Open it and save a copy as JPEG or PNG, then upload that.`,
    };
  }

  if (READABLE_SOURCE_MIMES.has(mime)) {
    // A format we do support, that still would not open: a truncated download,
    // a renamed file, a genuinely corrupt image.
    return {
      severity: 'blocker',
      message: `This file could not be opened as an image, although its name says it is one.`,
      remedy: 'It may be incomplete or renamed. Try the original file, or open it and re-save it as a JPEG.',
    };
  }

  return {
    severity: 'blocker',
    message: `This file is not in a format a form can accept.`,
    remedy: `Upload your ${target.noun} as a JPEG, a PNG, or a PDF.`,
  };
}

export function blockersIn(findings: readonly IntakeFinding[]): IntakeFinding[] {
  return findings.filter((f) => f.severity === 'blocker');
}

/**
 * Is this stored document good enough to derive from?
 *
 * No shape reading is passed: this asks about the *stored* file, and a caller
 * that has measured the ink can pass it to `assessMaster` directly. Since a
 * shape mismatch is now a warning rather than a blocker, the answer no longer
 * turns on it either way.
 */
export function isUsable(meta: DocumentMeta): boolean {
  return blockersIn(assessMaster(meta, roleFor(meta.key))).length === 0;
}
