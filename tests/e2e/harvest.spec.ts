import { expect, test, type Page } from '@playwright/test';

/**
 * The harvester, in a real browser.
 *
 * The unit suite runs under jsdom, which has no layout engine and does not
 * really enforce cross-origin boundaries. Three things are therefore only
 * testable here:
 *
 *   - visibility that depends on layout (zero-size, clipped, off-flow)
 *   - a genuinely unreadable cross-origin iframe
 *   - that the harvester leaves a real, script-bearing page untouched
 *
 * The harness bundle exposes `window.__harvest`; see tests/e2e/harness.
 */

const UGLY = '/ugly-portal/page-1.html';
const DEMO = '/demo-portal/page-1.html';

/** Inject the harness bundle into whatever page is loaded. */
async function withHarvester(page: Page, url: string) {
  await page.goto(url);
  const src = await page.evaluate(async () => {
    const html = await (await fetch('/_harness/index.html')).text();
    return /src="([^"]+)"/.exec(html)?.[1]?.replace('./', '/_harness/') ?? '';
  });
  expect(src).toBeTruthy();
  await page.addScriptTag({ url: src, type: 'module' });
  await page.waitForFunction(() => typeof window.__harvest === 'function');
}

test('harvests the ugly portal with real layout', async ({ page }) => {
  await withHarvester(page, UGLY);
  const result = await page.evaluate(() => window.__harvest());

  expect(result.fields.length).toBeGreaterThan(15);
  expect(result.visibleCount).toBeGreaterThan(0);
});

test('meets the ≥95% labelled bar on visible fields', async ({ page }) => {
  await withHarvester(page, UGLY);
  const result = await page.evaluate(() => window.__harvest());

  const percent = (result.labelledCount / result.visibleCount) * 100;
  const unlabelled = result.fields
    .filter((f) => f.visible && f.labelText.trim() === '')
    .map((f) => f.selectors[0]);

  expect(percent, `unlabelled: ${unlabelled.join(', ')}`).toBeGreaterThanOrEqual(95);
});

test('meets the bar on the demo portal too', async ({ page }) => {
  await withHarvester(page, DEMO);
  const result = await page.evaluate(() => window.__harvest());
  expect((result.labelledCount / result.visibleCount) * 100).toBeGreaterThanOrEqual(95);
});

test('marks a display:none field hidden using real computed style', async ({ page }) => {
  await withHarvester(page, UGLY);
  const result = await page.evaluate(() => window.__harvest());

  const hidden = result.fields.find((f) => f.labelText === 'Revealed Later');
  expect(hidden).toBeDefined();
  expect(hidden?.visible).toBe(false);
});

test('marks a zero-size field hidden — something jsdom cannot detect', async ({ page }) => {
  await withHarvester(page, UGLY);
  const result = await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'collapsed';
    input.setAttribute('aria-label', 'Collapsed Field');
    input.style.width = '0';
    input.style.height = '0';
    input.style.padding = '0';
    input.style.border = 'none';
    document.body.append(input);
    return window.__harvest();
  });

  const collapsed = result.fields.find((f) => f.labelText === 'Collapsed Field');
  expect(collapsed).toBeDefined();
  expect(collapsed?.visible).toBe(false);
});

test('reports a genuinely cross-origin iframe as a blocker', async ({ page }) => {
  await withHarvester(page, UGLY);
  const result = await page.evaluate(() => window.__harvest());

  const frame = result.blockers.find((b) => b.reason.includes('payments.example.com'));
  expect(frame).toBeDefined();
  expect(frame?.type).toBe('unknown_widget');
});

test('reports the CAPTCHA field without harvesting it', async ({ page }) => {
  await withHarvester(page, UGLY);
  const result = await page.evaluate(() => window.__harvest());

  expect(result.blockers.some((b) => b.type === 'captcha')).toBe(true);
  expect(result.fields.some((f) => f.selectors.some((s) => /captcha/i.test(s)))).toBe(false);
});

test('never harvests a password field', async ({ page }) => {
  await withHarvester(page, UGLY);
  const result = await page.evaluate(() => window.__harvest());
  expect(result.fields.some((f) => /password/i.test(f.labelText))).toBe(false);
});

test('leaves the page byte-identical — a portal cannot tell it was read', async ({ page }) => {
  await withHarvester(page, UGLY);

  const { before, after } = await page.evaluate(() => {
    const before = document.body.innerHTML;
    window.__harvest();
    return { before, after: document.body.innerHTML };
  });

  expect(after).toBe(before);
});

test('resolves the primary selector back to the right element', async ({ page }) => {
  await withHarvester(page, UGLY);

  const mismatches = await page.evaluate(() => {
    const result = window.__harvest();
    const bad: string[] = [];
    for (const field of result.fields) {
      const selector = field.selectors[0];
      if (!selector || selector.startsWith('//')) continue;
      try {
        if (!document.querySelector(selector)) bad.push(`${field.labelText}: ${selector}`);
      } catch {
        bad.push(`${field.labelText}: invalid selector ${selector}`);
      }
    }
    return bad;
  });

  expect(mismatches).toEqual([]);
});

test('label-anchored XPath selectors actually resolve', async ({ page }) => {
  await withHarvester(page, UGLY);

  const broken = await page.evaluate(() => {
    const result = window.__harvest();
    const bad: string[] = [];
    for (const field of result.fields) {
      for (const selector of field.selectors.filter((s) => s.startsWith('//'))) {
        const found = document.evaluate(
          selector,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null,
        ).singleNodeValue;
        if (!found) bad.push(`${field.labelText}: ${selector}`);
      }
    }
    return bad;
  });

  expect(broken).toEqual([]);
});
