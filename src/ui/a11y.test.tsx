// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, within, type RenderResult } from '@testing-library/react';

import { Disclosure } from '@/ui/onboarding/Disclosure';
import { ReviewScreen } from '@/ui/review/ReviewScreen';
import { buildReview } from '@/runtime/review';
import type { FieldDescriptor, MatchResult } from '@/shared/types';
import type { FieldKey } from '@/matching/taxonomy';
import { GettingStarted } from '@/ui/onboarding/GettingStarted';
import { VaultGate } from '@/ui/vault-editor/VaultGate';
import { LanguagePicker } from '@/ui/lib/LanguagePicker';
import { LocaleProvider } from '@/ui/lib/LocaleProvider';
import { LOCALES, MESSAGES, type Locale } from '@/ui/lib/i18n';

/**
 * The accessibility floor (§ COMPLETION_PLAN Phase F, Should Achieve).
 *
 *   "Accessibility pass — this is an accessibility product for many of its
 *    users."
 *
 * That line is the reason this file is not a formality. The people most helped
 * by something that types a scholarship form for them include people who find
 * typing it themselves hard: motor impairments, low vision, a screen reader, a
 * form in a language they read slowly. An interface that fills a form but
 * cannot be operated without a mouse has helped the wrong half of the problem.
 *
 * These are *invariants*, not a score. Each one is a specific way the panel
 * could stop working for somebody, asserted over the screens as rendered — so
 * a future control that ships without a name fails here rather than in use.
 *
 * What this cannot check is what an audit tool also cannot: whether the wording
 * makes sense, whether focus order matches reading order on a real screen, or
 * whether a screen reader announces the review screen usefully. Those need a
 * person, and they are named as outstanding in `STATUS.md`.
 */

const storage: Record<string, unknown> = {};

/**
 * The review screen, with one clean row and one flagged row.
 *
 * It is in this sweep because it is the screen the whole product narrows to.
 * If the flagged row's state is carried by a yellow background alone, the
 * person who most needs to notice it is the person who cannot see it.
 */
function reviewPayload() {
  const field = (ref: string, labelText: string, over: Partial<FieldDescriptor> = {}): FieldDescriptor => ({
    ref,
    selectors: ['#' + ref],
    tag: 'input',
    labelText,
    nearbyText: 'Personal Details',
    required: false,
    frameId: 0,
    visible: true,
    enabled: true,
    ...over,
  });
  const match = (ref: string, key: string, confidence: number): MatchResult => ({
    fieldRef: ref,
    key: key as FieldKey,
    confidence,
    rationale: 'rule',
    source: 'rule',
  });

  return {
    model: buildReview({
      fields: [field('f1', 'Candidate Name'), field('f2', 'State', { tag: 'select' })],
      matches: [match('f1', 'identity.full_name', 0.97), match('f2', 'address.permanent.state', 0.7)],
      records: [
        { ref: 'f1', ok: true },
        { ref: 'f2', ok: true, fuzzy: true },
      ],
      values: new Map([
        ['f1', 'Ravi Kumar'],
        ['f2', 'Karnatka'],
      ]),
    }),
    url: 'https://portal.example.gov.in/apply',
    title: 'Application',
    formFingerprint: 'fp-abc',
    submit: { selector: '#btnFinalSubmit', label: 'Final Submit' },
    blockers: [],
    documents: [],
  };
}

vi.mock('@/ui/lib/client', () => ({
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : 'error'),
  isLockedError: () => false,
  send: (request: { type: string }) => {
    switch (request.type) {
      case 'vault:status':
        return Promise.resolve({ exists: true, unlocked: true });
      case 'vault:list':
        return Promise.resolve([]);
      case 'doc:list':
        return Promise.resolve([]);
      case 'audit:read':
        return Promise.resolve([]);
      case 'review:build':
        return Promise.resolve(reviewPayload());
      case 'approval:grant':
        return Promise.resolve({ expiresAt: Date.now() + 90_000, target: 'Final Submit' });
      default:
        return Promise.resolve({});
    }
  },
}));

beforeEach(() => {
  for (const k of Object.keys(storage)) delete storage[k];
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: (key: string) => Promise.resolve({ [key]: storage[key] }),
        set: (items: Record<string, unknown>) => {
          Object.assign(storage, items);
          return Promise.resolve();
        },
      },
    },
    tabs: { create: vi.fn(() => Promise.resolve({})) },
    runtime: { getURL: (p: string) => `chrome-extension://x/${p}` },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/**
 * The name a screen reader would announce for a control.
 *
 * Deliberately not `getByRole(..., { name })` — that would only find controls
 * that *have* a name. To assert none are missing one, they have to be
 * enumerated first and named second.
 */
