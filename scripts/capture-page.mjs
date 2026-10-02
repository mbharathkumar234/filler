/**
 * Capture a rendered page as a static fixture.
 *
 * Portals worth testing against are single-page apps: their HTML is empty
 * until React runs. The matcher's fixture tests run in jsdom, which cannot run
 * the app, so this loads the page in a real browser, waits for it to render,
 * and writes the resulting DOM — scripts stripped — to a fixture file.
 *
 *   node scripts/capture-page.mjs <url> <out.html> [text-to-wait-for]
 */

import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const [url, out, waitFor] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node scripts/capture-page.mjs <url> <out.html> [text-to-wait-for]');
  process.exit(2);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  if (waitFor) await page.getByText(waitFor).first().waitFor({ timeout: 15_000 });

  const html = await page.evaluate(() => {
    const clone = document.documentElement.cloneNode(true);
    // Scripts would re-run nothing in jsdom and only bloat the fixture.
    for (const script of clone.querySelectorAll('script')) script.remove();
    return `<!doctype html>\n${clone.outerHTML}`;
  });

  writeFileSync(out, html, 'utf8');
  console.log(`wrote ${out} (${html.length} bytes)`);
} finally {
  await browser.close();
}
