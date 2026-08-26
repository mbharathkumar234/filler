import { expect, test, type Page } from '@playwright/test';

/**
 * §Phase 5 Verify, in a real browser:
 *
 *   "every mapped field ends up with the correct value; clicking the real
 *    submit button while unarmed does nothing except show the toast. Write an
 *    adversarial test where the fixture page calls `form.submit()` on load."
 *
 * jsdom cannot model a page that navigates, so P2 — the promise the whole
 * product rests on — can only be honestly tested here.
 */

const UGLY = '/ugly-portal/page-1.html';
const HOSTILE = '/hostile-portal/page-1.html';
const TWO_SUBMITS = '/hostile-portal/two-submits.html';

async function withHarness(page: Page, url: string) {
  await page.goto(url);
  const src = await page.evaluate(async () => {
    const html = await (await fetch('/_harness/index.html')).text();
    return /src="([^"]+)"/.exec(html)?.[1]?.replace('./', '/_harness/') ?? '';
  });
  expect(src).toBeTruthy();
  await page.addScriptTag({ url: src, type: 'module' });
  await page.waitForFunction(() => typeof window.__fill === 'function');
}

test.describe('filling', () => {
  test('writes every mapped value into the page', async ({ page }) => {
    await withHarness(page, UGLY);
    await page.evaluate(() => window.__installGuard());

    const result = await page.evaluate(() =>
      window.__fill([
        { ref: 'txtCity', key: 'address.permanent.city', value: 'Bengaluru' },
        { ref: 'txtPin', key: 'address.permanent.pincode', value: '560001' },
        { ref: 'txtEmail', key: 'contact.email', value: 'ravi@example.com' },
        { ref: 'ddlState', key: 'address.permanent.state', value: 'Karnataka' },
      ]),
    );

    expect(result.records.every((r) => r.ok)).toBe(true);

    await expect(page.locator('#txtCity')).toHaveValue('Bengaluru');
    await expect(page.locator('#txtPin')).toHaveValue('560001');
    await expect(page.locator('#txtEmail')).toHaveValue('ravi@example.com');
    await expect(page.locator('#ddlState')).toHaveValue('KA');
  });

  test('selects a dropdown option by its visible text', async ({ page }) => {
    await withHarness(page, UGLY);
    await page.evaluate(() => window.__installGuard());

    const result = await page.evaluate(() =>
      window.__fill([{ ref: 'ddlState', key: 'address.permanent.state', value: 'Tamil Nadu' }]),
    );

    expect(result.records[0]?.strategy).toBe('option-exact-text');
    await expect(page.locator('#ddlState')).toHaveValue('TN');
  });

  test('truncates to maxLength and flags it', async ({ page }) => {
    await withHarness(page, UGLY);
    await page.evaluate(() => window.__installGuard());

    const result = await page.evaluate(() =>
      window.__fill([{ ref: 'txtPin', key: 'address.permanent.pincode', value: '5600011234' }]),
    );

    expect(result.records[0]?.truncated).toBe(true);
    await expect(page.locator('#txtPin')).toHaveValue('560001');
  });

  test('fires real input and change events, as a framework would need', async ({ page }) => {
    await withHarness(page, UGLY);
    await page.evaluate(() => window.__installGuard());

    const seen = await page.evaluate(async () => {
      const events: string[] = [];
      const input = document.getElementById('txtCity')!;
      for (const type of ['input', 'change', 'blur']) {
        input.addEventListener(type, () => events.push(type));
      }
      await window.__fill([{ ref: 'txtCity', key: 'address.permanent.city', value: 'Mysuru' }]);
      return events;
    });

    expect(seen).toEqual(expect.arrayContaining(['input', 'change', 'blur']));
  });
});

