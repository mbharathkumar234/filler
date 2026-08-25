import { describe, expect, it } from 'vitest';
import {
  canonicalise,
  describeBytes,
  describeConstraint,
  parseConstraint,
} from './constraints';

/**
 * §7 Session 3 asks for "10 real constraint strings". None were supplied with
 * the plan, so this corpus is written from the instruction-text patterns these
 * portals use — passport-photo windows, KB ranges, cm dimensions, PDF caps.
 *
 * **Replace these with verbatim text as real portal fixtures are captured.**
 * A parser tuned against invented phrasing is only as good as the phrasing was
 * representative, and that is not something this test can prove on its own.
 */
const KB = 1024;

interface Case {
  label: string;
  text: string;
  expect: {
    mime?: string[];
    minBytes?: number;
    maxBytes?: number;
    dimensionsMm?: [number, number];
    minW?: number;
    minH?: number;
    dpi?: number;
  };
}

const CORPUS: Case[] = [
  {
    label: '1. passport photo, KB range + cm dimensions',
    text: 'Photograph must be a recent passport size colour picture in JPEG/JPG format, size between 20 KB and 50 KB, dimensions 3.5 cm x 4.5 cm.',
    expect: {
      mime: ['image/jpeg'],
      minBytes: 20 * KB,
      maxBytes: 50 * KB,
      dimensionsMm: [35, 45],
    },
  },
  {
    label: '2. signature, JPG only, × separator',
    text: 'Scanned signature should be in JPG format only. File size must be between 10 KB and 20 KB. Dimensions 3.5 cm × 1.5 cm.',
    expect: {
      mime: ['image/jpeg'],
      minBytes: 10 * KB,
      maxBytes: 20 * KB,
      dimensionsMm: [35, 15],
    },
  },
  {
    label: '3. dotted extensions, exceed/not-less-than, exact pixels',
    text: 'Upload your photograph in .jpg/.jpeg format. The file size should not exceed 100 KB and should not be less than 4 KB. Image dimensions: 200 x 230 pixels.',
    expect: {
      mime: ['image/jpeg'],
      minBytes: 4 * KB,
      maxBytes: 100 * KB,
      minW: 200,
      minH: 230,
    },
  },
  {
    label: '4. PDF certificate with an MB cap',
    text: 'Certificate must be uploaded as a PDF file of maximum 2 MB.',
    expect: { mime: ['application/pdf'], maxBytes: 2 * 1024 * KB },
  },
  {
    label: '5. either PDF or JPEG',
    text: 'Aadhaar card copy: PDF or JPEG, maximum size 500 KB.',
    expect: { mime: ['image/jpeg', 'application/pdf'], maxBytes: 500 * KB },
  },
  {
    label: '6. DPI stated alongside a min/max pair',
    text: 'Photo: JPEG, 200 DPI, minimum 20 KB, maximum 50 KB.',
    expect: { mime: ['image/jpeg'], minBytes: 20 * KB, maxBytes: 50 * KB, dpi: 200 },
  },
  {
    label: '7. PNG or JPEG, "not more than"',
    text: 'Signature image in PNG or JPEG format, not more than 30 KB.',
    expect: { mime: ['image/jpeg', 'image/png'], maxBytes: 30 * KB },
  },
  {
    label: '8. parenthesised max/min shorthand',
    text: 'Upload marksheet (PDF only, max 1 MB, min 50 KB).',
    expect: { mime: ['application/pdf'], minBytes: 1024 * KB > 0 ? 50 * KB : 0, maxBytes: 1024 * KB },
  },
  {
    label: '9. hyphenated range, width/height stated separately, dpi',
    text: 'Photograph: file type JPG, file size 20KB-50KB, width 3.5 cm, height 4.5 cm, resolution 200 dpi.',
    expect: {
      mime: ['image/jpeg'],
      minBytes: 20 * KB,
      maxBytes: 50 * KB,
      dimensionsMm: [35, 45],
      dpi: 200,
    },
  },
  {
    label: '10. minimum pixel dimensions, not exact',
    text: 'The image should be in JPEG format with a file size between 50 KB and 300 KB and minimum dimensions of 350 x 450 pixels.',
    expect: { mime: ['image/jpeg'], minBytes: 50 * KB, maxBytes: 300 * KB, minW: 350, minH: 450 },
  },
  {
    label: '11. "up to" phrasing',
    text: 'Caste certificate — PDF, up to 200 KB.',
    expect: { mime: ['application/pdf'], maxBytes: 200 * KB },
  },
  {
    label: '12. the plan’s own example, mm units',
    text: 'Photograph must be JPEG/JPG, 20 KB to 50 KB, 35mm × 45mm.',
    expect: {
      mime: ['image/jpeg'],
      minBytes: 20 * KB,
      maxBytes: 50 * KB,
      dimensionsMm: [35, 45],
    },
  },
];

