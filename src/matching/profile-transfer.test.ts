import { describe, expect, it } from 'vitest';

import {
  exportProfiles,
  importProfiles,
  TRANSFER_FORMAT,
  TRANSFER_VERSION,
} from './profile-transfer';
import type { SiteProfile } from '@/shared/types';
import type { FieldKey } from './taxonomy';

/**
 * Sharing profiles.
 *
 * An imported profile is a file from a stranger telling this extension where to
 * type someone's Aadhaar. Almost every test here is about what that file is
 * *not* allowed to talk the extension into.
 */

function profile(over: Partial<SiteProfile> = {}): SiteProfile {
  return {
    siteId: 'learned:portal.example.gov.in:abc123',
    version: 2,
    matchUrl: 'https://portal.example.gov.in/*',
    formFingerprint: 'fp-abc',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastVerifiedAt: '2026-08-01T00:00:00.000Z',
    fields: [
      { key: 'identity.full_name' as FieldKey, selectors: ['#txtName'], confidence: 1, source: 'taught' },
      { key: 'id.aadhaar' as FieldKey, selectors: ['#txtUID'], confidence: 1, source: 'taught' },
    ],
    documents: [],
    submit: { selectors: ['#btnSubmit'], label: 'Submit' },
    blockers: [],
    ...over,
  };
}

function roundTrip(input: SiteProfile[]): ReturnType<typeof importProfiles> {
  return importProfiles(exportProfiles(input));
}

describe('exporting', () => {
  it('writes a labelled, versioned bundle', () => {
    const bundle = JSON.parse(exportProfiles([profile()])) as Record<string, unknown>;

    expect(bundle.format).toBe(TRANSFER_FORMAT);
    expect(bundle.version).toBe(TRANSFER_VERSION);
    expect(Array.isArray(bundle.profiles)).toBe(true);
  });

  it('contains selectors and keys, and nothing that could be a value', () => {
    // The plan's own condition on ever sharing these: "selectors only, never
    // values". A profile has never held a value, and this asserts that a
    // future field cannot start travelling by accident.
    const text = exportProfiles([profile()]);
    const names = propertyNames(JSON.parse(text));

    for (const name of names) {
      expect(name, `an exported profile must not carry "${name}"`).not.toMatch(
        /^(value|values|bytes|filename|passphrase|secret|apikey)$/i,
      );
    }
    expect(text).toContain('id.aadhaar');
    expect(text).toContain('#txtUID');
  });
});

describe('importing something well-formed', () => {
  it('round-trips the mappings', () => {
    const { profiles, rejected } = roundTrip([profile()]);

    expect(rejected).toEqual([]);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.fields.map((f) => f.key)).toEqual(['identity.full_name', 'id.aadhaar']);
    expect(profiles[0]?.fields[0]?.selectors).toEqual(['#txtName']);
  });

  it('keeps the identity of the form it describes', () => {
    const { profiles } = roundTrip([profile()]);
    expect(profiles[0]).toMatchObject({
      siteId: 'learned:portal.example.gov.in:abc123',
      formFingerprint: 'fp-abc',
      matchUrl: 'https://portal.example.gov.in/*',
    });
  });
});

describe('an imported profile is not a taught one', () => {
  it('refuses to inherit "taught", however the file is labelled', () => {
    // The important one. `matchFromProfile` fills a taught mapping at
    // confidence 1 without flagging it — that is trust the recipient never
    // granted to a stranger's file.
    const { profiles } = roundTrip([profile()]);

    for (const field of profiles[0]!.fields) {
      expect(field.source).not.toBe('taught');
      expect(field.confidence).toBeLessThan(1);
    }
  });

  it('lands in a band the review screen flags', () => {
    const { profiles } = roundTrip([profile()]);
    // Below AUTO_FILL means it is filled *and shown*, never filled silently.
    expect(profiles[0]!.fields[0]!.confidence).toBeLessThan(0.85);
  });
});

