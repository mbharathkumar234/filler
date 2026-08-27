import { describe, expect, it } from 'vitest';

import { explainInjectionFailure } from './injection-failure';

/**
 * Why a page could not be read (§ found in use, on a Google Form).
 *
 * ## The bug this replaces
 *
 * `harvestTab` caught the injection error, matched `/cannot be scripted|Cannot
 * access/i`, and reported:
 *
 *   "This page cannot be read — Chrome blocks extensions on it (a store page,
 *    a PDF viewer, or a settings page)."
 *
 * On `docs.google.com/forms` that is simply false. Chrome does not block
 * extensions there. The real cause is that `activeTab` had lapsed — it is
 * granted when the user invokes the extension and **revoked on navigation** —
 * so Chrome refused with "Cannot access contents of the page", which matched
 * the regex and got dressed up as something else entirely.
 *
 * It is the same failure as the `window is not defined` one: an error handler
 * asserting a cause it never checked. A confident wrong explanation is worse
 * than a vague right one, because it sends the user off to fix the wrong thing
 * — here, to conclude the extension cannot read Google Forms at all.
 *
 * ## What is asserted
 *
 * The distinction that matters is **can the user do anything about it**. A
 * `chrome://` page is genuinely closed and the honest answer is to say so; an
 * ordinary web page is a permission the user can grant, and the answer must
 * say how. Every actionable case carries a remedy.
 */

const NO_ACCESS = new Error(
  'Cannot access contents of the page. Extension manifest must request permission to access the respective host.',
);
const NOT_SCRIPTABLE = new Error('The extensions gallery cannot be scripted.');

describe('an ordinary web page is a permission problem, not a blocked page', () => {
  it.each([
    'https://docs.google.com/forms/d/e/1FAIpQLSf/viewform',
    'https://scholarships.gov.in/apply',
    'https://portal.example.gov.in/form?id=3',
    'http://localhost:4173/practice/first-fill.html',
  ])('says so for %s', (url) => {
    const failure = explainInjectionFailure(url, NO_ACCESS);

    expect(failure.problem).toBe('no-permission');
    expect(failure.grantable).toBe(true);
    expect(failure.message).not.toMatch(/Chrome blocks|store page|settings page/i);
  });

  it('tells the user how to fix it, in the two ways that work', () => {
    const failure = explainInjectionFailure('https://docs.google.com/forms/x', NO_ACCESS);

    // Clicking the toolbar icon re-grants activeTab for this tab; granting the
    // site persists across navigation. Both are real remedies and the user
    // should be told which is which.
    expect(failure.remedy).toMatch(/icon/i);
    expect(failure.remedy.length).toBeGreaterThan(30);
  });

  it('offers the exact origin to grant, so the button has something to ask for', () => {
    expect(explainInjectionFailure('https://docs.google.com/forms/x', NO_ACCESS).origin).toBe(
      'https://docs.google.com/*',
    );
    expect(explainInjectionFailure('https://portal.example.gov.in/a?b=1#c', NO_ACCESS).origin).toBe(
      'https://portal.example.gov.in/*',
    );
  });

  it('names the site in the message, so it is obviously about this page', () => {
    expect(explainInjectionFailure('https://scholarships.gov.in/apply', NO_ACCESS).message).toContain(
      'scholarships.gov.in',
    );
  });
});

describe('pages that really are closed to every extension', () => {
  const closed: Array<[string, string]> = [
    ['chrome://settings/', 'restricted-scheme'],
    ['chrome://extensions', 'restricted-scheme'],
    ['about:blank', 'restricted-scheme'],
    ['devtools://devtools/bundled/inspector.html', 'restricted-scheme'],
    ['view-source:https://example.com', 'restricted-scheme'],
    ['edge://settings', 'restricted-scheme'],
    ['chrome-extension://abcdefghijklmnop/panel.html', 'other-extension'],
    ['https://chromewebstore.google.com/detail/x', 'web-store'],
    ['https://chrome.google.com/webstore/detail/x', 'web-store'],
  ];

  it.each(closed)('%s is %s', (url, problem) => {
    const failure = explainInjectionFailure(url, NOT_SCRIPTABLE);
    expect(failure.problem).toBe(problem);
    expect(failure.grantable, 'offering to grant this would be a dead end').toBe(false);
  });

  it('does not pretend there is a remedy where there is none', () => {
    const failure = explainInjectionFailure('chrome://settings/', NOT_SCRIPTABLE);
    expect(failure.origin).toBeUndefined();
    // It should still say something useful: open the form in a normal tab.
    expect(failure.remedy.length).toBeGreaterThan(10);
  });

  it('is not fooled by a web-store lookalike on another host', () => {
    // `chromewebstore.google.com.evil.test` is not the store.
    const failure = explainInjectionFailure('https://chromewebstore.google.com.evil.test/x', NO_ACCESS);
    expect(failure.problem).toBe('no-permission');
  });

  it('is not fooled by a path that merely mentions the store', () => {
    const failure = explainInjectionFailure('https://example.com/chromewebstore/detail', NO_ACCESS);
    expect(failure.problem).toBe('no-permission');
  });
});

describe('the special cases Chrome handles differently', () => {
  it('recognises a PDF, which cannot be scripted whatever the permission', () => {
    const failure = explainInjectionFailure('https://example.gov.in/notice.pdf', NOT_SCRIPTABLE);
    expect(failure.problem).toBe('pdf-viewer');
    expect(failure.grantable).toBe(false);
    expect(failure.remedy).toMatch(/pdf|download|form/i);
  });

  it('recognises a local file, where the remedy is a checkbox in Chrome', () => {
    const failure = explainInjectionFailure('file:///C:/Users/x/form.html', NO_ACCESS);
    expect(failure.problem).toBe('local-file');
    expect(failure.remedy).toMatch(/file URLs|Allow access/i);
    expect(failure.grantable).toBe(false);
  });
});

describe('when it genuinely does not know', () => {
  it('reports the underlying error rather than inventing a reason', () => {
    const odd = new Error('The tab was closed.');
    const failure = explainInjectionFailure('https://example.com/', odd);

    expect(failure.problem).toBe('unknown');
    expect(failure.message).toContain('The tab was closed.');
  });

  it('survives a url it cannot parse', () => {
    const failure = explainInjectionFailure('not a url at all', NO_ACCESS);
    expect(failure.problem).toBe('unknown');
    expect(failure.grantable).toBe(false);
  });

  it('survives an empty url, which is what a just-opened tab reports', () => {
    expect(() => explainInjectionFailure('', NO_ACCESS)).not.toThrow();
  });

  it('never returns an empty message or remedy', () => {
    const urls = ['', 'https://a.test/', 'chrome://settings', 'file:///x', 'not a url'];
    for (const url of urls) {
      const failure = explainInjectionFailure(url, NO_ACCESS);
      expect(failure.message.length, url).toBeGreaterThan(10);
      expect(failure.remedy.length, url).toBeGreaterThan(10);
    }
  });
});

describe('what it must never claim', () => {
  it('never says Chrome blocks a page Chrome does not block', () => {
    // The original bug, as a test. If this string ever appears for an ordinary
    // https page again, somebody has reintroduced the guess.
    for (const url of ['https://docs.google.com/forms/x', 'https://scholarships.gov.in/']) {
      const failure = explainInjectionFailure(url, NO_ACCESS);
      expect(`${failure.message} ${failure.remedy}`).not.toMatch(/Chrome blocks extensions/i);
    }
  });
});