describe('parseConstraint over the corpus', () => {
  it.each(CORPUS)('$label', ({ text, expect: want }) => {
    const { constraint, empty } = parseConstraint(text);
    expect(empty).toBe(false);

    if (want.mime) expect(constraint.mime).toEqual(want.mime);
    if (want.minBytes !== undefined) expect(constraint.minBytes).toBe(want.minBytes);
    if (want.maxBytes !== undefined) expect(constraint.maxBytes).toBe(want.maxBytes);
    if (want.dimensionsMm) expect(constraint.dimensionsMm).toEqual(want.dimensionsMm);
    if (want.minW !== undefined) expect(constraint.minW).toBe(want.minW);
    if (want.minH !== undefined) expect(constraint.minH).toBe(want.minH);
    if (want.dpi !== undefined) expect(constraint.dpi).toBe(want.dpi);
  });

  it('recognises at least one clause in every corpus entry', () => {
    for (const { text, label } of CORPUS) {
      expect(parseConstraint(text).matched.length, label).toBeGreaterThan(0);
    }
  });

  it('never produces a window where the minimum exceeds the maximum', () => {
    for (const { text, label } of CORPUS) {
      const { constraint } = parseConstraint(text);
      if (constraint.minBytes !== undefined && constraint.maxBytes !== undefined) {
        expect(constraint.minBytes, label).toBeLessThanOrEqual(constraint.maxBytes);
      }
    }
  });
});

describe('min/max phrasing', () => {
  it('reads a bare "less than" as a maximum', () => {
    expect(parseConstraint('JPEG, file size less than 500 KB').constraint.maxBytes).toBe(500 * KB);
  });

  it('does not mistake "not less than" for a maximum', () => {
    const { constraint } = parseConstraint('JPEG, size should not be less than 4 KB');
    expect(constraint.minBytes).toBe(4 * KB);
    expect(constraint.maxBytes).toBeUndefined();
  });

  it('separates the two clauses when both appear', () => {
    const { constraint } = parseConstraint(
      'The file size should not exceed 100 KB and should not be less than 4 KB.',
    );
    expect(constraint.minBytes).toBe(4 * KB);
    expect(constraint.maxBytes).toBe(100 * KB);
  });

  it.each([
    ['must not exceed 80 KB', 80 * KB],
    ['should not be more than 80 KB', 80 * KB],
    ['no more than 80 KB', 80 * KB],
    ['80 KB maximum', 80 * KB],
    ['upto 80 KB', 80 * KB],
    ['within 80 KB', 80 * KB],
  ])('reads %s as a maximum', (text, want) => {
    expect(parseConstraint(`JPEG, ${text}`).constraint.maxBytes).toBe(want);
  });

  it.each([
    ['at least 8 KB', 8 * KB],
    ['minimum 8 KB', 8 * KB],
    ['no less than 8 KB', 8 * KB],
    ['8 KB or more', 8 * KB],
  ])('reads %s as a minimum', (text, want) => {
    expect(parseConstraint(`JPEG, ${text}`).constraint.minBytes).toBe(want);
  });
});

describe('units', () => {
  it('reads KB as KiB, matching the validators portals actually run', () => {
    expect(parseConstraint('max 50 KB').constraint.maxBytes).toBe(51200);
    expect(parseConstraint('max 1 MB').constraint.maxBytes).toBe(1048576);
  });

  it('handles decimal sizes', () => {
    expect(parseConstraint('maximum 1.5 MB').constraint.maxBytes).toBe(Math.round(1.5 * 1024 * 1024));
  });

  it('converts cm to mm', () => {
    expect(parseConstraint('3.5 cm x 4.5 cm').constraint.dimensionsMm).toEqual([35, 45]);
    expect(parseConstraint('35 mm x 45 mm').constraint.dimensionsMm).toEqual([35, 45]);
  });
});

