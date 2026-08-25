import { expect, test } from '@playwright/test';

/**
 * Phase 0 smoke test. It proves only that the fixture harness works end to end:
 * the server starts, serves the demo form, and does not escape its root.
 *
 * Real fill/review e2e coverage arrives in Phase 5.
 */
test.describe('fixture harness', () => {
  test('serves the demo portal form', async ({ page }) => {
    await page.goto('/demo-portal/page-1.html');
    await expect(page.locator('#frmApply')).toBeVisible();
    await expect(page.locator('#txtFName')).toBeVisible();
    await expect(page.locator('#btnFinalSubmit')).toHaveText('Final Submit');
  });

  test('lists available fixture portals at the root', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'demo-portal' })).toBeVisible();
  });

  test('refuses to serve files outside fixtures/', async ({ request }) => {
    const res = await request.get('/../package.json');
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });
})
