import { describe, expect, it } from 'vitest';

import {
  assessMaster,
  blockersIn,
  isUsable,
  roleFor,
  ROLE_TARGETS,
  trimsToInk,
  type IntakeRole,
} from './intake';
import type { DocumentMeta } from '@/shared/types';

function meta(overrides: Partial<DocumentMeta> = {}): DocumentMeta {
  return {
    key: 'doc.photo',
    mime: 'image/jpeg',
    bytes: 400_000,
    width: 800,
    height: 920,
    capturedAt: '2026-08-26T00:00:00.000Z',
    ...overrides,
  };
}

describe('what a photo has to be to survive a portal', () => {
  it('accepts a decent portrait scan', () => {
    expect(assessMaster(meta(), 'photo')).toEqual([]);
  });

  it('rejects one already smaller than the size it will be asked for', () => {
    // The failure this whole module exists for: a 120px-wide photo gets
    // upscaled to 200x230, comes out blurry, and the portal rejects it after
    // the applicant has already paid the fee.
    const found = assessMaster(meta({ width: 120, height: 138 }), 'photo');
    expect(blockersIn(found)).toHaveLength(1);
    expect(found[0]!.message).toMatch(/larger|bigger|small/i);
  });

  it('rejects a landscape photo, which cannot be cropped to a portrait one', () => {
    const found = assessMaster(meta({ width: 1600, height: 900 }), 'photo');
    expect(blockersIn(found).length).toBeGreaterThan(0);
    expect(found.some((f) => /shape|portrait|wider/i.test(f.message))).toBe(true);
  });

  it('rejects a PDF where an image is wanted', () => {
    const found = assessMaster(meta({ mime: 'application/pdf' }), 'photo');
    expect(blockersIn(found).length).toBeGreaterThan(0);
  });

  it('warns about a file already compressed to nothing', () => {
    // 900x1035 in 6 KB is heavy JPEG artefacting. Re-encoding it smaller for a
    // 50 KB portal limit compounds the damage; there is nothing to work with.
    const found = assessMaster(meta({ width: 900, height: 1035, bytes: 6_000 }), 'photo');
    expect(found.some((f) => f.severity === 'warning')).toBe(true);
  });

  it('does not warn about compression when the image is genuinely small', () => {
    // A small image in few bytes is not over-compressed, it is just small —
    // and it already has a blocker. Two complaints for one cause is noise.
    const found = assessMaster(meta({ width: 150, height: 172, bytes: 6_000 }), 'photo');
    expect(found.filter((f) => /quality|compress/i.test(f.message))).toEqual([]);
  });
});

describe('what a signature has to be', () => {
  it('accepts a wide, short strip', () => {
    expect(assessMaster(meta({ key: 'doc.signature', width: 600, height: 200 }), 'signature')).toEqual([]);
  });

  it('rejects a portrait crop, which is not what a signature looks like', () => {
    const found = assessMaster(meta({ key: 'doc.signature', width: 200, height: 600 }), 'signature');
    expect(blockersIn(found).length).toBeGreaterThan(0);
  });

  it('holds a signature to its own size, not the photo one', () => {
    // 400x140 is too small for a photo and fine for a signature. A single
    // threshold for both would reject half the signatures people actually own.
    const asSignature = assessMaster(meta({ key: 'doc.signature', width: 400, height: 140 }), 'signature');
    expect(blockersIn(asSignature)).toEqual([]);
  });
});

describe('documents that are not photos', () => {
  it('accepts a PDF certificate', () => {
    const found = assessMaster(
      meta({ key: 'doc.marksheet_10', mime: 'application/pdf', width: 1240, height: 1754, pages: 2 }),
      'document',
    );
    expect(blockersIn(found)).toEqual([]);
  });

  it('has no opinion about the shape of a scanned certificate', () => {
    const wide = assessMaster(meta({ key: 'doc.marksheet_10', width: 2000, height: 700 }), 'document');
    expect(blockersIn(wide)).toEqual([]);
  });

  it('still rejects one too small to read', () => {
    const found = assessMaster(meta({ key: 'doc.marksheet_10', width: 200, height: 260 }), 'document');
    expect(blockersIn(found).length).toBeGreaterThan(0);
  });
});

