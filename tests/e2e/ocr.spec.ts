import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * The document reader, in the artefact that ships (§ reading a document).
 *
 * Everything here is end-to-end against `dist/`: PaddleOCR's three models, their
 * settings, and ONNX Runtime's WebAssembly are files in the package, and the
 * only way to know they load — from a `chrome-extension://` URL, under a CSP
 * that forbids `eval`, `new Function` and fetching anything else — is to load
 * them. That is the question PaddleOCR's own browser SDK fails (its OpenCV.js
 * needs `new Function`), and the one these tests exist to answer.
 *
 * The page is rendered rather than read from a fixture image so the expected
 * text is unarguable: these tests can only pass by recognising the letters
 * that were drawn.
 */

const DIST = fileURLToPath(new URL('../../dist', import.meta.url));

let context: BrowserContext | null = null;

test.afterEach(async () => {
  await context?.close();
  context = null;
});

async function launch() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'autofill-ocr-'));
  const launched = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
  });
  const worker =
    launched.serviceWorkers()[0] ?? (await launched.waitForEvent('serviceworker'));
  return { context: launched, worker, id: new URL(worker.url()).host };
}

type Item = { text: string; score: number; box: { x0: number; y0: number; x1: number; y1: number } };
type Answer = {
  ok: boolean;
  data?: { items: Item[]; width: number; height: number; turns: number };
  error?: string;
};

/**
 * The reader's page opened as an ordinary tab — same page, same origin, same
 * CSP — plus a second extension page that draws text and asks for it back.
 * Every request the reader makes is recorded.
 */
async function readerAndSender() {
  const launched = await launch();
  context = launched.context;

  const reader = await launched.context.newPage();
  const outside: string[] = [];
  const seen: string[] = [];
  const cspViolations: string[] = [];
  // At the context, so the reader worker's own requests are watched too.
  launched.context.on('request', (request) => {
    seen.push(request.url());
    if (!request.url().startsWith(`chrome-extension://${launched.id}/`)) outside.push(request.url());
  });
  reader.on('console', (message) => {
    if (/Content Security Policy|unsafe-eval|EvalError/i.test(message.text())) cspViolations.push(message.text());
  });
  await reader.goto(`chrome-extension://${launched.id}/src/offscreen/ocr.html`);

  const sender = await launched.context.newPage();
  await sender.goto(`chrome-extension://${launched.id}/practice/first-fill.html`);
  return { reader, sender, outside, seen, cspViolations };
}

/**
 * Draw `lines` on a white canvas and ask the reader for them. `turned` is how
 * many quarter turns clockwise the page is turned before it is handed over —
 * the phone held the wrong way round.
 */
function drawAndAsk(sender: Page, lines: string[], copies = 1, turned = 0): Promise<Answer[]> {
  return sender.evaluate(
    async ([text, count, quarters]) => {
      const upright = document.createElement('canvas');
      upright.width = 1400;
      upright.height = 140 + text.length * 110;
      const ctx = upright.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, upright.width, upright.height);
      ctx.fillStyle = '#000000';
      ctx.font = '56px sans-serif';
      text.forEach((line, i) => ctx.fillText(line, 60, 120 + i * 110));

      let canvas = upright;
      if (quarters !== 0) {
        canvas = document.createElement('canvas');
        const sideways = quarters % 2 === 1;
        canvas.width = sideways ? upright.height : upright.width;
        canvas.height = sideways ? upright.width : upright.height;
        const turn = canvas.getContext('2d')!;
        turn.translate(canvas.width / 2, canvas.height / 2);
        turn.rotate((quarters * Math.PI) / 2);
        turn.drawImage(upright, -upright.width / 2, -upright.height / 2);
      }
      const image = canvas.toDataURL('image/png').split(',')[1]!;

      const ask = () =>
        chrome.runtime.sendMessage({
          __af: true,
          at: Date.now(),
          payload: { type: 'ocr:recognise', image, mime: 'image/png' },
        }) as Promise<Answer>;
      return Promise.all(Array.from({ length: count }, ask));
    },
    [lines, copies, turned] as const,
  );
}

const textOf = (answer: Answer) => (answer.data?.items ?? []).map((item) => item.text).join(' ');

test('the worker can open the reader’s page, and closes it again', async () => {
  // The permission and the page's path, which no unit test can check.
  const launched = await launch();
  context = launched.context;

  const opened = await launched.worker.evaluate(async () => {
    await chrome.offscreen.createDocument({
      url: 'src/offscreen/ocr.html',
      reasons: ['WORKERS' as chrome.offscreen.Reason],
      justification: 'Test: the document reader runs its models away from the worker.',
    });
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
    });
    await chrome.offscreen.closeDocument();
    const after = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
    });
    return { while: contexts.length, after: after.length };
  });

  expect(opened).toEqual({ while: 1, after: 0 });
});

