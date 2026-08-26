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

export type IntakeRole = 'photo' | 'signature' | 'document';

export type Severity = 'blocker' | 'warning';

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
  /** Acceptable width÷height, or null where any shape is fine. */
  aspect: { min: number; max: number } | null;
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
    noun: 'photo',
  },
  signature: {
    minWidth: 280,
    minHeight: 120,
    aspect: { min: 1.4, max: 6.0 },
    noun: 'signature',
  },
  document: {
    // A certificate has to stay legible; shape is whatever the paper was.
    minWidth: 600,
    minHeight: 600,
    aspect: null,
    noun: 'document',
  },
};

/** Which set of rules applies to this taxonomy key. */
export function roleFor(key: FieldKey): IntakeRole {
  if (key === 'doc.photo') return 'photo';
  if (key === 'doc.signature') return 'signature';
  return 'document';
}

/**
 * Below this many bytes per pixel, a JPEG is already carrying visible
 * artefacts. Re-encoding it to meet a smaller limit compounds them.
 */
const MIN_BYTES_PER_PIXEL = 0.02;

export function assessMaster(meta: DocumentMeta, role: IntakeRole): IntakeFinding[] {
  const target = ROLE_TARGETS[role];
  const findings: IntakeFinding[] = [];

  // A PDF cannot be cropped to a headshot, and every portal that wants a photo
  // wants an image. For a certificate it is the normal case.
  if (meta.mime === 'application/pdf' && role !== 'document') {
    findings.push({
      severity: 'blocker',
      message: `This is a PDF, and the form needs an image for your ${target.noun}.`,
      remedy: `Save or export the ${target.noun} as a JPEG or PNG and upload that instead.`,
    });
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
    const ratio = meta.width / meta.height;
    if (ratio > target.aspect.max) {
      findings.push({
        severity: 'blocker',
        message: `This ${target.noun} is the wrong shape — it is much wider than it is tall.`,
        remedy:
          role === 'photo'
            ? 'Crop it to a passport shape, taller than it is wide, with your face filling most of the frame.'
            : `Crop it closer to the ${target.noun} itself.`,
      });
    } else if (ratio < target.aspect.min) {
      findings.push({
        severity: 'blocker',
        message: `This ${target.noun} is the wrong shape — it is much taller than it is wide.`,
        remedy:
          role === 'signature'
            ? 'A signature strip should be wide and short. Crop away the paper above and below it.'
            : 'Crop it to a passport shape, a little taller than it is wide.',
      });
    }
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

export function blockersIn(findings: readonly IntakeFinding[]): IntakeFinding[] {
  return findings.filter((f) => f.severity === 'blocker');
}

/** Is this stored document good enough to derive from? */
export function isUsable(meta: DocumentMeta): boolean {
  return blockersIn(assessMaster(meta, roleFor(meta.key))).length === 0;
}