describe('the advice itself', () => {
  const roles: IntakeRole[] = ['photo', 'signature', 'thumb', 'document'];

  it('always says what to do, not just what is wrong', () => {
    for (const role of roles) {
      for (const finding of assessMaster(meta({ width: 40, height: 40, bytes: 900 }), role)) {
        expect(finding.remedy, `${role}: ${finding.message}`).not.toBe('');
        expect(finding.remedy.length).toBeGreaterThan(10);
      }
    }
  });

  it('names no filename and no bytes of the document', () => {
    // The findings are rendered in the panel and may reach the audit log.
    // Dimensions and a size in KB are fine; content is not.
    const text = JSON.stringify(assessMaster(meta({ width: 40, height: 40 }), 'photo'));
    expect(text).not.toMatch(/base64|data:|blob:/i);
  });

  it('has a target for every role it accepts', () => {
    for (const role of roles) expect(ROLE_TARGETS[role]).toBeDefined();
  });
});

describe('choosing the rules for a key (§ mutation-testing gap)', () => {
  /**
   * Every test above passes `role` in by hand, so `roleFor` — the function
   * that decides which rules a real upload is held to — was never called.
   * Mutation testing found it: both of its comparisons could be inverted
   * without a failure, which would have held photos to the signature rules and
   * signatures to neither.
   *
   * `isUsable` was in the same position, and it is what the onboarding
   * checklist counts with. An inverted `roleFor` would tell somebody their
   * blurry photo is fine.
   */
  it('holds a photo to the photo rules', () => {
    expect(roleFor('doc.photo')).toBe('photo');
  });

  it('holds a signature to the signature rules', () => {
    expect(roleFor('doc.signature')).toBe('signature');
  });

  it('holds a thumb impression to its own rules, not the signature ones', () => {
    // A thumbprint is roughly square. Judged as a signature it fails the
    // landscape window every time, and the user is told to re-do a scan that
    // was correct.
    expect(roleFor('doc.thumb_impression')).toBe('thumb');
    expect(assessMaster(meta({ key: 'doc.thumb_impression', width: 300, height: 300 }), 'thumb')).toEqual([]);
    expect(blockersIn(assessMaster(meta({ key: 'doc.thumb_impression', width: 300, height: 300 }), 'signature')).length)
      .toBeGreaterThan(0);
  });

  it('treats every other document as a document', () => {
    for (const key of ['doc.marksheet_10', 'doc.marksheet_12', 'doc.aadhaar_card', 'doc.caste_certificate'] as const) {
      expect(roleFor(key), key).toBe('document');
    }
  });

  it('routes each key to rules that actually differ', () => {
    // The mutation is only dangerous because the rule sets disagree. If they
    // ever converged, `roleFor` would stop mattering and so would this test —
    // so assert the disagreement directly.
    expect(ROLE_TARGETS.photo.aspect).not.toEqual(ROLE_TARGETS.signature.aspect);
    expect(ROLE_TARGETS.document.aspect).toBeNull();
  });
});

describe('isUsable, which the checklist counts with', () => {
  const good = (over: Partial<DocumentMeta> = {}): DocumentMeta => meta({ ...over });

  it('accepts a good photo and a good signature', () => {
    expect(isUsable(good())).toBe(true);
    expect(isUsable(good({ key: 'doc.signature', width: 600, height: 200 }))).toBe(true);
  });

  it('rejects a photo that is too small', () => {
    expect(isUsable(good({ width: 100, height: 115 }))).toBe(false);
  });

  it('rejects a photo held to photo rules that would pass as a signature', () => {
    // The exact swap an inverted `roleFor` would cause: 600x200 is a fine
    // signature and a badly shaped photo.
    expect(isUsable(good({ key: 'doc.photo', width: 600, height: 200 }))).toBe(false);
    expect(isUsable(good({ key: 'doc.signature', width: 600, height: 200 }))).toBe(true);
  });

  it('is not swayed by a warning alone', () => {
    // Over-compressed but big enough: advice, not a blocker, and it still
    // counts as an uploaded document.
    expect(isUsable(good({ width: 900, height: 1035, bytes: 6_000 }))).toBe(true);
  });
});

