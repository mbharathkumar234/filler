import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';

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

type Item = {
  text: string;
  score: number;
  box: { x0: number; y0: number; x1: number; y1: number };
  script?: string;
};
type Answer = {
  ok: boolean;
  data?: { items: Item[]; width: number; height: number; turns: number };
  error?: string;
};

/**
 * The reader's page opened as an ordinary tab — same page, same origin, same
 * CSP — plus a second extension page that draws text. The request goes from
 * the service worker, as it does for real: the page refuses one from a tab,
 * which is what a content script looks like. Every request the reader makes is
 * recorded.
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
  return { reader, sender, worker: launched.worker, outside, seen, cspViolations };
}

/** Send a request to the reader's page from the service worker, as the extension does. */
function fromWorker<T>(worker: Worker, payload: Record<string, unknown>): Promise<T> {
  return worker.evaluate(
    (p) => chrome.runtime.sendMessage({ __af: true, at: Date.now(), payload: p }),
    payload,
  ) as Promise<T>;
}

/**
 * Draw `lines` on a white canvas and ask the reader for them. `turned` is how
 * many quarter turns clockwise the page is turned before it is handed over —
 * the phone held the wrong way round.
 */
async function drawAndAsk(
  sender: Page,
  worker: Worker,
  lines: string[],
  copies = 1,
  turned = 0,
  scripts: string[] = [],
): Promise<Answer[]> {
  const image = await sender.evaluate(
    async ([text, quarters]) => {
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
      return canvas.toDataURL('image/png').split(',')[1]!;
    },
    [lines, turned] as const,
  );
  return Promise.all(
    Array.from({ length: copies }, () =>
      fromWorker<Answer>(worker, {
        type: 'ocr:recognise',
        image,
        mime: 'image/png',
        ...(scripts.length === 0 ? {} : { scripts }),
      }),
    ),
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
  const { sender, worker, outside, seen, cspViolations } = await readerAndSender();

  const [answer] = await drawAndAsk(sender, worker, ['Name : RAVI KUMAR', 'Roll No 1234567']);

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
  const { sender, worker } = await readerAndSender();

  // English in one place, Kannada well apart from it, so each is its own box.
  const [answer] = await drawAndAsk(sender, worker, ['PRIYA S', 'ಕರ್ನಾಟಕ ಸರ್ಕಾರ']);
  expect(answer!.ok, answer!.error).toBe(true);

  const items = answer!.data!.items;
  const english = items.find((item) => item.text.includes('PRIYA'));
  expect(english?.score ?? 0).toBeGreaterThanOrEqual(0.7);

  // Whatever the English model made of the Kannada line, it was not sure of it:
  // `layout.ts` drops anything below 0.7 before the field rules see it.
  const guessed = items.filter((item) => item.box.y0 > (english?.box.y1 ?? 0));
  for (const item of guessed) expect(item.score, item.text).toBeLessThan(0.7);
});