test('reads the words off a rendered page, under the extension’s CSP, with nothing fetched', async () => {
  test.setTimeout(120_000);
  const { sender, outside, seen, cspViolations } = await readerAndSender();

  const [answer] = await drawAndAsk(sender, ['Name : RAVI KUMAR', 'Roll No 1234567']);

  // The watch sees the worker's own traffic: the models were fetched, locally.
  expect(seen.some((url) => url.endsWith('/ocr/PP-OCRv5_mobile_det.onnx'))).toBe(true);
  expect(seen.some((url) => url.endsWith('/ocr/en_PP-OCRv5_mobile_rec.onnx'))).toBe(true);
  expect(seen.some((url) => url.endsWith('/ocr/PP-LCNet_x1_0_doc_ori.onnx'))).toBe(true);
  // An upright page is left as it came.
  expect(answer!.data!.turns).toBe(0);

  expect(answer!.ok, answer!.error).toBe(true);
  const text = textOf(answer!);
  expect(text).toContain('RAVI KUMAR');
  expect(text).toMatch(/1234567/);

  // Every piece carries where it sits, for the layout that pairs labels.
  for (const item of answer!.data!.items) {
    expect(item.box.x1).toBeGreaterThan(item.box.x0);
    expect(item.box.y1).toBeGreaterThan(item.box.y0);
    expect(item.score).toBeGreaterThan(0.7);
  }

  // The two things PaddleOCR's own SDK could not promise here.
  expect(cspViolations).toEqual([]);
  expect(outside).toEqual([]);
});

test('scores a Kannada word it cannot read below the line the field rules use', async () => {
  test.setTimeout(120_000);
  const { sender } = await readerAndSender();

  // English in one place, Kannada well apart from it, so each is its own box.
  const [answer] = await drawAndAsk(sender, ['PRIYA S', 'ಕರ್ನಾಟಕ ಸರ್ಕಾರ']);
  expect(answer!.ok, answer!.error).toBe(true);

  const items = answer!.data!.items;
  const english = items.find((item) => item.text.includes('PRIYA'));
  expect(english?.score ?? 0).toBeGreaterThanOrEqual(0.7);

  // Whatever the English model made of the Kannada line, it was not sure of it:
  // `layout.ts` drops anything below 0.7 before the field rules see it.
  const guessed = items.filter((item) => item.box.y0 > (english?.box.y1 ?? 0));
  for (const item of guessed) expect(item.score, item.text).toBeLessThan(0.7);
});

test('answers two overlapping readings, both of them', async () => {
  test.setTimeout(120_000);
  const { sender } = await readerAndSender();

  // The StrictMode double press, at the reader's own door.
  const answers = await drawAndAsk(sender, ['Register No 800417'], 2);

  for (const answer of answers) {
    expect(answer.ok, answer.error).toBe(true);
    expect(textOf(answer)).toMatch(/800417/);
  }
});

/** A page with enough on it to have a way up: a certificate's worth of lines. */
const CERTIFICATE = [
  'GOVERNMENT OF KARNATAKA',
  'DEPARTMENT OF PUBLIC INSTRUCTION',
  'Name of the Student : RAVI KUMAR',
  'Name of the Father : SURESH KUMAR',
  'Register Number : 1234567',
  'Date of Birth : 12-03-2007',
  'School : GOVERNMENT HIGH SCHOOL',
  'This is to certify that the particulars',
  'given above are true and correct.',
  'Place : TUMKUR',
];

for (const [turned, back, name] of [
  [1, 3, 'a quarter turn clockwise'],
  [2, 2, 'upside down'],
  [3, 1, 'a quarter turn anticlockwise'],
] as const) {
  test(`stands a page photographed ${name} upright, and reads it`, async () => {
    test.setTimeout(120_000);
    const { sender } = await readerAndSender();

    const [answer] = await drawAndAsk(sender, CERTIFICATE, 1, turned);
    expect(answer!.ok, answer!.error).toBe(true);

    // How far it was turned back, and the page's size once upright.
    expect(answer!.data!.turns).toBe(back);
    expect(answer!.data!.width).toBe(1400);
    expect(answer!.data!.height).toBe(140 + CERTIFICATE.length * 110);

    // Read, which a sideways page never was: the recogniser knows upright text only.
    const text = textOf(answer!);
    expect(text).toContain('RAVI KUMAR');
    expect(text).toMatch(/1234567/);
    expect(text).toContain('TUMKUR');
  });
}

test('reads on more than one CPU thread, because its page is isolated', async () => {
  test.setTimeout(120_000);
  const { reader, sender, seen, outside, cspViolations } = await readerAndSender();

  // The manifest's two cross-origin keys, as the browser actually applied them.
  const page = await reader.evaluate(() => ({
    isolated: crossOriginIsolated,
    shared: typeof SharedArrayBuffer === 'function',
    cores: navigator.hardwareConcurrency,
  }));
  expect(page.isolated).toBe(true);
  expect(page.shared).toBe(true);

  const [answer] = await drawAndAsk(sender, ['Name : RAVI KUMAR', 'Roll No 1234567']);
  expect(answer!.ok, answer!.error).toBe(true);
  expect(textOf(answer!)).toContain('RAVI KUMAR');

  // ONNX Runtime starts each thread by loading its own file again, so that
  // file is fetched once by the reader — the first thread — and once more for
  // each of the others: from this package, under the CSP, like everything else.
  const runtime = seen.filter((url) => /\/assets\/ort\.wasm[^/]*\.js$/.test(url));
  const threads = Math.max(1, Math.min(4, Math.floor(page.cores / 2)));
  expect(runtime).toHaveLength(threads);

  expect(cspViolations).toEqual([]);
  expect(outside).toEqual([]);
});