describe('the remedy matches the role, not just the problem', () => {
  it('tells a photo owner to crop to a passport shape', () => {
    const found = assessMaster(meta({ width: 1600, height: 900 }), 'photo');
    expect(found.some((f) => /passport/i.test(f.remedy))).toBe(true);
  });

  it('tells a signature owner to crop away the paper, not to take a passport photo', () => {
    const found = assessMaster(meta({ key: 'doc.signature', width: 200, height: 600 }), 'signature');
    expect(found.some((f) => /wide and short|above and below/i.test(f.remedy))).toBe(true);
    expect(found.some((f) => /passport/i.test(f.remedy))).toBe(false);
  });

  it('gives a portrait-shaped complaint a different remedy from a landscape one', () => {
    const wide = assessMaster(meta({ width: 1600, height: 900 }), 'photo');
    const tall = assessMaster(meta({ key: 'doc.signature', width: 200, height: 600 }), 'signature');
    expect(wide[0]!.remedy).not.toBe(tall[0]!.remedy);
  });
});

/**
 * The reported bug, in one place.
 *
 * A user photographed their signature, cropped it tight, and was told to "crop
 * away the paper above and below it". There was no paper. The signature simply
 * has a tall flourish. The point of these tests is that the extension may only
 * give advice it has evidence for.
 */
describe('shape advice, when the ink has actually been measured', () => {
  // Comfortably above the 280x120 size floor, so the only rule that can fire
  // here is the shape one. Same proportions as the reported image.
  const signature = meta({ key: 'doc.signature', width: 400, height: 514, bytes: 90_000 });

  /** A shape reading for ink filling `w x h` of the given canvas. */
  function shape(w: number, h: number, canvas: { width: number; height: number }) {
    const marginRatio = 1 - (w * h) / (canvas.width * canvas.height);
    return {
      content: { left: 0, top: 0, width: w, height: h },
      contentAspect: w / h,
      canvasAspect: canvas.width / canvas.height,
      marginRatio,
      trimmable: marginRatio >= 0.08,
    };
  }

  it('never tells you to crop paper that is not there', () => {
    const tight = shape(388, 502, { width: 400, height: 514 });
    const found = assessMaster(signature, 'signature', tight);

    for (const finding of found) {
      expect(finding.remedy).not.toMatch(/crop away the paper/i);
    }
  });

  /**
   * A real signature, photographed on plain paper: 720x640, ink 210x230, so
   * about 0.91 wide-to-tall. Two rounds of this were reported as a false
   * alarm, and both times the extension was measuring something other than
   * the signature or judging it against a window no ordinary signature meets.
   */
  it('says nothing about the shape of an ordinary compact signature', () => {
    const compact = shape(210, 230, { width: 720, height: 640 });
    const found = assessMaster(
      meta({ key: 'doc.signature', width: 720, height: 640, bytes: 22_000 }),
      'signature',
      compact,
    );

    expect(found.filter((f) => /taller than it is wide/i.test(f.message))).toEqual([]);
    expect(blockersIn(found)).toHaveLength(0);
  });

  it('mentions the blank paper as a note, not as a complaint', () => {
    const compact = shape(210, 230, { width: 720, height: 640 });
    const found = assessMaster(
      meta({ key: 'doc.signature', width: 720, height: 640, bytes: 22_000 }),
      'signature',
      compact,
    );

    expect(found).toHaveLength(1);
    // Nothing is wrong; the user is being told what will happen to their file.
    expect(found[0]!.severity).toBe('note');
    expect(found[0]!.message).toMatch(/blank space/i);
    expect(found[0]!.remedy).toMatch(/nothing to do/i);
  });

  it('still warns about something genuinely pathological', () => {
    // A column: ink fifteen times taller than it is wide. Not a signature.
    const column = shape(40, 600, { width: 400, height: 640 });
    const found = assessMaster(
      meta({ key: 'doc.signature', width: 400, height: 640, bytes: 30_000 }),
      'signature',
      column,
    );

    const shapeFindings = found.filter((f) => /taller than it is wide/i.test(f.message));
    expect(shapeFindings).toHaveLength(1);
    expect(shapeFindings[0]!.severity).toBe('warning');
    expect(shapeFindings[0]!.remedy).toMatch(/sign again/i);
    // Never the advice that started all this.
    expect(shapeFindings[0]!.remedy).not.toMatch(/crop away the paper/i);
  });

  it('keeps quiet when the frame is tight and the shape is right', () => {
    const strip = shape(390, 145, { width: 400, height: 150 });
    const found = assessMaster(
      meta({ key: 'doc.signature', width: 400, height: 150, bytes: 40_000 }),
      'signature',
      strip,
    );
    expect(found).toEqual([]);
  });

  it('falls back to the old canvas rule when nothing was measured', () => {
    // Documents stored before this existed carry no reading, and must keep
    // behaving exactly as they did.
    const found = assessMaster(signature, 'signature');
    expect(blockersIn(found)).toHaveLength(1);
    expect(found[0]!.remedy).toMatch(/crop away the paper/i);
  });

  it('applies the same honesty to a portrait photo', () => {
    const tall = shape(480, 1380, { width: 500, height: 1400 });
    const found = assessMaster(
      meta({ width: 500, height: 1400, bytes: 600_000 }),
      'photo',
      tall,
    );
    expect(blockersIn(found)).toHaveLength(0);
    expect(found.some((f) => /passport shape/i.test(f.remedy))).toBe(true);
  });
});