test('reads Hindi, Telugu and Tamil with their own recognisers, when the page may be in them', async () => {
  // The three recognisers PaddleOCR has a light model for, each measured here
  // on made-up lines: names, a label beside digits, a date. Asked for by script,
  // as the worker asks for the scripts of where the document's owner lives.
  test.setTimeout(180_000);
  const { sender, worker, seen } = await readerAndSender();

  const [hindi] = await drawAndAsk(
    sender,
    worker,
    ['नाम : सीमा वर्मा', 'पिता का नाम : राजेश वर्मा', 'वार्षिक आय : 48000', 'जन्म तिथि : 12/05/2004'],
    1,
    0,
    ['Devanagari'],
  );
  expect(hindi!.ok, hindi!.error).toBe(true);
  expect(hindi!.data!.items.map((item) => item.text)).toEqual([
    'नाम : सीमा वर्मा',
    'पिता का नाम : राजेश वर्मा',
    // The label beside the digits: the English model read it as "3:48000" at a
    // mean of 0.93, and only its weakest character gave the guess away.
    'वार्षिक आय : 48000',
    'जन्म तिथि : 12/05/2004',
  ]);
  expect(hindi!.data!.items.every((item) => item.script === 'Devanagari')).toBe(true);

  const [tamil] = await drawAndAsk(
    sender,
    worker,
    ['பெயர் : கவிதா முருகன்', 'தந்தை பெயர் : முருகன் செல்வம்'],
    1,
    0,
    ['Devanagari', 'Tamil'],
  );
  expect(tamil!.data!.items.map((item) => item.text)).toEqual(['பெயர் : கவிதா முருகன்', 'தந்தை பெயர் : முருகன் செல்வம்']);

  // Telugu reads, with the odd conjunct wrong: "తండ్రి" comes back "తం(డి".
  const [telugu] = await drawAndAsk(
    sender,
    worker,
    ['తండ్రి పేరు : వెంకట రావు', 'వార్షిక ఆదాయం : 72000', 'పుట్టిన తేదీ : 02/08/2003', 'చిరునామా : విజయవాడ'],
    1,
    0,
    ['Devanagari', 'Telugu'],
  );
  const teluguItems = telugu!.data!.items;
  const teluguRead = teluguItems.filter((item) => item.script === 'Telugu').map((item) => item.text);
  expect(teluguRead).toEqual(
    expect.arrayContaining([
      'వార్షిక ఆదాయం : 72000',
      // The label vanished from the English reading, which kept only the date.
      'పుట్టిన తేదీ : 02/08/2003',
      'చిరునామా : విజయవాడ',
    ]),
  );
  // The line with the conjunct it misreads is read with that one error, or left
  // to the English model's guess — which the field rules never see. Never
  // anything else.
  const father = teluguItems[0]!;
  if (father.script === 'Telugu') expect(father.text).toBe('తం(డి పేరు : వెంకట రావు');
  else expect(father.score).toBeLessThan(0.7);

  // And a name it can only half read is not taken: "లక్ష్మి" came back
  // "లక్షిమీ", its weakest character at 0.33. Better unread than misspelt.
  const [unsure] = await drawAndAsk(sender, worker, ['పేరు : లక్ష్మి దేవి'], 1, 0, ['Devanagari', 'Telugu']);
  expect(unsure!.data!.items.filter((item) => item.script === 'Telugu')).toEqual([]);

  // Each model fetched from the package, like the rest.
  for (const name of ['devanagari', 'ta', 'te']) {
    expect(seen.some((url) => url.endsWith(`/ocr/${name}_PP-OCRv5_mobile_rec.onnx`)), name).toBe(true);
  }
});

test('never reads a Karnataka card’s Kannada as Hindi — and is never asked to read it as Telugu', async () => {
  // Measured: the Telugu model read this Kannada as Telugu at 0.83 and 0.92,
  // so a person in Karnataka is read in English and Devanagari alone
  // (`indic.ts` → `readingScripts`). With those, the Kannada stays what it
  // always was: a guess below the line the field rules use.
  test.setTimeout(120_000);
  const { sender, worker } = await readerAndSender();
  const [answer] = await drawAndAsk(
    sender,
    worker,
    ['PRIYA S', 'ಕರ್ನಾಟಕ ಸರ್ಕಾರ', 'ವಿದ್ಯಾರ್ಥಿಯ ಹೆಸರು', 'ತಂದೆಯ ಹೆಸರು : ಸುರೇಶ'],
    1,
    0,
    ['Devanagari'],
  );
  const items = answer!.data!.items;
  expect(items.find((item) => item.text === 'PRIYA S')?.score).toBeGreaterThan(0.9);
  for (const item of items) {
    expect(item.script, item.text).toBeUndefined();
    if (item.text !== 'PRIYA S') expect(item.score, item.text).toBeLessThan(0.7);
  }
});

test('reads a page of English without loading any other script’s model', async () => {
  test.setTimeout(120_000);
  const { sender, worker, seen } = await readerAndSender();
  const [answer] = await drawAndAsk(sender, worker, ['Name : RAVI KUMAR', 'Annual Income : 48000'], 1, 0, [
    'Devanagari',
    'Telugu',
    'Tamil',
  ]);
  expect(textOf(answer!)).toBe('Name : RAVI KUMAR Annual Income : 48000');
  expect(seen.filter((url) => /_PP-OCRv5_mobile_rec\.onnx$/.test(url) && !url.includes('/en_'))).toEqual([]);
});

