import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * The toolbar click has to reach the extension (§ found in use).
 *
 * ## The bug
 *
 * `activeTab` — the entire basis on which this extension reads a page — is
 * granted when the user **invokes** the extension. Clicking the toolbar icon is
 * an invocation only if the click is actually dispatched to the extension.
 *
 * The worker set `openPanelOnActionClick: true`, which tells Chrome to open the
 * side panel *instead of* dispatching the click. `chrome.action.onClicked`
 * therefore never fired, the extension was never invoked, and `activeTab` was
 * never granted. Pressing Scan on any ordinary web page failed with "Cannot
 * access contents of the page", and the panel's own advice — click the icon —
 * could not work, because the click was being swallowed before it arrived.
 *
 * Nothing caught it because nothing here can: no unit test has a real
 * `chrome.action`, and the Playwright suite drives a harness page rather than a
 * loaded extension. This is a source assertion instead — the same approach
 * `blockers.ts` uses for its own rule — and it is worth having precisely
 * because the failure is silent and total.
 *
 * ## What must stay true
 *
 * Both halves, together. Either alone reproduces the bug: no listener and the
 * click grants nothing; `openPanelOnActionClick: true` and the listener never
 * runs.
 */

const WORKER = 'src/background/index.ts';

async function source(): Promise<string> {
  const text = await readFile(WORKER, 'utf8');
  // Comments discuss the old setting on purpose. Judge the code only.
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

describe('the action click', () => {
  it('is dispatched to us rather than swallowed by the panel', async () => {
    const code = await source();
    expect(code).toMatch(/openPanelOnActionClick:\s*false/);
    expect(code, 'true here means the click never reaches the extension').not.toMatch(
      /openPanelOnActionClick:\s*true/,
    );
  });

  it('is listened for, which is what grants activeTab', async () => {
    const code = await source();
    expect(code).toMatch(/chrome\.action\??\.?onClicked\??\.?\.addListener/);
  });

  it('opens the panel, so the icon still does what a user expects', async () => {
    const code = await source();
    expect(code).toMatch(/chrome\.sidePanel\.open\(/);
  });

  it('opens the panel before anything is awaited', async () => {
    /*
     * `chrome.sidePanel.open()` must be called inside the user gesture. An
     * `await` before it loses the gesture and the panel silently fails to
     * open — which would look to the user exactly like the icon being dead.
     */
    const code = await source();
    const listener = /onClicked\??\.?\.addListener\(([\s\S]*?)\n\}\);/.exec(code)?.[1] ?? '';
    expect(listener, 'the listener body was not found; update this test').toContain('sidePanel.open');

    const beforeOpen = listener.slice(0, listener.indexOf('sidePanel.open'));
    expect(beforeOpen, 'something is awaited before the panel is opened').not.toContain('await');
  });

  it('applies the panel behaviour on every worker start, not only on install', async () => {
    // The setting persists, so an extension already carrying the old value
    // would keep swallowing clicks until it was reinstalled — which is the
    // state anybody hitting this bug is already in.
    const code = await source();
    const installOnly = /onInstalled[\s\S]*setPanelBehavior/.test(code);
    const topLevel = /^\s*void setPanelBehaviour\(\);\s*$/m.test(code);
    expect(topLevel || !installOnly, 'panel behaviour is only set on install').toBe(true);
  });
});
