#!/usr/bin/env node
/**
 * Capture a real form for the corpus (U0.M1, `MASTER_PROMPT.md`).
 *
 *   npm run capture -- <url> --category <category> --name <name> --stack <stack> [--login]
 *
 * Opens a real browser window (with its own profile under `.private/`, so a
 * login is remembered) at <url>. You bring the form on screen — logging in if
 * it needs it, typing nothing into it — and press Enter in this terminal. The
 * page is then cleaned by `src/corpus/snapshot.ts` (every value, token, script
 * and URL removed) and saved to `fixtures/corpus/<category>/<name>.html`.
 *
 * The tool reads the page once, when you press Enter. It never types, clicks or
 * submits anything. It is a developer's tool: it is not part of the extension,
 * and `verify-dist` refuses a build that contains it.
 *
 * Before committing a snapshot: read it. A logged-in page can print your name
 * or numbers as plain text, which no cleaner can tell from a label. Then run
 * `npm run scan-values`, and record the site's terms-of-service verdict in
 * `docs/portal-notes/` (a human's judgement — see its README).
 *
 * `--headless` captures without a window or a pause, and `--out <file>` writes
 * somewhere other than the corpus: both for the tool's own test on local pages.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The corpus categories and their minimums (`MASTER_PROMPT.md` → U0.M2). */
export const CATEGORIES = {
  scholarships: 25,
  entrance: 20,
  banking: 10,
  jobs: 15,
  travel: 5,
  everyday: 15,
  'form-builders': 5,
  legacy: 5,
};

function parse(argv) {
  const options = { url: null, category: null, name: null, stack: 'unknown', login: false, headless: false, replace: false, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--category') options.category = argv[++i];
    else if (arg === '--name') options.name = argv[++i];
    else if (arg === '--stack') options.stack = argv[++i];
    else if (arg === '--login') options.login = true;
    else if (arg === '--headless') options.headless = true;
    else if (arg === '--replace') options.replace = true;
    else if (arg === '--out') options.out = argv[++i];
    else if (!arg.startsWith('--')) options.url = arg;
    else throw new Error(`Unknown option ${arg}.`);
  }
  if (!options.url) throw new Error('Say which page: npm run capture -- <url> --category <category> --name <name>');
  if (!(options.category in CATEGORIES)) {
    throw new Error(`--category must be one of: ${Object.keys(CATEGORIES).join(', ')}.`);
  }
  if (!options.name || !/^[a-z0-9][a-z0-9-]*$/.test(options.name)) {
    throw new Error('--name must be lower-case letters, digits and hyphens, e.g. nsp-registration.');
  }
  if (options.headless && !/^(file:|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(options.url)) {
    throw new Error('--headless is for local test pages only; a real portal is captured with you at the window.');
  }
  return options;
}

/** The cleaner, bundled into one script the page can run. */
async function cleanerSource() {
  const { rolldown } = await import('rolldown');
  const bundle = await rolldown({ input: join(ROOT, 'src/corpus/snapshot.ts'), logLevel: 'silent' });
  const { output } = await bundle.generate({ format: 'iife', name: '__autofillSnapshot' });
  await bundle.close();
  return output[0].code;
}

export async function capture(argv) {
  const options = parse(argv);
  const target = options.out ? resolve(options.out) : join(ROOT, 'fixtures', 'corpus', options.category, `${options.name}.html`);
  if (existsSync(target) && !options.replace) {
    throw new Error(`${target} exists. Pass --replace to capture it again.`);
  }

  const { chromium } = await import('@playwright/test');
  // The tool's own test gets a throwaway profile; a person's captures keep theirs, logins and all.
  const profile = options.headless ? join(dirname(target), '.capture-profile') : join(ROOT, '.private', 'capture-profile');
  mkdirSync(profile, { recursive: true });
  const context = await chromium.launchPersistentContext(profile, { headless: options.headless, viewport: null });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(options.url);
    if (!options.headless) {
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      await prompt.question(
        '\nBring the form on screen in the browser window — log in first if it needs it, and type nothing into it.\n' +
          'Then press Enter here to capture it (Ctrl+C to stop). ',
      );
      prompt.close();
    }

    const meta = {
      category: options.category,
      stack: options.stack,
      capturedAt: new Date().toISOString().slice(0, 10),
      origin: new URL(page.url()).origin,
      needsLogin: options.login,
    };
    const source = await cleanerSource();
    const html = await page.evaluate(
      `(() => { ${source}; return __autofillSnapshot.snapshotHtml(document, ${JSON.stringify(meta)}); })()`,
    );

    // A form inside a frame from another page is a page of its own.
    const framed = [];
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const fields = await frame.evaluate(() => document.querySelectorAll('input, select, textarea').length).catch(() => 0);
      if (fields > 0) framed.push(frame.url());
    }

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, html);
    const fields = (html.match(/<(input|select|textarea)\b/gi) ?? []).length;
    console.log(`\nSaved ${target.startsWith(ROOT) ? target.slice(ROOT.length + 1) : target}: ${fields} fields.`);
    for (const url of framed) {
      console.log(`A form also sits in a frame from ${new URL(url).origin}; open that frame's own address to capture it.`);
    }
    if (!options.headless) {
      console.log(
        'Before committing it: read it (a logged-in page can show your name as plain text), run `npm run scan-values`, ' +
          'and record the site’s terms verdict in docs/portal-notes/.',
      );
    }
    return target;
  } finally {
    await context.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  capture(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