test('reads made-up certificates printed in Hindi, Telugu and Tamil, line for line', async () => {
  // Rendered by the browser (`scripts/make-indic-fixtures.mjs`), saved as JPEG,
  // read from the file as a stored document is.
  test.setTimeout(180_000);
  const { worker } = await readerAndSender();
  const readFixture = async (name: string, scripts: string[]) => {
    const image = readFileSync(fileURLToPath(new URL(`../../fixtures/images/${name}`, import.meta.url))).toString('base64');
    const answer = await fromWorker<Answer>(worker, { type: 'ocr:recognise', image, mime: 'image/jpeg', scripts });
    expect(answer.ok, answer.error).toBe(true);
    return answer.data!.items.map((item) => item.text);
  };

  expect(await readFixture('hindi-income-certificate.jpg', ['Devanagari'])).toEqual(
    expect.arrayContaining([
      'प्रमाण पत्र संख्या : 212340056789',
      'नाम : सीमा वर्मा',
      'पिता का नाम : राजेश वर्मा',
      'वार्षिक आय : 48000',
    ]),
  );
  expect(await readFixture('telugu-income-certificate.jpg', ['Devanagari', 'Telugu'])).toEqual(
    expect.arrayContaining(['వార్షిక ఆదాయం : 72000', 'చిరునామా : విజయవాడ']),
  );
  // The Tamil model dropped the 6 of 60000; the other two readings, which read
  // it, outvoted it (`paddle-reader.ts` → `agreedNumber`).
  expect(await readFixture('tamil-income-certificate.jpg', ['Devanagari', 'Tamil'])).toEqual(
    expect.arrayContaining(['பெயர் : கவிதா முருகன்', 'தந்தை பெயர் : முருகன் செல்வம்', 'ஆண்டு வருமானம் : 60000']),
  );
});

test('flattens a photo of a curled page before it is read, and every row is back in line', async () => {
  // A made-up marks card photographed curled on a table, at an angle
  // (`scripts/make-curled-photo-fixture.*`). Read as photographed, each
  // subject's marks sat beside the next subject; flattened by UVDoc, they sit
  // beside their own. A flat page, and a page that fills the frame, are left
  // as they came.
  test.setTimeout(180_000);
  const { worker } = await readerAndSender();
  type Flat = Answer & { data?: { flattened?: string } };
  const readFixture = (name: string, mime: string) =>
    fromWorker<Flat>(worker, {
      type: 'ocr:recognise',
      image: readFileSync(fileURLToPath(new URL(`../../fixtures/images/${name}`, import.meta.url))).toString('base64'),
      mime,
    });

  const curled = await readFixture('curled-marks-card.jpg', 'image/jpeg');
  expect(curled.ok, curled.error).toBe(true);
  expect(curled.data!.flattened?.length ?? 0).toBeGreaterThan(10_000);
  const items = curled.data!.items;
  const middle = (text: string) => {
    const item = items.find((candidate) => candidate.text === text);
    expect(item, text).toBeDefined();
    return (item!.box.y0 + item!.box.y1) / 2;
  };
  for (const [subject, marks] of [['English', '87'], ['Mathematics', '93'], ['Science', '89'], ['Social Science', '84'], ['Total', '353']]) {
    expect(Math.abs(middle(subject!) - middle(marks!)), `${subject} beside ${marks}`).toBeLessThan(15);
  }
  // The title still arched after flattening: found by its own pixels.
  expect(items.some((item) => item.text === 'SAMPLE BOARD OF SECONDARY EDUCATION')).toBe(true);

  for (const [name, mime] of [['flat-marks-card.png', 'image/png'], ['passbook.jpg', 'image/jpeg']]) {
    const flat = await readFixture(name!, mime!);
    expect(flat.data!.flattened, name).toBeUndefined();
  }
});

