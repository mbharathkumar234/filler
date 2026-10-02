import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type BrowserContext, type Worker } from '@playwright/test';

/**
 * The built extension, loaded into a real browser (§ the gap three bugs fell
 * through).
 *
 * ## Why this exists
 *
 * Three bugs in a row shipped because every test ran the code somewhere more
 * permissive than production:
 *
 *  - `window is not defined` — unit tests run in Node and jsdom, and the
 *    Playwright suite drives a *page*. None of them is a service worker.
 *  - The toolbar click granted no `activeTab` — no test has a real
 *    `chrome.action`.
 *  - **The content script never parsed.** It was built as an ES module, and
 *    `executeScript({ files })` injects a classic script. The existing suite
 *    loads it with `addScriptTag({ type: 'module' })`, which exercises all of
 *    the code and none of the injection.
 *
 * Each was invisible to 1,895 unit tests and 76 e2e runs. Coverage and mutation
 * score say nothing whatever about this class: the code was correct, and the
 * place it ran was not real.
 *
 * So this spec loads `dist/` as an unpacked extension and drives the actual
 * service worker. It is the only test here that would have caught any of them.
 *
 * ## What it can and cannot reach
 *
 * `chrome.scripting.executeScript` needs `activeTab` or a host permission even
 * for the extension's own pages, and `activeTab` needs a real toolbar click —
 * which Playwright cannot perform, because browser chrome is outside the page.
 * Attempting it here returns the same "Cannot access contents of the page" the
 * product reports, which is a pleasing confirmation of the permission model and
 * no use as a test.
 *
 * So the script is loaded the one way that needs no permission: as a **classic
 * script tag** on an extension page, where `chrome` is real. That covers
 * exactly what broke —
 *
 *  - does `content.js` parse at all as a classic script (the ES-module bug), and
 *  - does it finish wiring without throwing (the self-locking flag).
 *
 * It does not exercise `executeScript` itself. `content-script-format.test.ts`
 * asserts the property that makes injection possible; this asserts the file
 * actually runs. The step still untested by anything is the injection call on a
 * page the user has granted — that needs a toolbar click, and is noted in
 * STATUS.md as the remaining gap.
 */

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist');

let context: BrowserContext | null = null;

test.afterEach(async () => {
  await context?.close();
  context = null;
});

async function launch(): Promise<{ context: BrowserContext; worker: Worker; id: string }> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'autofill-ext-'));

  const launched = await chromium.launchPersistentContext(userDataDir, {
    // Extensions require a headed context. `--headless=new` also works, and is
    // what makes this runnable on a machine with no display.
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
    ],
  });

  const worker = launched.serviceWorkers()[0] ?? (await launched.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).host;

  return { context: launched, worker, id };
}

