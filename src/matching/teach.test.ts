import { describe, expect, it } from 'vitest';

import { buildTaughtProfile, profileHealth, rankSelectors, type TeachPick } from './teach';
import { PROFILE_STALE_THRESHOLD, type SiteProfile } from '@/shared/types';
import type { FieldKey } from './taxonomy';

/**
 * Teach mode's pure core.
 *
 * The tests worth writing here are about *not losing things*: a repair that
 * discarded the rest of the profile, or a version bump that overwrote the
 * record of what changed, would each turn a two-minute fix into a reason not
 * to bother.
 */

const NOW = new Date('2026-08-25T10:00:00.000Z');

function pick(key: string, selectors: string[], label = 'A field'): TeachPick {
  return { ref: 'f1', key: key as FieldKey, selectors, label };
}

function profile(over: Partial<SiteProfile> = {}): SiteProfile {
  return {
    siteId: 'learned:portal.example.gov.in:abc123',
    version: 3,
    matchUrl: 'https://portal.example.gov.in/*',
    formFingerprint: 'fp-old',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastVerifiedAt: '2026-01-01T00:00:00.000Z',
    fields: [
      { key: 'identity.full_name', selectors: ['#txtName'], confidence: 0.9, source: 'rule' },
      { key: 'contact.email', selectors: ['#txtEmail'], confidence: 0.8, source: 'llm' },
    ],
    documents: [],
    submit: { selectors: ['#btnSubmit'], label: 'Submit' },
    blockers: [],
    ...over,
  };
}

describe('building a taught profile from scratch', () => {
  it('records the pick as taught, at full confidence', () => {
    const built = buildTaughtProfile({
      siteId: 'learned:test',
      url: 'https://portal.example.gov.in/apply?x=1',
      fingerprint: 'fp-new',
      picks: [pick('family.father_name', ['#txtFather'])],
      now: NOW,
    });

    expect(built.fields).toEqual([
      { key: 'family.father_name', selectors: ['#txtFather'], confidence: 1, source: 'taught' },
    ]);
  });

  it('starts at version 1', () => {
    const built = buildTaughtProfile({
      siteId: 'learned:test',
      url: 'https://portal.example.gov.in/apply',
      fingerprint: 'fp-new',
      picks: [pick('contact.email', ['#e'])],
      now: NOW,
    });
    expect(built.version).toBe(1);
  });

  it('matches the origin, not the one page it was taught on', () => {
    // A portal's form lives at a dozen URLs with different query strings.
    const built = buildTaughtProfile({
      siteId: 'learned:test',
      url: 'https://portal.example.gov.in/apply/step2?id=SC2024889231',
      fingerprint: 'fp-new',
      picks: [pick('contact.email', ['#e'])],
      now: NOW,
    });

    expect(built.matchUrl).toBe('https://portal.example.gov.in/*');
    expect(built.matchUrl).not.toContain('SC2024889231');
  });

  it('drops a pick with no usable selector rather than recording a dead entry', () => {
    const built = buildTaughtProfile({
      siteId: 'learned:test',
      url: 'https://x.example',
      fingerprint: 'fp',
      picks: [pick('contact.email', ['   ', ''])],
      now: NOW,
    });
    expect(built.fields).toEqual([]);
  });
});