/**
 * Files whose pixels could not be read.
 *
 * Every rule in this module measures a bitmap, so a file that never became one
 * arrives with zero dimensions. The original code let that fall through into
 * the size check and reported "0x0 pixels, which is too small" — a complaint
 * about the wrong thing, with a remedy that cannot be followed, on the two
 * formats people most often have: an iPhone HEIC and a PDF certificate.
 */
describe('files that could not be read at all', () => {
  it('explains a HEIC instead of calling it too small', () => {
    const found = assessMaster(
      meta({ key: 'doc.marksheet_12', mime: 'image/heic', width: 0, height: 0, bytes: 1_469_440 }),
      'document',
    );

    expect(found).toHaveLength(1);
    expect(found[0]!.message).not.toMatch(/0×0|too small/i);
    expect(found[0]!.message).toMatch(/HEIC/);
    // The remedy has to be something the user can actually do today.
    expect(found[0]!.remedy).toMatch(/Most Compatible|share/i);
  });

  it('names other formats it cannot open', () => {
    const found = assessMaster(
      meta({ key: 'doc.caste_certificate', mime: 'image/tiff', width: 0, height: 0 }),
      'document',
    );
    expect(found[0]!.message).toMatch(/TIFF/);
    expect(found[0]!.message).not.toMatch(/too small/i);
  });

  it('does not tell a PDF certificate it is 0x0 pixels', () => {
    // The most common format a certificate arrives in. It has no bitmap, and
    // `rasterisePdf` settles its size at derivation time.
    const found = assessMaster(
      meta({ key: 'doc.degree_certificate', mime: 'application/pdf', width: 0, height: 0 }),
      'document',
    );
    expect(found).toEqual([]);
  });

  it('still refuses a PDF where an image is required, and only says that once', () => {
    const found = assessMaster(
      meta({ key: 'doc.photo', mime: 'application/pdf', width: 0, height: 0 }),
      'photo',
    );

    expect(found).toHaveLength(1);
    expect(found[0]!.message).toMatch(/PDF/);
    expect(found[0]!.message).not.toMatch(/too small/i);
  });

  it('distinguishes a corrupt JPEG from an unsupported format', () => {
    const found = assessMaster(
      meta({ mime: 'image/jpeg', width: 0, height: 0 }),
      'photo',
    );
    expect(found[0]!.message).toMatch(/could not be opened/i);
    expect(found[0]!.remedy).toMatch(/incomplete or renamed/i);
  });
});

describe('what a derivation may trim (§ test portal)', () => {
  /*
   * Found on a test portal that asked for a JPEG between 20 and 200 KB and
   * nothing about shape. The photo already fitted, and needed at most a
   * re-encode — but it came out with the top of the head cut off. The
   * derivation had trimmed it "to its ink", the way a scanned certificate is
   * trimmed of blank paper. A photograph has no blank paper: the background
   * above the head is part of what the portal asked for, and on a light wall
   * the top of somebody's hair reads as margin.
   */
  it('never trims a photograph', () => {
    expect(trimsToInk('photo')).toBe(false);
  });

  it('still trims the paper around a signature, a thumbprint and a scanned certificate', () => {
    expect(trimsToInk('signature')).toBe(true);
    expect(trimsToInk('thumb')).toBe(true);
    expect(trimsToInk('document')).toBe(true);
  });
});