test('reads a grade card’s courses cell by cell, ruled and open, a wrapped title whole', async () => {
  // Made-up semester grade cards (`scripts/make-grade-card-fixtures.mjs`). Read
  // as lines, a course row starts with its code, the first title wraps onto a
  // line of its own, and nothing says which figure is the total. SLANet_plus
  // reads the table's structure; the reader's own text fills its cells.
  test.setTimeout(180_000);
  const { worker } = await readerAndSender();
  type Tables = Answer & { data?: { tables?: Array<{ rows: string[][] }> } };
  const COURSES = [
    ['Course Code', 'Course Title', 'Credits', 'Internal', 'External', 'Total', 'Grade'],
    ['21MAT31', 'Transform Calculus, Fourier Series and Numerical Techniques', '3', '45', '52', '97', 'A'],
    ['21CS32', 'Data Structures and Applications', '4', '47', '58', '105', 'A+'],
    ['21CS33', 'Analog and Digital Electronics', '4', '42', '49', '91', 'A'],
    ['21CS34', 'Computer Organization and Architecture', '3', '40', '45', '85', 'B+'],
    ['21CS35', 'Object Oriented Programming with Java', '3', '46', '55', '101', 'A+'],
    ['21CSL36', 'Data Structures Laboratory', '1', '48', '47', '95', 'A'],
    ['21KSK37', 'Samskrutika Kannada', '1', '44', '41', '85', 'B+'],
  ];

  for (const name of ['grade-card-ruled.png', 'grade-card-open.png']) {
    const answer = await fromWorker<Tables>(worker, {
      type: 'ocr:recognise',
      image: readFileSync(fileURLToPath(new URL(`../../fixtures/images/${name}`, import.meta.url))).toString('base64'),
      mime: 'image/png',
    });
    expect(answer.ok, answer.error).toBe(true);
    // One table: the label rows above and below it ("Semester  III", "SGPA  8.45") are not one.
    expect(answer.data!.tables, name).toEqual([{ rows: COURSES }]);
  }

  // A school marks card's subjects too — the curled photo once flattened —
  // and nothing on a page with no table: certificates, a passbook.
  const SUBJECTS = [
    ['Subject', 'Max', 'Obtained'],
    ['English', '100', '87'],
    ['Mathematics', '100', '93'],
    ['Science', '100', '89'],
    ['Social Science', '100', '84'],
    ['Total', '400', '353'],
  ];
  for (const [name, mime, tables] of [
    ['flat-marks-card.png', 'image/png', [{ rows: SUBJECTS }]],
    ['curled-marks-card.jpg', 'image/jpeg', [{ rows: SUBJECTS }]],
    ['hindi-income-certificate.jpg', 'image/jpeg', undefined],
    ['passbook.jpg', 'image/jpeg', undefined],
  ] as const) {
    const answer = await fromWorker<Tables>(worker, {
      type: 'ocr:recognise',
      image: readFileSync(fileURLToPath(new URL(`../../fixtures/images/${name}`, import.meta.url))).toString('base64'),
      mime,
    });
    expect(answer.ok, answer.error).toBe(true);
    expect(answer.data!.tables, name).toEqual(tables);
  }
});

test('reads a round seal straightened: the office over the top, the taluk under the bottom', async () => {
  // A made-up caste certificate whose issuing authority is printed only in its
  // seal (`scripts/make-seal-fixtures.mjs`): violet, stamped at an angle over
  // the signature, "Signature of the issuing authority" printed across it. Read
  // as the page is, the bottom arc came back "SAMMPLEPURAT". Unrolled, with
  // only the seal's own ink kept, both arcs read whole.
  test.setTimeout(180_000);
  const { worker } = await readerAndSender();
  type Sealed = Answer & { data?: { seals?: Array<{ box: Item['box']; text: string[] }> } };
  const readFixture = (name: string, mime: string) =>
    fromWorker<Sealed>(worker, {
      type: 'ocr:recognise',
      image: readFileSync(fileURLToPath(new URL(`../../fixtures/images/${name}`, import.meta.url))).toString('base64'),
      mime,
    });

  const answer = await readFixture('caste-certificate-seal.png', 'image/png');
  expect(answer.ok, answer.error).toBe(true);
  const { seals, items, width, height } = answer.data!;
  expect(seals?.map((seal) => seal.text)).toEqual([['TAHSILDAR', 'SAMPLEPURA TALUK']]);
  // Where the seal is: the lower right of the page, as round as it is wide.
  const box = seals![0]!.box;
  expect(box.x0).toBeGreaterThan(width / 2);
  expect(box.y0).toBeGreaterThan(height / 2);
  expect(Math.abs(box.x1 - box.x0 - (box.y1 - box.y0))).toBeLessThan(4);
  // The page's own guesses along the ring are set aside; the seal's middle and
  // the signature over it are kept.
  const texts = items.map((item) => item.text);
  expect(texts.filter((text) => /TAHSILDAR|SAM+PLEPURA/.test(text))).toEqual([]);
  expect(texts).toContain('KARNATAKA');
  expect(texts).toContain('Samplegowda');

  // No seal where there is none: a coloured passbook, a curled photo on a table, print.
  for (const [name, mime] of [
    ['passbook.jpg', 'image/jpeg'],
    ['curled-marks-card.jpg', 'image/jpeg'],
    ['hindi-income-certificate.jpg', 'image/jpeg'],
    ['grade-card-ruled.png', 'image/png'],
  ] as const) {
    const plain = await readFixture(name, mime);
    expect(plain.ok, plain.error).toBe(true);
    expect(plain.data!.seals, name).toBeUndefined();
  }
});