describe('repairing an existing profile', () => {
  it('bumps the version', () => {
    const built = buildTaughtProfile({
      siteId: 'x',
      url: 'https://portal.example.gov.in/apply',
      fingerprint: 'fp-new',
      picks: [pick('contact.email', ['#txtEmailV2'])],
      previous: profile(),
      now: NOW,
    });
    expect(built.version).toBe(4);
  });

  it('keeps every field the user did not re-teach', () => {
    // The rule that makes repair worth doing: fixing one field must not cost
    // the other nineteen.
    const built = buildTaughtProfile({
      siteId: 'x',
      url: 'https://portal.example.gov.in/apply',
      fingerprint: 'fp-new',
      picks: [pick('contact.email', ['#txtEmailV2'])],
      previous: profile(),
      now: NOW,
    });

    expect(built.fields.map((f) => f.key).sort()).toEqual(['contact.email', 'identity.full_name']);
    expect(built.fields.find((f) => f.key === 'identity.full_name')).toMatchObject({
      selectors: ['#txtName'],
      source: 'rule',
    });
  });

  it('a teach overrides whatever was recorded for that key', () => {
    const built = buildTaughtProfile({
      siteId: 'x',
      url: 'https://portal.example.gov.in/apply',
      fingerprint: 'fp-new',
      picks: [pick('contact.email', ['#txtEmailV2'])],
      previous: profile(),
      now: NOW,
    });

    const email = built.fields.find((f) => f.key === 'contact.email');
    expect(email).toMatchObject({ selectors: ['#txtEmailV2'], source: 'taught', confidence: 1 });
  });

  it('upgrades an LLM guess to taught once a human confirms it', () => {
    // The Phase 8 hand-off: a `source: 'llm'` entry becomes `'taught'` when the
    // user points at the same field, and stops being capped.
    const before = profile().fields.find((f) => f.key === 'contact.email');
    expect(before?.source).toBe('llm');

    const built = buildTaughtProfile({
      siteId: 'x',
      url: 'https://portal.example.gov.in/apply',
      fingerprint: 'fp-new',
      picks: [pick('contact.email', ['#txtEmail'])],
      previous: profile(),
      now: NOW,
    });

    expect(built.fields.find((f) => f.key === 'contact.email')?.source).toBe('taught');
  });

  it('keeps the original identity and creation date', () => {
    const built = buildTaughtProfile({
      siteId: 'a-different-id',
      url: 'https://elsewhere.example',
      fingerprint: 'fp-new',
      picks: [pick('contact.email', ['#e'])],
      previous: profile(),
      now: NOW,
    });

    expect(built.siteId).toBe('learned:portal.example.gov.in:abc123');
    expect(built.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(built.lastVerifiedAt).toBe(NOW.toISOString());
  });

  it('adopts the fingerprint of the form it was just taught on', () => {
    // The page changed shape — that is usually *why* it needed repairing.
    const built = buildTaughtProfile({
      siteId: 'x',
      url: 'https://portal.example.gov.in/apply',
      fingerprint: 'fp-after-redesign',
      picks: [pick('contact.email', ['#e'])],
      previous: profile(),
      now: NOW,
    });
    expect(built.formFingerprint).toBe('fp-after-redesign');
  });

  it('keeps the recorded submit control unless a new one is given', () => {
    const kept = buildTaughtProfile({
      siteId: 'x',
      url: 'https://x.example',
      fingerprint: 'fp',
      picks: [pick('contact.email', ['#e'])],
      previous: profile(),
      now: NOW,
    });
    expect(kept.submit).toEqual({ selectors: ['#btnSubmit'], label: 'Submit' });

    const replaced = buildTaughtProfile({
      siteId: 'x',
      url: 'https://x.example',
      fingerprint: 'fp',
      picks: [pick('contact.email', ['#e'])],
      previous: profile(),
      submit: { selectors: ['#btnFinal'], label: 'Final Submit' },
      now: NOW,
    });
    expect(replaced.submit.label).toBe('Final Submit');
  });
});

describe('teaching a document slot', () => {
  it('records the constraint alongside the selectors', () => {
    const built = buildTaughtProfile({
      siteId: 'x',
      url: 'https://x.example',
      fingerprint: 'fp',
      picks: [],
      documents: [
        {
          ref: 'f9',
          key: 'doc.photo' as FieldKey,
          selectors: ['#filePhoto'],
          label: 'Upload Photograph',
          constraint: { mime: ['image/jpeg'], maxBytes: 51_200 },
        },
      ],
      now: NOW,
    });

    expect(built.documents).toEqual([
      {
        key: 'doc.photo',
        selectors: ['#filePhoto'],
        constraint: { mime: ['image/jpeg'], maxBytes: 51_200 },
      },
    ]);
  });

  it('keeps document slots taught earlier', () => {
    const previous = profile({
      documents: [
        { key: 'doc.signature' as FieldKey, selectors: ['#fileSign'], constraint: { mime: ['image/jpeg'] } },
      ],
    });

    const built = buildTaughtProfile({
      siteId: 'x',
      url: 'https://x.example',
      fingerprint: 'fp',
      picks: [],
      documents: [
        {
          ref: 'f9',
          key: 'doc.photo' as FieldKey,
          selectors: ['#filePhoto'],
          label: 'Photo',
          constraint: { mime: ['image/jpeg'] },
        },
      ],
      previous,
      now: NOW,
    });

    expect(built.documents.map((d) => d.key).sort()).toEqual(['doc.photo', 'doc.signature']);
  });
});

describe('ranking selectors for survival', () => {
  it('prefers a stable id', () => {
    expect(rankSelectors(['div > input:nth-of-type(2)', '#txtName'])[0]).toBe('#txtName');
  });

  it('demotes a generated id below an authored name', () => {
    // The ASP.NET case, which is the whole reason this ranking exists.
    const ranked = rankSelectors(['#ctl00_ContentPlaceHolder_txtName', 'input[name="txtName"]']);
    expect(ranked[0]).toBe('input[name="txtName"]');
  });

  it.each([
    '#ctl00_x_txtName',
    '#dnn_ctr445_ViewName_txt',
    '#a3f9c2e18b7d4',
    '#mui-input-4821',
    '#field99231',
  ])('treats %s as a generated id', (selector) => {
    const ranked = rankSelectors([selector, 'input[name="txtName"]']);
    expect(ranked[0]).toBe('input[name="txtName"]');
  });

  it('puts a label-anchored XPath above a structural path', () => {
    const ranked = rankSelectors([
      'form > div:nth-of-type(3) > input',
      "//label[normalize-space()='Full Name']/following::input[1]",
    ]);
    expect(ranked[0]).toContain('label');
  });

  it('keeps the harvester’s order within a tier', () => {
    const ranked = rankSelectors(['#alpha', '#beta']);
    expect(ranked).toEqual(['#alpha', '#beta']);
  });

  it('de-duplicates and drops blanks', () => {
    expect(rankSelectors(['#a', '#a', '  ', ''])).toEqual(['#a']);
  });

  describe('with a survival probe', () => {
    // The plan's "prefers selectors that survive across regenerated-ID
    // variants". Measured evidence, not a guess about what an id looks like.
    const survives = (selector: string) => selector !== '#ctl01_txtName';

    it('promotes what actually survived a re-render', () => {
      const ranked = rankSelectors(['#ctl01_txtName', 'input[name="txtName"]'], survives);
      expect(ranked[0]).toBe('input[name="txtName"]');
    });

    it('demotes what died below everything, however good it looks', () => {
      const ranked = rankSelectors(
        ['#ctl01_txtName', 'form > div:nth-of-type(3) > input'],
        survives,
      );
      // A structural path that works beats a beautiful id that does not.
      expect(ranked[0]).toBe('form > div:nth-of-type(3) > input');
    });

    it('keeps a dead selector rather than discarding it', () => {
      // It may come back — a postback variant, a different step of the wizard.
      // Ranking it last costs one failed lookup; dropping it loses information.
      const ranked = rankSelectors(['#ctl01_txtName', 'input[name="txtName"]'], survives);
      expect(ranked).toContain('#ctl01_txtName');
    });
  });
});

describe('profile health', () => {
  const resolvesAll = () => true;

  it('reports a fully working profile as healthy', () => {
    const health = profileHealth(profile(), resolvesAll);
    expect(health).toMatchObject({ resolved: 2, total: 2, rate: 1, stale: false, broken: [] });
  });

  it('names the keys that broke, which is what teach mode repairs', () => {
    const health = profileHealth(profile(), (selectors) => selectors[0] === '#txtName');

    expect(health.broken).toEqual(['contact.email']);
    expect(health.resolved).toBe(1);
  });

  it('marks a profile stale below the 60% threshold', () => {
    const big = profile({
      fields: Array.from({ length: 10 }, (_, i) => ({
        key: 'identity.full_name' as FieldKey,
        selectors: [`#f${i}`],
        confidence: 1,
        source: 'taught' as const,
      })),
    });

    // 5 of 10 resolve — below 0.6.
    const health = profileHealth(big, (selectors) => Number(selectors[0]!.slice(2)) < 5);
    expect(health.rate).toBe(0.5);
    expect(health.stale).toBe(true);
    expect(PROFILE_STALE_THRESHOLD).toBe(0.6);
  });

  it('is not stale at exactly the threshold', () => {
    const big = profile({
      fields: Array.from({ length: 10 }, (_, i) => ({
        key: 'identity.full_name' as FieldKey,
        selectors: [`#f${i}`],
        confidence: 1,
        source: 'taught' as const,
      })),
    });

    const health = profileHealth(big, (selectors) => Number(selectors[0]!.slice(2)) < 6);
    expect(health.rate).toBeCloseTo(0.6, 5);
    expect(health.stale).toBe(false);
  });

  it('an empty profile is not stale — there is nothing to be stale about', () => {
    expect(profileHealth(profile({ fields: [] }), resolvesAll).stale).toBe(false);
  });
});