test.describe('the submit guard, against a page that fights back', () => {
  test('the fixture really does try to submit itself', async ({ page }) => {
    // Establish the premise before asserting we defeat it: without this, a
    // guard that does nothing would pass every test below.
    await withHarness(page, HOSTILE);
    await page.evaluate(() => window.__installGuard());
    await page.evaluate(() =>
      (window as unknown as { __startHostilities: () => void }).__startHostilities(),
    );
    await page.waitForTimeout(1500);

    const attempts = await page.evaluate(
      () => (window as unknown as { __submitAttempts: number }).__submitAttempts,
    );
    expect(attempts).toBeGreaterThan(1);
  });

  test('the pre-injection gap is real, and we do not pretend otherwise', async ({ page }) => {
    // This page submits during load, before an extension injected on a user
    // gesture could exist. It navigates, and that is the documented limit of
    // the guard — P2 still holds, because nothing of ours had been filled.
    await page.goto('/hostile-portal/page-onload.html');
    await page.waitForURL(/submitted\.html/, { timeout: 5000 });
    await expect(page.locator('#submitted-marker')).toBeVisible();
  });

  test('blocks a scripted form.submit() once installed', async ({ page }) => {
    await withHarness(page, HOSTILE);
    await page.evaluate(() => window.__installGuard());

    const before = await page.evaluate(() => window.__guardReport());

    await page.evaluate(() => {
      (document.getElementById('frm') as HTMLFormElement).submit();
    });

    const after = await page.evaluate(() => window.__guardReport());
    expect(after.blocked).toBeGreaterThan(before.blocked);
    expect(after.toasts.at(-1)).toMatch(/script on this page/i);
  });

  test('blocks a click on the real submit button, and says why', async ({ page }) => {
    await withHarness(page, HOSTILE);
    await page.evaluate(() => window.__installGuard());

    await page.locator('#btnFinalSubmit').click();

    const report = await page.evaluate(() => window.__guardReport());
    expect(report.blocked).toBeGreaterThan(0);
    expect(page.url()).toContain('hostile-portal');
    expect(report.toasts.at(-1)).toMatch(/blocked/i);
    expect(report.toasts.at(-1)).toMatch(/review/i);
  });

  test('blocks Enter pressed inside the form', async ({ page }) => {
    await withHarness(page, HOSTILE);
    await page.evaluate(() => window.__installGuard());

    await page.locator('#a').focus();
    await page.keyboard.press('Enter');

    expect((await page.evaluate(() => window.__guardReport())).blocked).toBeGreaterThan(0);
  });

  test('the page cannot submit what we filled — the P2 promise', async ({ page }) => {
    await withHarness(page, HOSTILE);
    await page.evaluate(() => window.__installGuard());

    // Start the hostilities: from here the page calls form.submit() on every
    // input event, so filling it is a live attempt to submit our values mid-run.
    await page.evaluate(() =>
      (window as unknown as { __startHostilities: () => void }).__startHostilities(),
    );
    const before = await page.evaluate(() => window.__guardReport());

    await page.evaluate(() =>
      window.__fill([
        { ref: 'a', key: 'identity.full_name', value: 'Ravi Kumar' },
        { ref: 'b', key: 'contact.email', value: 'ravi@example.com' },
        { ref: 'c', key: 'contact.mobile', value: '9876543210' },
        { ref: 'd', key: 'address.permanent.pincode', value: '560001' },
      ]),
    );

    const after = await page.evaluate(() => window.__guardReport());

    // The values landed…
    await expect(page.locator('#a')).toHaveValue('Ravi Kumar');
    await expect(page.locator('#c')).toHaveValue('9876543210');

    // …the page tried to submit them…
    expect(after.submitAttempts).toBeGreaterThan(before.submitAttempts);

    // …and every attempt was stopped.
    expect(after.blocked).toBeGreaterThan(before.blocked);
    expect(after.submitEventsSeen).toBe(0);
    expect(page.url()).toContain('hostile-portal');
  });

  test('never navigates away while unarmed, however hard the page tries', async ({ page }) => {
    await withHarness(page, HOSTILE);
    await page.evaluate(() => window.__installGuard());

    await page.evaluate(() =>
      (window as unknown as { __startHostilities: () => void }).__startHostilities(),
    );
    const startUrl = page.url();
    await page.waitForTimeout(2500); // let every timer and the scripted click fire

    expect(page.url()).toBe(startUrl);
    const report = await page.evaluate(() => window.__guardReport());
    expect(report.submitEventsSeen).toBe(0);
    expect(report.blocked).toBeGreaterThan(0);
  });

  test('an armed token permits exactly one submission', async ({ page }) => {
    await withHarness(page, HOSTILE);
    await page.evaluate(() => window.__installGuard());

    await page.evaluate(() => {
      window.__arm({
        value: 'deadbeefdeadbeefdeadbeefdeadbeef',
        expiresAt: Date.now() + 90_000,
        targetSelector: '#btnFinalSubmit',
      });
    });

    await page.locator('#btnFinalSubmit').click();

    const afterFirst = await page.evaluate(() => window.__guardReport());
    // The fixture's own handler calls preventDefault, so the submit is
    // observable without the page navigating away.
    expect(afterFirst.submitEventsSeen).toBe(1);
    expect(afterFirst.armed).toBe(false);

    // The token is spent: a second click is blocked again.
    const blockedBefore = afterFirst.blocked;
    await page.locator('#btnFinalSubmit').click();
    const afterSecond = await page.evaluate(() => window.__guardReport());

    expect(afterSecond.submitEventsSeen).toBe(1);
    expect(afterSecond.blocked).toBeGreaterThan(blockedBefore);
  });
});

