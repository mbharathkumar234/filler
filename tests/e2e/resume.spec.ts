import { expect, test, type Page } from '@playwright/test';

/**
 * §Phase 6 Verify, in a real browser:
 *
 *   "build a fixture that (a) resets all field values on a simulated postback,
 *    (b) regenerates element IDs each load, (c) contains a fake CAPTCHA gate.
 *    The run must pause, resume after the user 'solves' it, detect the reset,
 *    refill, and reach REVIEW with correct data. Run it 20x — flakiness here is
 *    a real defect, not test noise."
 *
 * jsdom cannot do this honestly: it has no layout, its MutationObserver
 * batching is not the browser's, and a page cannot really reload. The reducer,
 * the blocker detector and the re-verification pass all have unit suites; what
 * is only true here is that they work *together*, against a page that behaves
 * as badly as a real portal.
 */

const POSTBACK = '/postback-portal/page-1.html';

const VALUES = {
  txtName: 'Ravi Kumar',
  txtFather: 'Suresh Kumar',
  txtEmail: 'ravi@example.com',
  txtMobile: '9876543210',
  txtPin: '560001',
  ddlState: 'KA',
};

async function withHarness(page: Page, url: string) {
  await page.goto(url);
  const src = await page.evaluate(async () => {
    const html = await (await fetch('/_harness/index.html')).text();
    return /src="([^"]+)"/.exec(html)?.[1]?.replace('./', '/_harness/') ?? '';
  });
  expect(src).toBeTruthy();
  await page.addScriptTag({ url: src, type: 'module' });
  await page.waitForFunction(() => typeof window.__run?.start === 'function');
  await page.evaluate(() => window.__run.reset());
}

test.describe('the fixture is as hostile as it claims', () => {
  test('regenerates every element id on each render', async ({ page }) => {
    await withHarness(page, POSTBACK);

    const before = await page.evaluate(() =>
      [...document.querySelectorAll('[data-af]')].map((el) => el.id),
    );
    await page.evaluate(() => window.__postback());
    const after = await page.evaluate(() =>
      [...document.querySelectorAll('[data-af]')].map((el) => el.id),
    );

    expect(before.every((id) => id.length > 0)).toBe(true);
    // Not one id survives. Any selector strategy resting on ids is dead here.
    expect(after.some((id) => before.includes(id))).toBe(false);
  });

  test('wipes every value on a postback', async ({ page }) => {
    await withHarness(page, POSTBACK);
    await page.evaluate(() => {
      const el = document.getElementsByName('txtName')[0] as HTMLInputElement | undefined;
      if (el) el.value = 'typed by hand';
    });

    await page.evaluate(() => window.__postback());

    const values = await page.evaluate(() => window.__run.values());
    expect(Object.values(values).every((value) => value === '')).toBe(true);
  });
});

