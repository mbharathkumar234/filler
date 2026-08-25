import { describe, expect, it } from 'vitest';
import {
  bundledProfiles,
  locateBySelector,
  matchFromProfile,
  matchesUrlPattern,
  profileApplies,
  selectProfile,
} from './profile-cache';
import { detectSameAsPermanent, matchFormWithContext } from './index';
import type { FieldDescriptor, SiteProfile } from '@/shared/types';

function field(overrides: Partial<FieldDescriptor> = {}): FieldDescriptor {
  return {
    ref: 'f0',
    selectors: ['#x'],
    tag: 'input',
    labelText: '',
    nearbyText: '',
    required: false,
    frameId: 0,
    visible: true,
    enabled: true,
    ...overrides,
  };
}

function profile(overrides: Partial<SiteProfile> = {}): SiteProfile {
  return {
    siteId: 'example-portal',
    version: 3,
    matchUrl: 'https://portal.example.gov.in/apply*',
    formFingerprint: 'fp-abc',
    createdAt: '2026-01-01T00:00:00Z',
    lastVerifiedAt: '2026-01-01T00:00:00Z',
    fields: [
      { key: 'family.father_name', selectors: ['#txtFName'], confidence: 1, source: 'taught' },
    ],
    documents: [],
    submit: { selectors: ['#btnFinalSubmit'], label: 'Final Submit' },
    blockers: [],
    ...overrides,
  };
}

describe('bundled profiles', () => {
  it('loads without error and every entry is well-formed', () => {
    // Empty at Phase 4 by design — no portal has been profiled yet.
    for (const loaded of bundledProfiles()) {
      expect(typeof loaded.siteId).toBe('string');
      expect(Array.isArray(loaded.fields)).toBe(true);
    }
  });
});

describe('matchesUrlPattern', () => {
  it('matches a trailing glob', () => {
    expect(matchesUrlPattern('https://p.gov.in/apply*', 'https://p.gov.in/apply/step2')).toBe(true);
  });

  it('does not match a different host', () => {
    expect(matchesUrlPattern('https://p.gov.in/apply*', 'https://other.gov.in/apply')).toBe(false);
  });

  it('treats dots literally', () => {
    expect(matchesUrlPattern('https://p.gov.in/x', 'https://pXgovXin/x')).toBe(false);
  });

  it('rejects an empty pattern rather than matching everything', () => {
    expect(matchesUrlPattern('', 'https://anything')).toBe(false);
  });
});

describe('profileApplies', () => {
  it('applies on a fingerprint match regardless of URL', () => {
    expect(profileApplies(profile(), 'https://elsewhere.test/x', 'fp-abc')).toBe(true);
  });

  it('falls back to the URL pattern when the fingerprint has drifted', () => {
    expect(
      profileApplies(profile(), 'https://portal.example.gov.in/apply/step1', 'fp-changed'),
    ).toBe(true);
  });

  it('does not apply to an unrelated page', () => {
    expect(profileApplies(profile(), 'https://unrelated.test/', 'fp-changed')).toBe(false);
  });
});

describe('selectProfile', () => {
  const fields = [
    { key: 'family.father_name' as const, selectors: ['#a'], confidence: 1, source: 'taught' as const },
    { key: 'contact.email' as const, selectors: ['#b'], confidence: 1, source: 'taught' as const },
    { key: 'contact.mobile' as const, selectors: ['#c'], confidence: 1, source: 'taught' as const },
    { key: 'id.pan' as const, selectors: ['#d'], confidence: 1, source: 'taught' as const },
    { key: 'id.aadhaar' as const, selectors: ['#e'], confidence: 1, source: 'taught' as const },
  ];

  it('prefers the newest version', () => {
    const chosen = selectProfile(
      [profile({ version: 1, fields }), profile({ version: 7, fields })],
      'https://portal.example.gov.in/apply',
      'fp-abc',
      () => true,
    );
    expect(chosen?.profile.version).toBe(7);
  });

  it('reports a fully resolving profile as fresh', () => {
    const chosen = selectProfile([profile({ fields })], 'x', 'fp-abc', () => true);
    expect(chosen?.resolveRate).toBe(1);
    expect(chosen?.stale).toBe(false);
  });

  it('marks a profile stale below the 60% resolve threshold', () => {
    let call = 0;
    const chosen = selectProfile([profile({ fields })], 'x', 'fp-abc', () => {
      call += 1;
      return call <= 2; // 2 of 5 resolve = 40%
    });
    expect(chosen?.resolveRate).toBeCloseTo(0.4);
    expect(chosen?.stale).toBe(true);
  });

  it('returns null when nothing applies', () => {
    expect(selectProfile([profile()], 'https://nope.test/', 'fp-x', () => true)).toBeNull();
  });
});