test('reads a line printed upside down the right way up', async () => {
  // A stamp turned over: PaddleOCR's text-line classifier says so, and the line
  // is read both ways. Without it, this line read as "SSS".
  test.setTimeout(120_000);
  const { sender, worker } = await readerAndSender();
  const image = await sender.evaluate(() => {
    const lines = ['Name : RAVI KUMAR', 'ISSUED BY THE REGISTRAR', 'Annual Income : 48000'];
    const canvas = document.createElement('canvas');
    canvas.width = 1400;
    canvas.height = 140 + lines.length * 110;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    ctx.font = '56px sans-serif';
    lines.forEach((line, i) => {
      const y = 120 + i * 110;
      if (i !== 1) return ctx.fillText(line, 60, y);
      ctx.save();
      ctx.translate(60 + ctx.measureText(line).width / 2, y - 20);
      ctx.rotate(Math.PI);
      ctx.fillText(line, -ctx.measureText(line).width / 2, 20);
      ctx.restore();
    });
    return canvas.toDataURL('image/png').split(',')[1]!;
  });
  const answer = await fromWorker<Answer>(worker, { type: 'ocr:recognise', image, mime: 'image/png' });
  expect(answer.data!.items.map((item) => item.text)).toEqual([
    'Name : RAVI KUMAR',
    'ISSUED BY THE REGISTRAR',
    'Annual Income : 48000',
  ]);
});