function accessibleName(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria !== null && aria.trim() !== '') return aria.trim();

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();
    if (text !== '') return text;
  }

  if (el.id) {
    // Compared rather than selected: `CSS.escape` is absent in this jsdom, and
    // an unescaped id in an attribute selector is a syntax error waiting for
    // the first component that generates one.
    const label = [...el.ownerDocument.querySelectorAll('label[for]')].find(
      (candidate) => candidate.getAttribute('for') === el.id,
    );
    if (label?.textContent?.trim()) return label.textContent.trim();
  }

  const wrapping = el.closest('label');
  if (wrapping?.textContent?.trim()) return wrapping.textContent.trim();

  if (el.textContent?.trim()) return el.textContent.trim();

  const title = el.getAttribute('title');
  return title?.trim() ?? '';
}

const INTERACTIVE = 'button, a[href], input, select, textarea, [role="button"], [tabindex]';

function unnamedControls(view: RenderResult): string[] {
  return [...view.container.querySelectorAll(INTERACTIVE)]
    .filter((el) => el.getAttribute('type') !== 'hidden')
    .filter((el) => el.getAttribute('aria-hidden') !== 'true')
    .filter((el) => accessibleName(el) === '')
    .map((el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''));
}

function headingLevels(view: RenderResult): number[] {
  return [...view.container.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) =>
    Number(h.tagName.slice(1)),
  );
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------

/**
 * `minText` is the vacuity floor for that screen: how much text it must render
 * before the checks below mean anything. A full screen is 40+ characters; a
 * single labelled control is not, and lowering the floor for everything to
 * accommodate it would let a half-rendered screen through.
 */
const SCREENS: Array<{ name: string; mount: () => RenderResult; minText?: number }> = [
  // With `onAccept`, which is how the panel renders it — without one it has no
  // controls at all, and the control checks below would test nothing.
  { name: 'disclosure', mount: () => render(<Disclosure onAccept={() => {}} />) },
  { name: 'getting started', mount: () => render(<GettingStarted />) },
  {
    name: 'vault gate (new)',
    mount: () => render(<VaultGate exists={false} onUnlocked={() => {}} />),
  },
  {
    name: 'vault gate (returning)',
    mount: () => render(<VaultGate exists onUnlocked={() => {}} />),
  },
  { name: 'review screen', mount: () => render(<ReviewScreen tabId={7} onDone={() => {}} />) },
  { name: 'language picker', mount: () => render(<LanguagePicker />), minText: 20 },
];

describe.each(SCREENS)('$name', ({ mount, minText }) => {
  it('actually rendered — every check below is vacuous otherwise', async () => {
    // The sweep asserts that *nothing* is wrong. A screen still waiting on an
    // effect has nothing wrong with it and nothing right either, and would
    // sail through every check in this file while testing none of them.
    const view = mount();
    await settle();
    expect(view.container.querySelectorAll(INTERACTIVE).length).toBeGreaterThan(0);
    expect((view.container.textContent ?? '').length).toBeGreaterThan(minText ?? 40);
  });

  it('gives every control a name a screen reader can announce', async () => {
    const view = mount();
    await settle();
    expect(unnamedControls(view)).toEqual([]);
  });

  it('does not skip heading levels', async () => {
    // Jumping h2 to h4 breaks the outline a screen-reader user navigates by.
    const view = mount();
    await settle();
    const levels = headingLevels(view);
    for (let i = 1; i < levels.length; i += 1) {
      const step = levels[i]! - levels[i - 1]!;
      expect(step, levels[i - 1] + ' then ' + levels[i]).toBeLessThanOrEqual(1);
    }
  });

  it('puts nothing ahead of everything else in the tab order', async () => {
    // A positive tabindex jumps the whole document and is almost always a bug;
    // -1, for programmatic focus only, is fine.
    const view = mount();
    await settle();
    const positive = [...view.container.querySelectorAll('[tabindex]')].filter(
      (el) => Number(el.getAttribute('tabindex')) > 0,
    );
    expect(positive).toEqual([]);
  });

  it('labels every input, rather than relying on a placeholder', async () => {
    // A placeholder disappears the moment somebody types and is not reliably
    // announced. It is a hint, not a label.
    const view = mount();
    await settle();
    const unlabelled = [...view.container.querySelectorAll('input, select, textarea')]
      .filter((el) => el.getAttribute('type') !== 'hidden')
      .filter((el) => {
        const name = accessibleName(el);
        return name === '' || name === el.getAttribute('placeholder');
      })
      .map((el) => el.getAttribute('name') ?? el.tagName.toLowerCase());
    expect(unlabelled).toEqual([]);
  });
});