describe('matchFromProfile', () => {
  it('trusts a taught mapping completely', () => {
    const fields = [field({ ref: 'f7', selectors: ['#txtFName'] })];
    const [result] = matchFromProfile(profile(), fields, locateBySelector);

    expect(result).toMatchObject({
      fieldRef: 'f7',
      key: 'family.father_name',
      confidence: 1,
      source: 'profile',
    });
    expect(result?.rationale).toMatch(/you taught this/);
  });

  it('keeps the recorded confidence for a non-taught mapping', () => {
    const saved = profile({
      fields: [{ key: 'contact.email', selectors: ['#e'], confidence: 0.72, source: 'rule' }],
    });
    const [result] = matchFromProfile(saved, [field({ ref: 'f1', selectors: ['#e'] })], locateBySelector);
    expect(result?.confidence).toBe(0.72);
  });

  it('skips a selector that matches nothing on this page', () => {
    expect(matchFromProfile(profile(), [field({ selectors: ['#other'] })], locateBySelector)).toEqual([]);
  });

  it('skips an ambiguous selector rather than guessing', () => {
    const fields = [
      field({ ref: 'f1', selectors: ['#txtFName'] }),
      field({ ref: 'f2', selectors: ['#txtFName'] }),
    ];
    expect(matchFromProfile(profile(), fields, locateBySelector)).toEqual([]);
  });
});

describe('precedence: profile → rules', () => {
  const fields = [
    field({ ref: 'f0', selectors: ['#txtFName'], labelText: 'Email ID' }),
    field({ ref: 'f1', selectors: ['#other'], labelText: 'PIN Code' }),
  ];

  it('lets the profile override what the rules would have said', () => {
    const { results, profile: used } = matchFormWithContext(fields, {
      url: 'https://portal.example.gov.in/apply',
      fingerprint: 'fp-abc',
      profiles: [profile()],
      resolve: () => true,
    });

    // The label says Email, the profile says father's name — the profile wins.
    expect(results[0]).toMatchObject({ key: 'family.father_name', source: 'profile' });
    expect(used?.profile.siteId).toBe('example-portal');
  });

  it('falls back to rules for fields the profile does not cover', () => {
    const { results } = matchFormWithContext(fields, {
      url: 'https://portal.example.gov.in/apply',
      fingerprint: 'fp-abc',
      profiles: [profile()],
      resolve: () => true,
    });
    expect(results[1]).toMatchObject({ key: 'address.permanent.pincode', source: 'rule' });
  });

  it('uses rules alone when there is no profile — the any-portal case', () => {
    const { results, profile: used } = matchFormWithContext(fields, {
      url: 'https://never-seen.example/apply',
      fingerprint: 'fp-new',
    });
    expect(used).toBeNull();
    expect(results.every((r) => r.source === 'rule')).toBe(true);
    expect(results[1]?.key).toBe('address.permanent.pincode');
  });

  it('refuses a stale profile and reports it instead of filling half a form', () => {
    const big = profile({
      fields: Array.from({ length: 5 }, (_, i) => ({
        key: 'contact.email' as const,
        selectors: [`#gone${i}`],
        confidence: 1,
        source: 'taught' as const,
      })),
    });

    const { profile: used, staleProfile, results } = matchFormWithContext(fields, {
      url: 'https://portal.example.gov.in/apply',
      fingerprint: 'fp-abc',
      profiles: [big],
      resolve: () => false,
    });

    expect(used).toBeNull();
    expect(staleProfile?.stale).toBe(true);
    expect(results.every((r) => r.source === 'rule')).toBe(true);
  });

  it('lists the fields nothing could map', () => {
    const { unmapped } = matchFormWithContext(
      [field({ ref: 'f0', labelText: 'Scrutiny Officer Remarks' })],
      { url: 'https://x.test/', fingerprint: 'fp' },
    );
    expect(unmapped).toEqual(['f0']);
  });
});

describe('same-as-permanent detection', () => {
  it.each([
    'Same as Permanent Address',
    'Correspondence address is the same as permanent',
    'Copy from permanent address',
    'उपरोक्त के समान',
  ])('detects "%s"', (labelText) => {
    expect(detectSameAsPermanent([field({ ref: 'f3', tag: 'checkbox', labelText })])).toBe('f3');
  });

  it('ignores an unrelated checkbox', () => {
    expect(
      detectSameAsPermanent([
        field({ tag: 'checkbox', labelText: 'I agree to the terms and conditions' }),
      ]),
    ).toBeNull();
  });

  it('ignores a text field with matching words', () => {
    expect(
      detectSameAsPermanent([field({ tag: 'input', labelText: 'Same as permanent address' })]),
    ).toBeNull();
  });
});