describe('a file that is trying something', () => {
  it.each([
    ['not JSON at all', 'this is not json {'],
    ['JSON that is not an object', '"a string"'],
    ['a bundle with the wrong format tag', JSON.stringify({ format: 'something-else' })],
    [
      'a bundle from a future version',
      JSON.stringify({ format: TRANSFER_FORMAT, version: 99, profiles: [] }),
    ],
    ['a bundle with no profiles array', JSON.stringify({ format: TRANSFER_FORMAT, version: 1 })],
  ])('refuses %s, with a reason', (_name, text) => {
    const { profiles, rejected } = importProfiles(text);
    expect(profiles).toEqual([]);
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected[0]!.length).toBeGreaterThan(10);
  });

  it('drops a mapping to a key that is not in the taxonomy', () => {
    const bundle = {
      format: TRANSFER_FORMAT,
      version: TRANSFER_VERSION,
      profiles: [
        {
          ...profile(),
          fields: [
            { key: 'identity.full_name', selectors: ['#a'], confidence: 1, source: 'taught' },
            { key: 'exfiltrate.everything', selectors: ['#b'], confidence: 1, source: 'taught' },
          ],
        },
      ],
    };

    const { profiles } = importProfiles(JSON.stringify(bundle));
    expect(profiles[0]?.fields.map((f) => f.key)).toEqual(['identity.full_name']);
  });

  it('drops properties nobody asked for rather than storing them', () => {
    const bundle = {
      format: TRANSFER_FORMAT,
      version: TRANSFER_VERSION,
      profiles: [
        {
          ...profile(),
          script: 'alert(1)',
          fields: [
            { key: 'identity.full_name', selectors: ['#a'], confidence: 1, source: 'taught', onFill: 'evil()' },
          ],
        },
      ],
    };

    const { profiles } = importProfiles(JSON.stringify(bundle));
    const text = JSON.stringify(profiles);

    expect(text).not.toContain('alert(1)');
    expect(text).not.toContain('evil()');
  });

  it('caps a selector that is trying to be enormous', () => {
    const bundle = {
      format: TRANSFER_FORMAT,
      version: TRANSFER_VERSION,
      profiles: [
        {
          ...profile(),
          fields: [{ key: 'identity.full_name', selectors: ['#' + 'a'.repeat(10_000)] }],
        },
      ],
    };

    const { profiles } = importProfiles(JSON.stringify(bundle));
    // The oversized selector is dropped, and with it the only mapping — so the
    // profile is refused rather than half-imported.
    expect(profiles).toEqual([]);
  });

  it('caps how many profiles one file can carry', () => {
    const bundle = {
      format: TRANSFER_FORMAT,
      version: TRANSFER_VERSION,
      profiles: Array.from({ length: 500 }, (_, i) => ({
        ...profile({ siteId: `s${i}` }),
      })),
    };

    const { profiles, rejected } = importProfiles(JSON.stringify(bundle));
    expect(profiles.length).toBeLessThanOrEqual(200);
    expect(rejected.join(' ')).toMatch(/only the first/i);
  });

  it('reports each unusable profile individually rather than failing the file', () => {
    const bundle = {
      format: TRANSFER_FORMAT,
      version: TRANSFER_VERSION,
      profiles: [profile(), { siteId: 'broken' }, null],
    };

    const { profiles, rejected } = importProfiles(JSON.stringify(bundle));
    expect(profiles).toHaveLength(1);
    expect(rejected).toHaveLength(2);
  });

  it('replaces a nonsense timestamp rather than storing it', () => {
    const bundle = {
      format: TRANSFER_FORMAT,
      version: TRANSFER_VERSION,
      profiles: [{ ...profile(), createdAt: 'not a date', lastVerifiedAt: 42 }],
    };

    const { profiles } = importProfiles(JSON.stringify(bundle));
    expect(Number.isNaN(new Date(profiles[0]!.createdAt).getTime())).toBe(false);
  });

  it('never imports blockers — those are ours to detect, not to be told', () => {
    // A profile that could declare "there is no CAPTCHA here" would be a
    // profile that could switch off a P4 control.
    const bundle = {
      format: TRANSFER_FORMAT,
      version: TRANSFER_VERSION,
      profiles: [{ ...profile(), blockers: [{ type: 'captcha', selectors: ['#nope'] }] }],
    };

    const { profiles } = importProfiles(JSON.stringify(bundle));
    expect(profiles[0]?.blockers).toEqual([]);
  });
});

function propertyNames(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) propertyNames(item, found);
  } else if (typeof value === 'object' && value !== null) {
    for (const [name, child] of Object.entries(value)) {
      found.add(name);
      propertyNames(child, found);
    }
  }
  return found;
}