test.describe('the extension as Chrome actually loads it', () => {
  test('the service worker starts without throwing', async () => {
    const launched = await launch();
    context = launched.context;

    // Reaching here at all means the worker evaluated. `window is not defined`
    // at module scope would have stopped it dead, which is what shipped.
    expect(launched.id).toMatch(/^[a-p]{32}$/);
    expect(await launched.worker.evaluate(() => chrome.runtime.id)).toBe(launched.id);
  });

  test('the service worker registers an action handler, which is what grants activeTab', async () => {
    const launched = await launch();
    context = launched.context;

    const wired = await launched.worker.evaluate(() => chrome.action.onClicked.hasListeners());
    expect(wired, 'without this the toolbar click grants nothing').toBe(true);
  });

  test('content.js is actually in the package', async () => {
    /*
     * The build used to emit it from a second command in `package.json`, and a
     * `dist` was produced without it. Chrome reports that as
     * "Could not load file: 'content.js'" — which reads like yet another
     * mysterious scan failure and is really a missing file.
     *
     * Fetching it from the extension's own origin is exactly what
     * `executeScript` has to do, so this fails for the same reason Chrome does.
     */
    const launched = await launch();
    context = launched.context;

    const page = await launched.context.newPage();
    await page.goto(`chrome-extension://${launched.id}/practice/first-fill.html`);

    const status = await page.evaluate(async () => {
      const response = await fetch('/content.js');
      return { ok: response.ok, length: (await response.text()).length };
    });

    expect(status.ok, 'content.js is missing from the built extension').toBe(true);
    expect(status.length).toBeGreaterThan(1000);
  });

  test('the content script parses as a classic script', async () => {
    /*
     * The bug this is for. As an ES module the file failed with "Cannot use
     * import statement outside a module" the instant Chrome tried to run it —
     * nothing parsed, nothing wired, and every scan reported that no frame had
     * answered.
     */
    const launched = await launch();
    context = launched.context;

    const page = await launched.context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto(`chrome-extension://${launched.id}/practice/first-fill.html`);
    await page.waitForSelector('#p-name');

    /*
     * By URL, not by path. `addScriptTag({ path })` inlines the file, and the
     * extension's own CSP is `script-src 'self'` — no inline scripts, which is
     * a hardening rule worth keeping rather than working around. Loading
     * `/content.js` from the extension's own origin satisfies `'self'`.
     *
     * And no `type: 'module'`, which is the whole point: this is how Chrome
     * runs an injected script.
     */
    await page.addScriptTag({ url: '/content.js' });

    expect(errors, 'the content script did not survive being run').toEqual([]);
  });

  test('the content script finishes wiring itself', async () => {
    // The flag is set at the *end* now. If anything in the wiring throws it is
    // cleared again, so `true` here means every listener was registered —
    // including the message listener whose absence produced "nothing answered".
    const launched = await launch();
    context = launched.context;

    const page = await launched.context.newPage();
    await page.goto(`chrome-extension://${launched.id}/practice/first-fill.html`);
    await page.waitForSelector('#p-name');
    await page.addScriptTag({ url: '/content.js' });

    const ready = await page.evaluate(() => (window as { __autofillContentReady?: boolean }).__autofillContentReady);
    expect(ready).toBe(true);
  });

  /*
   * The guard in the artefact that ships, against the bug that made it matter.
   *
   * It used to switch on the moment the content script arrived, and refuse
   * every submit until an approval. On pages the extension had never filled
   * that meant refusing the user's own "Sign In" — the login of an unrelated
   * local project and a government hostel portal, neither of which the
   * extension had been opened on. The guard is for *our* fill (P2); a page we
   * have not written to is the user's.
   *
   * The required fields are filled first, and that is not incidental: the
   * practice form has three, and an empty required field makes the browser
   * refuse the submit on its own, so a test of "the submit went through"
   * would pass for the wrong reason.
   */
  const fillRequired = () => {
    for (const input of document.querySelectorAll<HTMLInputElement>('input[required]')) {
      input.value = input.type === 'email' ? 'someone@example.test' : '1234567890';
    }
  };
  const trySubmit = () => {
    const form = document.getElementById('practice') as HTMLFormElement;
    let submitted = false;
    form.addEventListener('submit', (event) => {
      submitted = true;
      event.preventDefault();
    });
    (document.getElementById('p-submit') as HTMLButtonElement).click();
    return submitted;
  };

  test('leaves the user’s own submit alone on a page it has not filled', async () => {
    const launched = await launch();
    context = launched.context;

    const page = await launched.context.newPage();
    await page.goto(`chrome-extension://${launched.id}/practice/first-fill.html`);
    await page.waitForSelector('#p-submit');
    // The content script as a scan leaves it: loaded, wired, nothing filled.
    await page.addScriptTag({ url: '/content.js' });
    await page.waitForFunction(() => (window as { __autofillContentReady?: boolean }).__autofillContentReady);
    await page.evaluate(fillRequired);

    expect(await page.evaluate(trySubmit), 'the user pressed Submit and was refused').toBe(true);
    await expect(page.getByText('Submission blocked')).toHaveCount(0);
  });

  test('hands the page back when it loads before the page and no run is live', async () => {
    /*
     * The per-origin document_start script, as one earlier fill left it
     * registered: it loads before the page, on a site nobody is filling now.
     * It starts engaged — the one case it exists for is a postback carrying
     * our values — asks the worker about this tab, and must stand down.
     */
    const launched = await launch();
    context = launched.context;
    await launched.context.addInitScript({ path: `${DIST}/content.js` });

    const page = await launched.context.newPage();
    await page.goto(`chrome-extension://${launched.id}/practice/first-fill.html`);
    await page.waitForSelector('#p-submit');
    await page.evaluate(fillRequired);

    // The round trip to the worker, then the user presses Sign In.
    await expect.poll(() => page.evaluate(trySubmit), { timeout: 5_000 }).toBe(true);
  });

  test('the guard stays out of sub-frames, where nothing is ever written', async () => {
    /*
     * Every write addresses the top frame, so a guard in a sub-frame protects
     * nothing of ours — and inside a site's own upload window (Google Forms'
     * is a same-origin frame) it blocked the user's own press on Upload.
     *
     * Both halves are shown in one page: the same bundle, injected into the
     * top document and into a frame, guards the first and not the second.
     */
    const launched = await launch();
    context = launched.context;

    const page = await launched.context.newPage();
    await page.goto(`chrome-extension://${launched.id}/practice/first-fill.html`);
    await page.waitForSelector('#p-submit');
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.name = 'window';
      frame.src = '/practice/first-fill.html';
      document.body.append(frame);
    });
    const frame = await (async () => {
      for (;;) {
        const found = page.frame({ name: 'window' });
        if (found) {
          await found.waitForSelector('#p-submit');
          return found;
        }
        await page.waitForTimeout(50);
      }
    })();

    await page.addScriptTag({ url: '/content.js' });
    await frame.addScriptTag({ url: '/content.js' });

    // A fill reaches the page — with nothing to write, which is still the
    // moment the page starts carrying a fill of ours and the guard engages.
    // Both copies hear it; only the top frame has a guard to engage.
    await launched.worker.evaluate(() =>
      chrome.runtime
        .sendMessage({ __af: true, at: Date.now(), payload: { type: 'fill:apply', writes: [] } })
        .catch(() => null),
    );

    const trySubmit = () => {
      for (const input of document.querySelectorAll<HTMLInputElement>('input[required]')) {
        input.value = input.type === 'email' ? 'someone@example.test' : '1234567890';
      }
      const form = document.getElementById('practice') as HTMLFormElement;
      let submitted = false;
      form.addEventListener('submit', (event) => {
        submitted = true;
        event.preventDefault();
      });
      form.requestSubmit();
      return submitted;
    };

    expect(
      await frame.evaluate(() => (window as { __autofillContentReady?: boolean }).__autofillContentReady),
      'the frame copy must have wired itself, or this proves nothing',
    ).toBe(true);
    await expect
      .poll(() => page.evaluate(trySubmit), { message: 'the top frame lost its guard' })
      .toBe(false);
    expect(await frame.evaluate(trySubmit), 'a guard was installed in a sub-frame').toBe(true);
  });
});
