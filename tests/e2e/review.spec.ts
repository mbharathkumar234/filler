import { expect, test, type Page } from '@playwright/test';

/**
 * § Phase 7, in a real browser.
 *
 * The plan's Verify for this phase is a user-testing pass — three people, one
 * planted wrong value. That cannot be automated, and it is recorded as
 * outstanding rather than quietly substituted for.
 *
 * What *can* be checked here is the mechanical half the user-testing pass
 * assumes: that "show me this field" really points at that field, and that a
 * correction typed in the panel really lands in the page. jsdom has no layout,
 * so it cannot tell whether a highlight is over the input or in the corner of
 * the document.
 */

const UGLY = '/ugly-portal/page-1.html';

async function withHarness(page: Page, url: string) {
  await page.goto(url);
  const src = await page.evaluate(async () => {
    const html = await (await fetch('/_harness/index.html')).text();
    return /src="([^"]+)"/.exec(html)?.[1]?.replace('./', '/_harness/') ?? '';
  });
  expect(src).toBeTruthy();
  await page.addScriptTag({ url: src, type: 'module' });
  await page.waitForFunction(() => typeof window.__review?.collect === 'function');
}

test.describe('showing the user which field we mean', () => {
  test('puts the highlight over the field, not somewhere near it', async ({ page }) => {
    await withHarness(page, UGLY);

    const result = await page.evaluate(() => window.__review.focus('txtCity'));

    expect(result).not.toBeNull();
    if (!result) return;

    // The marker is drawn 3px outside the field on every side.
    expect(result.marker.top).toBeCloseTo(result.field.top - 3, 0);
    expect(result.marker.left).toBeCloseTo(result.field.left - 3, 0);
    expect(result.marker.width).toBeCloseTo(result.field.width + 6, 0);
    expect(result.marker.height).toBeCloseTo(result.field.height + 6, 0);
  });

  test('moves the caret there, for anyone not following a coloured outline', async ({ page }) => {
    await withHarness(page, UGLY);
    const result = await page.evaluate(() => window.__review.focus('txtCity'));
    expect(result?.focused).toBe(true);
  });

  test('does not touch the field it is pointing at', async ({ page }) => {
    await withHarness(page, UGLY);

    const before = await page.evaluate(() => document.getElementById('txtCity')!.outerHTML);
    const result = await page.evaluate(() => window.__review.focus('txtCity'));

    expect(result?.fieldHtml).toBe(before);
  });

  test('scrolls a field below the fold into view', async ({ page }) => {
    await withHarness(page, UGLY);
    await page.setViewportSize({ width: 800, height: 300 });

    const last = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('input[id]')];
      return inputs.at(-1)?.id ?? '';
    });
    expect(last).toBeTruthy();

    await page.evaluate((id) => window.__review.focus(id), last);
    // `scrollIntoView` is smooth, so give it a moment to settle.
    await page.waitForTimeout(600);

    const visible = await page.evaluate((id) => {
      const rect = document.getElementById(id)!.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight;
    }, last);
    expect(visible).toBe(true);
  });
});

test.describe('correcting a value from the panel', () => {
  test('writes it into the page and reports what landed', async ({ page }) => {
    await withHarness(page, UGLY);

    const outcome = await page.evaluate(() => window.__review.edit('txtCity', 'Mysuru'));

    expect(outcome).toMatchObject({ ok: true, value: 'Mysuru' });
    await expect(page.locator('#txtCity')).toHaveValue('Mysuru');
  });

  test('reports the shortened value when the field has a maxLength', async ({ page }) => {
    await withHarness(page, UGLY);

    const outcome = await page.evaluate(() => window.__review.edit('txtPin', '5600011234'));

    // The review must show what the portal will receive, not what we sent.
    expect(outcome.value).toBe('560001');
    await expect(page.locator('#txtPin')).toHaveValue('560001');
  });

  test('corrects a dropdown by its visible text', async ({ page }) => {
    await withHarness(page, UGLY);

    const outcome = await page.evaluate(() => window.__review.edit('ddlState', 'Tamil Nadu'));

    expect(outcome.ok).toBe(true);
    await expect(page.locator('#ddlState')).toHaveValue('TN');
  });

  test('collects back exactly what the page now holds', async ({ page }) => {
    await withHarness(page, UGLY);
    await page.evaluate(() => window.__review.edit('txtCity', 'Mysuru'));

    const values = await page.evaluate(() =>
      window.__review.collect(['txtCity', 'txtPin', 'ddlState']),
    );

    expect(values.txtCity).toBe('Mysuru');
    expect(Object.keys(values)).toEqual(['txtCity', 'txtPin', 'ddlState']);
  });
});