test('answers two overlapping readings, both of them', async () => {
  test.setTimeout(120_000);
  const { sender, worker } = await readerAndSender();

  // The StrictMode double press, at the reader's own door.
  const answers = await drawAndAsk(sender, worker, ['Register No 800417'], 2);

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
    const { sender, worker } = await readerAndSender();

    const [answer] = await drawAndAsk(sender, worker, CERTIFICATE, 1, turned);
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
  const { reader, sender, worker, seen, outside, cspViolations } = await readerAndSender();

  // The manifest's two cross-origin keys, as the browser actually applied them.
  const page = await reader.evaluate(() => ({
    isolated: crossOriginIsolated,
    shared: typeof SharedArrayBuffer === 'function',
    cores: navigator.hardwareConcurrency,
  }));
  expect(page.isolated).toBe(true);
  expect(page.shared).toBe(true);

  const [answer] = await drawAndAsk(sender, worker, ['Name : RAVI KUMAR', 'Roll No 1234567']);
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

test('refuses a reading asked for from a tab, which is what a content script looks like', async () => {
  const { sender } = await readerAndSender();
  const answer = (await sender.evaluate(() =>
    chrome.runtime.sendMessage({
      __af: true,
      at: Date.now(),
      payload: { type: 'pdf:lock', pdf: 'JVBERi0xLjQ=' },
    }),
  )) as Answer;
  expect(answer.ok).toBe(false);
  expect(answer.error).toBe('Rejected.');
});

test('opens a locked PDF for the worker, with its password, under the extension’s CSP', async () => {
  // The service worker cannot load pdf.js, so it asks this page. Until it did,
  // no PDF opened anywhere in the extension.
  test.setTimeout(120_000);
  const { worker, outside, cspViolations } = await readerAndSender();
  const pdf = readFileSync(fileURLToPath(new URL('../../fixtures/pdf/locked-aadhaar.pdf', import.meta.url))).toString('base64');
  type Reply<T> = { ok: boolean; data?: T; error?: string };

  const lock = (password?: string) =>
    fromWorker<Reply<{ lock: string }>>(worker, { type: 'pdf:lock', pdf, ...(password ? { password } : {}) });
  expect((await lock()).data?.lock).toBe('needs-password');
  expect((await lock('ravi1998')).data?.lock).toBe('wrong-password');
  expect((await lock('RAVI1998')).data?.lock).toBe('open');

  const text = await fromWorker<Reply<{ text: string }>>(worker, { type: 'pdf:text', pdf, password: 'RAVI1998' });
  expect(text.ok, text.error).toBe(true);
  expect(text.data?.text).toContain('9999 9999 0019');

  const page = await fromWorker<Reply<{ image: string; width: number; height: number }>>(worker, {
    type: 'pdf:render',
    pdf,
    password: 'RAVI1998',
    width: 1000,
  });
  expect(page.ok, page.error).toBe(true);
  expect(page.data?.width).toBe(1000);
  expect(page.data?.image.startsWith('iVBORw0KGgo')).toBe(true); // a PNG

  // Without the password, a reading says what to do about it.
  const locked = await fromWorker<Reply<unknown>>(worker, { type: 'pdf:text', pdf });
  expect(locked.ok).toBe(false);
  expect(locked.error).toMatch(/locked with a password the vault does not have/i);

  expect(cspViolations).toEqual([]);
  expect(outside).toEqual([]);
});

test('draws and reads every page of a scanned PDF, however the scanner stored it', async () => {
  // Three pages, no text layer (`scripts/make-scanned-pdf-fixture.py`): colour
  // JPEG; black-and-white CCITT fax, fed in sideways; JPEG 2000. pdf.js decodes
  // the last two with WebAssembly this package ships in `pdfjs/` — without it
  // they drew as blank pages, and a blank page reads as nothing.
  test.setTimeout(180_000);
  const { sender, worker, outside, cspViolations } = await readerAndSender();
  const pdf = readFileSync(
    fileURLToPath(new URL('../../fixtures/pdf/scanned-three-pages.pdf', import.meta.url)),
  ).toString('base64');
  type Reply<T> = { ok: boolean; data?: T; error?: string };
  type Page = { image: string; width: number; height: number; pages: number };

  /** The share of a PNG's pixels that are ink, measured in an extension page. */
  const inkOf = (png: string) =>
    sender.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i]! + data[i + 1]! + data[i + 2]! < 384) dark += 1;
      return dark / (data.length / 4);
    }, png);

  const expected = [
    { words: ['PRIYA S', '765432'], turns: 0 },
    { words: ['PHYSICS', 'CHEMISTRY'], turns: 3 }, // fed in a quarter clockwise
    { words: ['DISTINCTION'], turns: 0 },
  ];
  for (const [index, want] of expected.entries()) {
    const page = await fromWorker<Reply<Page>>(worker, { type: 'pdf:render', pdf, width: 1240, page: index + 1 });
    expect(page.ok, page.error).toBe(true);
    expect(page.data?.pages).toBe(3);

    const ink = await inkOf(page.data!.image);
    expect(ink, `page ${index + 1} drew blank`).toBeGreaterThan(0.002);

    const answer = await fromWorker<Answer>(worker, { type: 'ocr:recognise', image: page.data!.image, mime: 'image/png' });
    expect(answer.ok, answer.error).toBe(true);
    expect(answer.data?.turns, `page ${index + 1}`).toBe(want.turns);
    for (const word of want.words) expect(textOf(answer), `page ${index + 1}`).toContain(word);
  }

  // There is no page four, and asking for one says so rather than drawing page one.
  const beyond = await fromWorker<Reply<Page>>(worker, { type: 'pdf:render', pdf, width: 1240, page: 4 });
  expect(beyond.ok).toBe(false);
  expect(beyond.error).toMatch(/3 pages; there is no page 4/);

  expect(cspViolations).toEqual([]);
  expect(outside).toEqual([]);
});