test.describe('a run that has to survive a portal', () => {
  test('pauses at the CAPTCHA without filling anything', async ({ page }) => {
    await withHarness(page, POSTBACK);

    const state = await page.evaluate((values) => window.__run.start(values), VALUES);

    expect(state).toBe('BLOCKED');
    expect(await page.evaluate(() => window.__run.blocker())).toBe('captcha');

    // P4, at the point it matters: the run stopped *before* writing, so the
    // page holds nothing of ours while a security control is unresolved.
    const values = await page.evaluate(() => window.__run.values());
    expect(Object.values(values).every((value) => value === '')).toBe(true);
  });

  test('tells the user what to do in our words, not the page’s', async ({ page }) => {
    await withHarness(page, POSTBACK);
    await page.evaluate((values) => window.__run.start(values), VALUES);

    const instruction = await page.evaluate(() => window.__run.instruction());
    expect(instruction).toMatch(/complete it yourself/i);
    expect(instruction).toMatch(/will not read or solve it/i);
    // The fixture's own words are "Type the characters shown in the image".
    expect(instruction).not.toMatch(/type the characters/i);
  });

  test('will not resume just because the user says so, if the gate is still up', async ({
    page,
  }) => {
    await withHarness(page, POSTBACK);
    await page.evaluate((values) => window.__run.start(values), VALUES);

    // The user presses "I have completed this" without having done it.
    const state = await page.evaluate(() => window.__run.continue());

    expect(state).toBe('BLOCKED');
    const values = await page.evaluate(() => window.__run.values());
    expect(Object.values(values).every((value) => value === '')).toBe(true);
  });

  test('never reads the challenge, even while blocked by it', async ({ page }) => {
    await withHarness(page, POSTBACK);
    await page.evaluate((values) => window.__run.start(values), VALUES);

    // The fixture's CAPTCHA image encodes the string X7KQ9. Nothing the run
    // has produced may contain it.
    const trace = await page.evaluate(() =>
      JSON.stringify({
        events: window.__run.events(),
        instruction: window.__run.instruction(),
        values: window.__run.values(),
      }),
    );
    expect(trace).not.toContain('X7KQ9');
  });

  test('the full journey: pause, solve, resume, detect the reset, refill, review', async ({
    page,
  }) => {
    await withHarness(page, POSTBACK);

    // 1. The run starts and stops at the gate.
    expect(await page.evaluate((values) => window.__run.start(values), VALUES)).toBe('BLOCKED');

    // 2. The user solves it themselves.
    await page.evaluate(() => window.__solveCaptcha());

    // 3. …and says so. The run re-verifies rather than trusting them.
    expect(await page.evaluate(() => window.__run.continue())).toBe('REVIEW');

    // 4. Nothing was on the page yet, so re-verification refilled everything.
    const afterFill = await page.evaluate(() => window.__run.values());
    expect(afterFill).toMatchObject(VALUES);

    // 5. Now the portal does what portals do: a postback that regenerates
    //    every id and empties every box.
    await page.evaluate(() => window.__postback());
    await page.evaluate(() => window.__run.checkPage());
    await expect
      .poll(() => page.evaluate(() => window.__run.state()), { timeout: 5000 })
      .toBe('REVIEW');

    // 6. The values are back — found through the *name* selectors, because
    //    every id they were filled under no longer exists.
    const afterPostback = await page.evaluate(() => window.__run.values());
    expect(afterPostback).toMatchObject(VALUES);

    // 7. And the run says it is ready for review, not "filled".
    expect(await page.evaluate(() => window.__run.state())).toBe('REVIEW');
  });

  test('resumes a persisted run in a freshly loaded document', async ({ page }) => {
    await withHarness(page, POSTBACK);
    await page.evaluate((values) => window.__run.start(values), VALUES);
    await page.evaluate(() => window.__solveCaptcha());
    await page.evaluate(() => window.__run.continue());

    // A real navigation. Everything in memory is destroyed; the run is not.
    await page.reload();
    const src = await page.evaluate(async () => {
      const html = await (await fetch('/_harness/index.html')).text();
      return /src="([^"]+)"/.exec(html)?.[1]?.replace('./', '/_harness/') ?? '';
    });
    await page.addScriptTag({ url: src, type: 'module' });
    await page.waitForFunction(() => typeof window.__run?.resume === 'function');

    // The reloaded page has the CAPTCHA back and every box empty, so the
    // restored run must block again rather than sail on to review.
    const state = await page.evaluate(() => window.__run.resume());
    expect(state).toBe('BLOCKED');
    expect(await page.evaluate(() => window.__run.blocker())).toBe('captcha');

    // And it is genuinely the *persisted* run: nothing rebuilt the plan from
    // the page, so the six fields came back out of storage — carrying
    // selectors recorded under element ids this reload has already destroyed.
    expect(await page.evaluate(() => window.__run.planSize())).toBe(6);
    expect(await page.evaluate(() => window.__run.values())).toMatchObject({
      txtName: '',
      txtEmail: '',
    });
  });

  test('a mutation storm forces re-verification without anyone asking', async ({ page }) => {
    await withHarness(page, POSTBACK);
    await page.evaluate((values) => window.__run.start(values), VALUES);
    await page.evaluate(() => window.__solveCaptcha());
    await page.evaluate(() => window.__run.continue());

    const before = await page.evaluate(() => window.__run.events().length);
    await page.evaluate(() => window.__postback());

    // No `continue`, no `reverify` — only the observer noticing.
    //
    // Polled on the *values*, not on the refill event: the event is pushed
    // when the refill starts, and a refill writes fields one at a time with a
    // deliberate gap between them (§Phase 5). Reading straight after the event
    // catches the run mid-write and fails on the fields it has not reached
    // yet — a race in the test, not in the code.
    await expect
      .poll(() => page.evaluate(() => window.__run.values()), { timeout: 10_000 })
      .toMatchObject(VALUES);

    const events = await page.evaluate(() => window.__run.events());
    expect(events.slice(before).some((event) => event.startsWith('refill:'))).toBe(true);
  });
});

/**
 * The flakiness gate the plan asks for by name.
 *
 * Twenty full journeys. `retries: 0` is set in the Playwright config for this
 * reason — a pass here that needed a retry would be exactly the defect this
 * test exists to catch.
 */
test.describe('twenty consecutive runs', () => {
  test.describe.configure({ retries: 0 });

  test('every one of them reaches REVIEW with the right data', async ({ page }) => {
    test.setTimeout(180_000);

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      await withHarness(page, POSTBACK);

      const blocked = await page.evaluate((values) => window.__run.start(values), VALUES);
      expect(blocked, `run ${attempt}: should stop at the CAPTCHA`).toBe('BLOCKED');

      await page.evaluate(() => window.__solveCaptcha());
      const resumed = await page.evaluate(() => window.__run.continue());
      expect(resumed, `run ${attempt}: should reach review after resuming`).toBe('REVIEW');

      await page.evaluate(() => window.__postback());
      await page.evaluate(() => window.__run.checkPage());
      await expect
        .poll(() => page.evaluate(() => window.__run.state()), { timeout: 5000 })
        .toBe('REVIEW');

      const values = await page.evaluate(() => window.__run.values());
      expect(values, `run ${attempt}: values after the postback`).toMatchObject(VALUES);
    }
  });
});
