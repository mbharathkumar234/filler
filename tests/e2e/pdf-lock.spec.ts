import { expect, test } from '@playwright/test';

/**
 * A locked PDF, opened by the real pdf.js the extension ships.
 *
 * `pdf-lock.test.ts` pins what saving does with a password; whether pdf.js
 * really opens an AES-256 e-Aadhaar with it — and refuses a wrong one — can
 * only be known by asking it. The files are made-up stand-ins
 * (`scripts/make-locked-pdf-fixtures.py`): an e-Aadhaar locked with RAVI1998,
 * and a certificate with an owner password only, which must open freely.
 */

const LOCKED = '/pdf/locked-aadhaar.pdf';
const OWNER_ONLY = '/pdf/owner-locked.pdf';

test.beforeEach(async ({ page }) => {
  await page.goto('/_harness/index.html');
  await page.waitForFunction(() => typeof window.__pdf === 'object');
});

test('a locked e-Aadhaar needs its password, and a wrong one does not open it', async ({ page }) => {
  expect(await page.evaluate((url) => window.__pdf.lock(url), LOCKED)).toBe('needs-password');
  expect(await page.evaluate((url) => window.__pdf.lock(url, 'ravi1998'), LOCKED)).toBe('wrong-password');
  expect(await page.evaluate((url) => window.__pdf.lock(url, 'RAVI1998'), LOCKED)).toBe('open');
});

test('a PDF with only an owner password opens without asking', async ({ page }) => {
  expect(await page.evaluate((url) => window.__pdf.lock(url), OWNER_ONLY)).toBe('open');
});

test('with its password, the e-Aadhaar reads exactly, number verified', async ({ page }) => {
  const found = await page.evaluate((url) => window.__pdf.read(url, 'RAVI1998'), LOCKED);
  const value = (key: string) => found.find((c) => c.key === key);
  expect(value('id.aadhaar')).toMatchObject({ value: '999999990019', verified: true });
  expect(value('identity.full_name')?.value).toBe('Ravi Kumar');
  expect(value('identity.dob')?.value).toBe('1998-03-14');
});

test('its page renders with the password, and not without it', async ({ page }) => {
  const page1 = await page.evaluate((url) => window.__pdf.raster(url, 'RAVI1998'), LOCKED);
  expect(page1.width).toBe(800);
  expect(page1.height).toBeGreaterThan(800);
  await expect(page.evaluate((url) => window.__pdf.raster(url), LOCKED)).rejects.toThrow();
});

test('the copy made for a portal opens without any password', async ({ page }) => {
  // Whoever opens it on the portal's side has no password, so the copy is an
  // ordinary file — for a PDF-only box as much as for an image one.
  for (const box of ['PDF only, up to 500 KB', 'JPEG, up to 300 KB']) {
    const copy = await page.evaluate(
      ([url, constraint]) => window.__pdf.derive(url, 'RAVI1998', constraint),
      [LOCKED, box] as const,
    );
    expect(copy.ok, copy.reason).toBe(true);
    expect(copy.opensWithoutPassword, box).toBe(true);
  }
});