describe('aspect ratio', () => {
  it('derives aspect from physical dimensions', () => {
    const { constraint } = parseConstraint('JPEG, 3.5 cm x 4.5 cm');
    expect(constraint.aspect).toBeCloseTo(35 / 45, 5);
  });

  it('derives aspect from exact pixel dimensions', () => {
    const { constraint } = parseConstraint('JPEG, 200 x 230 pixels');
    expect(constraint.aspect).toBeCloseTo(200 / 230, 5);
  });

  it('does not derive aspect from a pixel floor', () => {
    const { constraint } = parseConstraint('JPEG, minimum dimensions of 350 x 450 pixels');
    expect(constraint.aspect).toBeUndefined();
  });
});

describe('under-constraining rather than guessing', () => {
  it('returns an empty result for text with no requirements', () => {
    const result = parseConstraint('Please upload a clear copy of the document.');
    expect(result.empty).toBe(true);
    expect(result.constraint.mime).toEqual([]);
    expect(result.constraint.maxBytes).toBeUndefined();
  });

  it('leaves dimensions undefined when only a size is stated', () => {
    const { constraint } = parseConstraint('JPEG, max 50 KB.');
    expect(constraint.dimensionsMm).toBeUndefined();
    expect(constraint.minW).toBeUndefined();
  });

  it('never throws on hostile or malformed input', () => {
    const inputs = ['', '   ', 'KB KB KB', '999999999999999999 MB', 'x × x', '3.5 cm x', '<script>'];
    for (const input of inputs) {
      expect(() => parseConstraint(input), input).not.toThrow();
    }
  });

  it('is stable under whitespace and line breaks', () => {
    const a = parseConstraint('JPEG,\n  20 KB to 50 KB,\t3.5 cm x 4.5 cm');
    const b = parseConstraint('JPEG, 20 KB to 50 KB, 3.5 cm x 4.5 cm');
    expect(canonicalise(a.constraint)).toBe(canonicalise(b.constraint));
  });
});

describe('matched clauses', () => {
  it('reports each recognised clause for UI confirmation', () => {
    const { matched } = parseConstraint(
      'Photograph must be JPEG/JPG, 20 KB to 50 KB, 3.5 cm x 4.5 cm, 200 dpi.',
    );
    expect(matched.join(' | ')).toMatch(/JPEG/);
    expect(matched.join(' | ')).toMatch(/20 KB/);
    expect(matched.join(' | ')).toMatch(/35 mm/);
    expect(matched.join(' | ')).toMatch(/200 DPI/);
  });
});

describe('describeConstraint', () => {
  it('summarises a full constraint in one line', () => {
    const { constraint } = parseConstraint('JPEG, 20 KB to 50 KB, 3.5 cm x 4.5 cm, 200 dpi');
    expect(describeConstraint(constraint)).toBe('JPEG, 20 KB–50 KB, 3.5 × 4.5 cm, 200 DPI');
  });

  it('summarises a bare maximum', () => {
    const { constraint } = parseConstraint('PDF, max 2 MB');
    expect(describeConstraint(constraint)).toBe('PDF, ≤ 2 MB');
  });

  it('says so when nothing is required', () => {
    expect(describeConstraint({ mime: [] })).toBe('no stated requirements');
  });
});

describe('canonicalise', () => {
  it('is stable regardless of mime order', () => {
    const a = canonicalise({ mime: ['image/png', 'image/jpeg'] });
    const b = canonicalise({ mime: ['image/jpeg', 'image/png'] });
    expect(a).toBe(b);
  });

  it('distinguishes constraints that differ in any field', () => {
    const base = { mime: ['image/jpeg'], maxBytes: 50 * KB };
    expect(canonicalise(base)).not.toBe(canonicalise({ ...base, maxBytes: 51 * KB }));
    expect(canonicalise(base)).not.toBe(canonicalise({ ...base, dpi: 200 }));
  });
});

describe('describeBytes', () => {
  it('formats KB and MB the way portals write them', () => {
    expect(describeBytes(20 * KB)).toBe('20 KB');
    expect(describeBytes(2 * 1024 * KB)).toBe('2 MB');
    expect(describeBytes(512)).toBe('512 bytes');
  });
});
