import { expect, test, type Page } from '@playwright/test';

/**
 * §Phase 9 Verify, in a real browser:
 *
 *   "take a fixture, rename every `id`, reload. The extension must detect
 *    drift, enter teach mode, and after ~2 minutes of user clicking, fill
 *    correctly again — with a bumped profile version."
 *
 * `fixtures/postback-portal/` renames every element id on every render, so
 * "rename every id, reload" is what that page does by itself — no test-only
 * mutation, and no way for the fixture to quietly stop being adversarial.
 *
 * The modules under test are the shipping ones: the picker's `describeElement`,
 * `profileHealth`, `buildTaughtProfile` with its measured `survives` probe, and
 * the `locateBySelector` the matcher actually uses. The harness supplies only
 * the human — which field is pointed at, and what it is called.
 */

const PORTAL = '/postback-portal/page-1.html';

/** What a user would teach, by the `name` they can see the field under. */
const MAPPING = {
  txtName: 'identity.full_name',
  txtFather: 'family.father_name',
  txtEmail: 'contact.email',
  txtMobile: 'contact.mobile',
  txtPin: 'address.permanent.pincode',
} as const;

const VALUES = {
  'identity.full_name': 'Ravi Kumar',
  'family.father_name': 'Suresh Kumar',
  'contact.email': 'ravi@example.com',
  'contact.mobile': '9876543210',
  'address.permanent.pincode': '560001',
} as const;

async function attachHarness(page: Page) {
  const src = await page.evaluate(async () => {
    const html = await (await fetch('/_harness/index.html')).text();
    return /src="([^"]+)"/.exec(html)?.[1]?.replace('./', '/_harness/') ?? '';
  });
  expect(src).toBeTruthy();
  await page.addScriptTag({ url: src, type: 'module' });
  await page.waitForFunction(() => typeof window.__teach?.health === 'function');
}

async function open(page: Page) {
  await page.goto(PORTAL);
  await attachHarness(page);
  await page.evaluate(() => window.__teach.resetProfile());
}

/** Reload the portal — which regenerates every id — and re-attach. */
async function reload(page: Page) {
  await page.reload();
  await attachHarness(page);
}

async function currentIds(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll('[data-af]')].map((el) => el.id));
}

test.describe('the fixture really does rename everything', () => {
  test('no element id survives a reload', async ({ page }) => {
    // The premise. Without this the whole spec could pass on a page that never
    // drifted at all.
    await open(page);
    const before = await currentIds(page);

    await reload(page);
    const after = await currentIds(page);

    expect(before.every((id) => id.length > 0)).toBe(true);
    expect(after.some((id) => before.includes(id))).toBe(false);
  });
});

test.describe('drift detection', () => {
  test('a profile built on ids is healthy before the reload', async ({ page }) => {
    await open(page);
    await page.evaluate((mapping) => window.__teach.recordIdOnlyProfile(mapping), MAPPING);

    const health = await page.evaluate(() => window.__teach.health());
    expect(health).toMatchObject({ resolved: 5, total: 5, rate: 1, stale: false });
  });

  test('and is stale the moment the ids are regenerated', async ({ page }) => {
    await open(page);
    await page.evaluate((mapping) => window.__teach.recordIdOnlyProfile(mapping), MAPPING);

    await reload(page);

    const health = await page.evaluate(() => window.__teach.health());
    expect(health!.resolved).toBe(0);
    expect(health!.stale).toBe(true);
    // It names what broke, which is what the repair prompt lists.
    expect(health!.broken.sort()).toEqual(Object.values(MAPPING).sort());
  });

  test('a stale profile is not used to fill a half-broken form', async ({ page }) => {
    // The point of the threshold. Filling five fields out of twenty looks
    // finished, which is worse than filling none.
    await open(page);
    await page.evaluate((mapping) => window.__teach.recordIdOnlyProfile(mapping), MAPPING);
    await reload(page);

    const filled = await page.evaluate((values) => window.__teach.fill(values), VALUES);
    expect(filled).toBe(0);
  });
});

test.describe('repair', () => {
  test('the whole journey: drift, teach, fill again, bumped version', async ({ page }) => {
    await open(page);

    // 1. A profile recorded before the redesign.
    await page.evaluate((mapping) => window.__teach.recordIdOnlyProfile(mapping), MAPPING);
    expect(await page.evaluate(() => window.__teach.profileVersion())).toBe(1);

    // 2. The portal re-renders with new ids. Everything breaks.
    await reload(page);
    expect((await page.evaluate(() => window.__teach.health()))!.stale).toBe(true);

    // 3. The user points at each field and says what it is.
    const saved = await page.evaluate((mapping) => window.__teach.teachAndSave(mapping), MAPPING);
    expect(saved.version).toBe(2);
    expect(saved.fields).toBe(5);

    // 4. Healthy again, on this render.
    expect((await page.evaluate(() => window.__teach.health()))!.stale).toBe(false);

    // 5. And still healthy after *another* rename — which is the real test.
    //    A repair that only worked until the next postback would be no repair.
    await reload(page);
    const health = await page.evaluate(() => window.__teach.health());
    expect(health).toMatchObject({ resolved: 5, total: 5, stale: false });

    // 6. It fills, correctly.
    const filled = await page.evaluate((values) => window.__teach.fill(values), VALUES);
    expect(filled).toBe(5);

    await expect(page.locator('[name="txtName"]')).toHaveValue('Ravi Kumar');
    await expect(page.locator('[name="txtEmail"]')).toHaveValue('ravi@example.com');
    await expect(page.locator('[name="txtPin"]')).toHaveValue('560001');
  });

  test('records a selector that survived the rename, not the id that did not', async ({ page }) => {
    // The plan's "prefers selectors that survive across regenerated-ID
    // variants", measured rather than assumed.
    await open(page);
    await reload(page);
    await page.evaluate((mapping) => window.__teach.teachAndSave(mapping), MAPPING);

    const selectors = await page.evaluate(() =>
      window.__teach.selectorsFor('identity.full_name'),
    );

    expect(selectors[0]).toBe('input[name="txtName"]');
    // The id is kept, just last — it may come back on another render, and
    // dropping it would lose information for one failed lookup's worth of cost.
    expect(selectors.some((selector) => selector.startsWith('#'))).toBe(true);
  });

  test('teaching one field keeps the others', async ({ page }) => {
    await open(page);
    await page.evaluate((mapping) => window.__teach.teachAndSave(mapping), MAPPING);
    await reload(page);

    await page.evaluate(() => window.__teach.teachAndSave({ txtName: 'identity.full_name' }));

    const health = await page.evaluate(() => window.__teach.health());
    expect(health!.total).toBe(5);
    expect(await page.evaluate(() => window.__teach.profileVersion())).toBe(2);
  });

  test('refuses to teach the CAPTCHA box', async ({ page }) => {
    // P4 reaches teach mode too: there is no key in the taxonomy to teach a
    // security control to, and the refusal says so rather than doing nothing.
    await open(page);
    const picked = await page.evaluate(() => window.__teach.pick('txtCaptcha'));

    expect(picked?.refused).toMatch(/security field/i);
  });

  test('a pick carries selectors and a label, never a value', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      const el = document.getElementsByName('txtName')[0] as HTMLInputElement | undefined;
      if (el) el.value = 'Ravi Kumar Chandrasekaran';
    });

    const picked = await page.evaluate(() => window.__teach.pick('txtName'));

    expect(JSON.stringify(picked)).not.toContain('Ravi Kumar Chandrasekaran');
    expect(picked?.selectors.length).toBeGreaterThan(0);
  });
});