test.describe('the token names one control, not "a" control (§ mutation-testing gap)', () => {
  /**
   * Phase B, Must Achieve: *"Exactly one programmatic click per armed run, on
   * exactly the element recorded in the plan."*
   *
   * Every guard fixture until now had a single submit button, so "the recorded
   * element" and "any element" were the same set and no test could separate
   * them. Mutation testing showed what that cost: `if (!intended) return false`
   * and the whole of `matchesTarget`/`containsTarget` could each be made to
   * permit anything, and all eighteen guard specs still passed.
   *
   * "Save Draft" beside "Final Submit" is the ordinary layout on these portals,
   * and the two do very different things. Approving one must not arm the other.
   */
  const TOKEN = 'deadbeefdeadbeefdeadbeefdeadbeef';

  async function armFor(page: Page, targetSelector: string) {
    await page.evaluate(
      ({ token, targetSelector: selector }) => {
        window.__arm({ value: token, expiresAt: Date.now() + 90_000, targetSelector: selector });
      },
      { token: TOKEN, targetSelector },
    );
  }

  test('an approval for Final Submit does not permit Save Draft', async ({ page }) => {
    await withHarness(page, TWO_SUBMITS);
    await page.evaluate(() => window.__installGuard());
    await armFor(page, '#btnFinalSubmit');

    await page.locator('#btnSaveDraft').click();

    const report = await page.evaluate(() => window.__guardReport());
    expect(report.submitEventsSeen, 'the draft button submitted on the final token').toBe(0);
    expect(report.blocked).toBeGreaterThan(0);
    // And the token must survive: blocking the wrong button must not silently
    // spend the approval the user actually gave.
    expect(report.armed).toBe(true);
  });

  test('an approval for Save Draft does not permit Final Submit', async ({ page }) => {
    // The direction that matters most — the user approved the reversible one.
    await withHarness(page, TWO_SUBMITS);
    await page.evaluate(() => window.__installGuard());
    await armFor(page, '#btnSaveDraft');

    await page.locator('#btnFinalSubmit').click();

    const report = await page.evaluate(() => window.__guardReport());
    expect(report.submitEventsSeen).toBe(0);
    expect(report.blocked).toBeGreaterThan(0);
    expect(report.armed).toBe(true);
  });

  test('the approved control still works, so the guard is not simply refusing everything', async ({ page }) => {
    await withHarness(page, TWO_SUBMITS);
    await page.evaluate(() => window.__installGuard());
    await armFor(page, '#btnFinalSubmit');

    await page.locator('#btnFinalSubmit').click();

    const report = await page.evaluate(() => window.__guardReport());
    expect(report.submitEventsSeen).toBe(1);
    expect(report.armed).toBe(false);
    expect(await page.evaluate(() => window.__lastSubmitter)).toBe('btnFinalSubmit');
  });

  test('a selector that matches nothing on the page permits nothing', async ({ page }) => {
    // A drifted profile, or a plan built against a page that has since changed.
    // Failing open here would mean any submit goes through whenever the
    // recorded button has been renamed.
    await withHarness(page, TWO_SUBMITS);
    await page.evaluate(() => window.__installGuard());
    await armFor(page, '#btnThatNoLongerExists');

    await page.locator('#btnFinalSubmit').click();
    await page.locator('#btnSaveDraft').click();

    const report = await page.evaluate(() => window.__guardReport());
    expect(report.submitEventsSeen).toBe(0);
    expect(report.blocked).toBeGreaterThan(0);
  });

  test('an empty selector permits nothing', async ({ page }) => {
    await withHarness(page, TWO_SUBMITS);
    await page.evaluate(() => window.__installGuard());
    await armFor(page, '');

    await page.locator('#btnFinalSubmit').click();

    const report = await page.evaluate(() => window.__guardReport());
    expect(report.submitEventsSeen).toBe(0);
  });

  test('a live approval does not carry a form the user never approved', async ({ page }) => {
    // The attack the target check exists for, and which no fixture could
    // express while every page had a single form: the page waits until the
    // user has approved something, then fires a submit of its own choosing
    // while the token is live.
    await withHarness(page, TWO_SUBMITS);
    await page.evaluate(() => window.__installGuard());
    await armFor(page, '#btnFinalSubmit');

    await page.evaluate(() => window.__submitOtherFormFromScript!());

    const report = await page.evaluate(() => window.__guardReport());
    expect(report.submitEventsSeen, 'a second form submitted on the first form’s token').toBe(0);
    expect(report.blocked).toBeGreaterThan(0);
    expect(report.armed, 'the approval the user actually gave was spent by an attack').toBe(true);
  });

  test('a malformed selector permits nothing rather than throwing', async ({ page }) => {
    // `querySelector` throws on invalid syntax, and the catch around it returns
    // false. A catch that returned true would be a bypass reachable by putting
    // a stray bracket in a taught profile.
    await withHarness(page, TWO_SUBMITS);
    await page.evaluate(() => window.__installGuard());
    await armFor(page, '#btn[[[unclosed');

    await page.locator('#btnFinalSubmit').click();

    const report = await page.evaluate(() => window.__guardReport());
    expect(report.submitEventsSeen).toBe(0);
    expect(report.blocked).toBeGreaterThan(0);
  });
});
