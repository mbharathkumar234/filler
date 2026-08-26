import { describe, expect, it } from 'vitest';

import { assessMaster, blockersIn, isUsable, roleFor, ROLE_TARGETS, type IntakeRole } from './intake';
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
  const roles: IntakeRole[] = ['photo', 'signature', 'document'];

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