describe('state shown with colour is also shown some other way', () => {
  it('marks checklist steps done in text, not only with a tick and grey', async () => {
    // A green tick and a strike-through are both invisible to a screen reader
    // and to anybody who cannot separate the colours.
    const view = render(<GettingStarted />);
    const list = await view.findByRole('list');
    const items = within(list).getAllByRole('listitem');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.textContent ?? '').toMatch(/done|not done yet/);
    }
  });

  it('hides the decorative symbol from assistive technology', async () => {
    const view = render(<GettingStarted />);
    await view.findByRole('list');
    const symbols = [...view.container.querySelectorAll('span')].filter((span) =>
      /^[✓○]$/.test(span.textContent?.trim() ?? ''),
    );
    expect(symbols.length).toBeGreaterThan(0);
    for (const symbol of symbols) expect(symbol.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('regions announce what they are', () => {
  it('names the checklist region by its own heading', async () => {
    const view = render(<GettingStarted />);
    const region = await view.findByRole('region');
    const labelledBy = region.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(view.container.querySelector('#' + labelledBy)?.textContent).toBe('Getting set up');
  });
});


// ---------------------------------------------------------------------------
// The same invariants, in every language (§ Phase F localisation)
// ---------------------------------------------------------------------------

/**
 * Accessibility and localisation fail together, and quietly.
 *
 * Most of a control's accessible name in this panel *is* its translated text.
 * A key missing from the Tamil catalogue does not throw and does not render a
 * visible placeholder — it renders an empty button, which is invisible to a
 * sighted reviewer skimming for missing words and completely opaque to the
 * screen-reader user it strands. So the sweep runs in every locale rather than
 * only in the one whoever wrote the strings was reading.
 */
const LOCALISED: Array<{ name: string; mount: (locale: Locale) => RenderResult }> = [
  {
    name: 'disclosure',
    mount: (locale) =>
      render(
        <LocaleProvider initial={locale}>
          <Disclosure onAccept={() => {}} />
        </LocaleProvider>,
      ),
  },
  {
    name: 'getting started',
    mount: (locale) =>
      render(
        <LocaleProvider initial={locale}>
          <GettingStarted />
        </LocaleProvider>,
      ),
  },
  {
    name: 'language picker',
    mount: (locale) =>
      render(
        <LocaleProvider initial={locale}>
          <LanguagePicker />
        </LocaleProvider>,
      ),
  },
];

const NON_ENGLISH = LOCALES.filter((locale) => locale !== 'en');

describe.each(NON_ENGLISH)('in %s', (locale) => {
  it.each(LOCALISED)('$name keeps every control named', async ({ mount }) => {
    const view = mount(locale);
    await settle();
    expect(view.container.querySelectorAll(INTERACTIVE).length).toBeGreaterThan(0);
    expect(unnamedControls(view)).toEqual([]);
  });

  it.each(LOCALISED)('$name is actually in that language', async ({ mount }) => {
    // Guards the other direction: a screen that silently fell back to English
    // everywhere would pass every check above while being untranslated.
    const view = mount(locale);
    await settle();
    expect(view.container.textContent).not.toMatch(/Getting set up|Before you start/);
  });

  it('renders no untranslated placeholder braces', async () => {
    for (const { mount } of LOCALISED) {
      const view = mount(locale);
      await settle();
      // `{count}` printed literally means a placeholder the translation
      // dropped or renamed — readable English would be better than this.
      expect(view.container.textContent ?? '').not.toMatch(/\{\w+\}/);
      cleanup();
    }
  });
});

describe('choosing a language', () => {
  it('lets somebody pick a script they can read, from a labelled control', async () => {
    const view = render(
      <LocaleProvider initial="en">
        <LanguagePicker />
      </LocaleProvider>,
    );
    const select = await view.findByLabelText(MESSAGES['language.label']);
    expect((select as HTMLSelectElement).options.length).toBe(LOCALES.length);
  });

  it('writes each option in its own script', async () => {
    const view = render(
      <LocaleProvider initial="en">
        <LanguagePicker />
      </LocaleProvider>,
    );
    await settle();
    const text = view.container.textContent ?? '';
    expect(text).toContain('हिन्दी');
    expect(text).toContain('தமிழ்');
  });
});
