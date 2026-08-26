import { expect, test, type Page } from '@playwright/test';

/**
 * §COMPLETION_PLAN Phase B — the adversarial suite, written attack-first.
 *
 *   "Write the adversarial fixture *first*, watch it break the current guard,
 *    then fix. A guard that has never been attacked is untested."
 *
 * `fill.spec.ts` already attacks the guard once it is installed. This file
 * attacks the thing that suite took for granted: **when** it is installed.
 *
 * ## The hole this file was written to find
 *
 * Phase 5 recorded the pre-injection window as acceptable, on the grounds that
 * "nothing of ours had been filled". That is true of a first page load. It is
 * false of a **reload after a fill** — an ASP.NET postback preserves field
 * values, so the page comes back carrying the extension's own data, and a page
 * that submits during `load` submits it before a gesture-injected content
 * script can exist.
 *
 * That is a direct P2 violation, and the reasoning that dismissed it only ever
 * covered the first-load case.
 */

const RELOAD_SUBMIT = '/hostile-portal/reload-submit.html';
const HOSTILE = '/hostile-portal/page-1.html';

async function withHarness(page: Page, url: string) {
  await page.goto(url);
  const src = await page.evaluate(async () => {
    const html = await (await fetch('/_harness/index.html')).text();
    return /src="([^"]+)"/.exec(html)?.[1]?.replace('./', '/_harness/') ?? '';
  });
  expect(src).toBeTruthy();
  await page.addScriptTag({ url: src, type: 'module' });
  await page.waitForFunction(() => typeof window.__guardReport === 'function');
}

test.describe('the fixture is genuinely hostile', () => {
  test('does nothing on a first visit, when the fields are empty', async ({ page }) => {
    // Establish the premise from both sides: without this, a fixture that
    // always submitted would make the next test pass for the wrong reason.
    await page.goto(RELOAD_SUBMIT);
    await expect(page.locator('#log')).toHaveText('state=fresh');
    expect(page.url()).toContain('reload-submit');
  });

  test('submits immediately when the reload carries values', async ({ page }) => {
    await page.goto(`${RELOAD_SUBMIT}?candidateName=Ravi+Kumar&uid=234567890123`);
    await page.waitForURL(/submitted\.html/, { timeout: 5000 });
    await expect(page.locator('#submitted-marker')).toBeVisible();
  });
});

/**
 * The P2 claim, stated as a test rather than as a comment.
 *
 * A gesture-injected guard cannot be present during `load`, so this documents
 * the exposure precisely: the values that reach the portal are the ones the
 * extension put in the page.
 */
test.describe('the post-fill reload window', () => {
  test('a values-carrying reload submits our data before any gesture-injected guard exists', async ({
    page,
  }) => {
    const submitted: string[] = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) submitted.push(frame.url());
    });

    await page.goto(`${RELOAD_SUBMIT}?candidateName=Ravi+Kumar&uid=234567890123`);
    await page.waitForURL(/submitted\.html/, { timeout: 5000 });

    const final = submitted.at(-1) ?? '';
    // The exposure, named: the submitted URL carries the filled values.
    expect(final).toContain('candidateName=Ravi+Kumar');
    expect(final).toContain('uid=234567890123');
  });

  test('a guard installed on a gesture arrives too late to stop it', async ({ page }) => {
    // Not a criticism of the guard — a statement of when it can act. The
    // extension has no way to run before the page's own `load` handler under
    // `activeTab`, which is the permission model the plan requires.
    await page.goto(`${RELOAD_SUBMIT}?candidateName=Ravi+Kumar&uid=234567890123`);
    await page.waitForURL(/submitted\.html/, { timeout: 5000 });

    // By the time anything of ours could be injected, the navigation is done.
    expect(page.url()).toContain('submitted.html');
  });
});

/**
 * The five attacks the completion plan names, against the guard once it is
 * installed. Four were already covered in `fill.spec.ts`; the two below were
 * not, and are the reason this file exists rather than a note saying "covered".
 */
test.describe('Phase B named attacks', () => {
  test('a page that auto-clicks its own submit button is blocked', async ({ page }) => {
    await withHarness(page, HOSTILE);
    await page.evaluate(() => window.__installGuard());

    const before = await page.evaluate(() => window.__guardReport());

    // The fixture clicks #btnFinalSubmit on a timer once hostilities start.
    await page.evaluate(() =>
      (window as unknown as { __startHostilities: () => void }).__startHostilities(),
    );
    await page.waitForTimeout(2_500);

    const after = await page.evaluate(() => window.__guardReport());

    expect(after.blocked).toBeGreaterThan(before.blocked);
    expect(after.submitEventsSeen).toBe(0);
    expect(page.url()).toContain('hostile-portal');
  });

  test('an approval that has run out of time is refused, on a real clock', async ({ page }) => {
    // The unit suites advance a number. This advances the browser's own clock
    // past the ninety seconds and then tries, which is the version that would
    // catch a guard reading `Date.now()` from somewhere unexpected.
    await withHarness(page, HOSTILE);
    await page.evaluate(() => window.__installGuard());

    await page.clock.install();
    await page.evaluate(() => {
      window.__arm({
        value: 'deadbeefdeadbeefdeadbeefdeadbeef',
        expiresAt: Date.now() + 90_000,
        targetSelector: '#btnFinalSubmit',
      });
    });

    await page.clock.fastForward('01:31');
    await page.locator('#btnFinalSubmit').click();

    const report = await page.evaluate(() => window.__guardReport());
    expect(report.submitEventsSeen).toBe(0);
    expect(report.blocked).toBeGreaterThan(0);
    expect(page.url()).toContain('hostile-portal');
  });
});
