import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

import { openSidePanel, type SidePanel } from './side-panel';

/**
 * Documents, read through the real side panel (§ Phase 3).
 *
 * Every other test of reading drives a part of it: the rules on text, the
 * reader on a rendered page, the screen in jsdom. Pressing the whole thing by
 * hand found four bugs none of them could see — a value box ninety pixels wide
 * and its picture squeezed to match, a reading of the copy being replaced, the
 * same warning said twice, a date of birth lost to a speck — and then that no
 * PDF had ever opened at all. This presses it every time: the built extension,
 * a new vault, made-up documents saved and read through the panel's own
 * buttons, and the network watched on every extension page and worker.
 *
 * The documents are made up (`scripts/make-*-fixture.py`); nothing real is in
 * this repository.
 */

const DIST = fileURLToPath(new URL('../../dist', import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/pdf/${name}`, import.meta.url));
const picture = (name: string) => fileURLToPath(new URL(`../../fixtures/images/${name}`, import.meta.url));

const PORTAL = 'http://localhost:4173/entrance-portal/page-1.html';

const MARKS = '2nd PUC / Class 12 marks card';
const PASSBOOK = 'Bank passbook / cancelled cheque';
const AADHAAR = 'Aadhaar card';

interface Row {
  key: string;
  value: string;
  ticked: boolean;
  from: string;
  picture: boolean;
}

interface Reading {
  rows: Row[];
  notes: string[];
  alerts: string[];
}

test.describe.configure({ mode: 'serial' });

let panel: SidePanel;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  panel = await openSidePanel(DIST);

  // The disclosure, a new vault, and every slot shown.
  await panel.until('the disclosure', () => __panel.button('I understand') !== null, []);
  await panel.run(() => __panel.button('I understand')!.click());
  await panel.until('the passphrase boxes', () => document.querySelectorAll('input[type="password"]').length === 2, []);
  await panel.run((passphrase: string) => {
    for (const box of document.querySelectorAll<HTMLInputElement>('input[type="password"]')) __panel.type(box, passphrase);
  }, 'river-lantern-quietly-orbit-7392');
  await panel.until('Create vault', () => __panel.button('Create vault')?.disabled === false, []);
  await panel.run(() => __panel.button('Create vault')!.click());
  await panel.until(
    'the vault editor',
    () => [...document.querySelectorAll('h1')].some((h) => __panel.text(h) === 'Your details'),
    [],
    90_000,
  );
  await panel.until('the setup questions', () => __panel.button('Skip — show me everything') !== null, []);
  await panel.run(() => __panel.button('Skip — show me everything')!.click());
});

test.afterAll(async () => {
  await panel?.close();
});

/** Choose a file for a slot and press its Save. */
async function chooseAndSave(label: string, file: string) {
  await panel.choose((l: string) => __panel.slot(l)?.querySelector('input[type="file"]') ?? null, [label], [file]);
  await panel.until('its Save button', (l: string) => __panel.button(`Save ${l} to vault`, __panel.slot(l)) !== null, [label]);
  await panel.run((l: string) => __panel.button(`Save ${l} to vault`, __panel.slot(l))!.click(), label);
}

/** Wait for the slot to hold its saved document, ready to read. */
async function saved(label: string) {
  await panel.until(
    'the save to finish',
    (l: string) => {
      const slot = __panel.slot(l);
      return !/Ready to save:/.test(slot?.textContent ?? '') && __panel.button('Read details from this', slot) !== null;
    },
    [label],
    60_000,
  );
}

/** Press "Read details from this" and collect what the screen shows. */
async function read(label: string): Promise<Reading> {
  await panel.run((l: string) => __panel.button('Read details from this', __panel.slot(l))!.click(), label);
  await panel.until(
    'the reading',
    (l: string) => {
      const reading = __panel.reading(l);
      if (reading === null) return false;
      return /Only ticked details are saved|No details could be read/.test(reading.textContent ?? '') || reading.querySelector('[role="alert"]') !== null;
    },
    [label],
    180_000,
  );
  return panel.run((l: string) => {
    const reading = __panel.reading(l)!;
    return {
      rows: [...reading.querySelectorAll('ul > li')].map((li) => ({
        key: (li.querySelector('textarea')?.id ?? '').replace(/^extract-/, ''),
        value: li.querySelector('textarea')?.value ?? '',
        ticked: li.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked ?? false,
        from: [...li.querySelectorAll('p')].map((p) => __panel.text(p)).find((t) => /^(Read from|Check digit)/.test(t)) ?? '',
        picture: li.querySelector('img') !== null,
      })),
      notes: [...reading.querySelectorAll('p')].map((p) => __panel.text(p)),
      alerts: [...reading.querySelectorAll('[role="alert"]')].map((a) => __panel.text(a)),
    };
  }, label);
}

const valueOf = (reading: Reading, key: string) => reading.rows.find((row) => row.key === key);

test('reads all three pages of a scanned marks card, a picture beside every value', async () => {
  test.setTimeout(180_000);
  await chooseAndSave(MARKS, fixture('scanned-three-pages.pdf'));
  await saved(MARKS);
  const reading = await read(MARKS);

  expect(reading.alerts).toEqual([]);
  // One value off each page: the colour page, the sideways fax page, the JPEG 2000 page.
  expect(valueOf(reading, 'education.class_12.registration_number')?.value).toBe('765432');
  expect(valueOf(reading, 'education.class_12.marks_physics')?.value).toBe('81');
  expect(valueOf(reading, 'education.class_12.marks_obtained')?.value).toBe('509');
  expect(valueOf(reading, 'education.class_12.result_status')?.value).toBe('DISTINCTION');

  expect(reading.rows.every((row) => row.picture), 'a value without its picture').toBe(true);
  expect(valueOf(reading, 'education.class_12.marks_physics')?.from).toMatch(/^Read from page 2:/);
  expect(reading.notes.join(' ')).toMatch(/Page 2 was sideways/);
  // Said once, not once by the reading and again by the screen.
  expect(reading.notes.filter((note) => /compare each value|check each value/i.test(note))).toHaveLength(1);
});

test('shows every value whole, in the panel’s own narrow width, each tick inside its row', async () => {
  const layout = await panel.run((l: string) => {
    const reading = __panel.reading(l)!;
    return {
      width: window.innerWidth,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      rows: [...reading.querySelectorAll('ul > li')].map((li) => {
        const box = li.querySelector('textarea')!;
        const tick = li.querySelector('input[type="checkbox"]')!.getBoundingClientRect();
        return {
          key: box.id,
          whole: box.scrollWidth <= box.clientWidth && box.scrollHeight <= box.clientHeight + 1,
          tickInside: tick.right <= li.getBoundingClientRect().right + 0.5,
        };
      }),
    };
  }, MARKS);

  // The real panel is narrow; this is what made the value box ninety pixels wide.
  expect(layout.width).toBeLessThan(500);
  expect(layout.overflow).toBe(false);
  expect(layout.rows.filter((row) => !row.whole).map((row) => row.key)).toEqual([]);
  expect(layout.rows.filter((row) => !row.tickInside).map((row) => row.key)).toEqual([]);
});

test('saves what is ticked, and nothing until it is', async () => {
  const before = await panel.ask<Array<{ key: string; value: string }>>({ type: 'vault:list' });
  expect(before.data ?? []).toEqual([]);

  const count = await panel.run((l: string) => {
    const reading = __panel.reading(l)!;
    for (const box of reading.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) if (!box.checked) box.click();
    return reading.querySelectorAll('input[type="checkbox"]').length;
  }, MARKS);
  await panel.until(
    'the save button',
    (l: string) => [...__panel.reading(l)!.querySelectorAll('button')].some((b) => /^Save \d+ details? to my vault$/.test(__panel.text(b))),
    [MARKS],
  );
  await panel.run((l: string) =>
    [...__panel.reading(l)!.querySelectorAll('button')].find((b) => /^Save \d+ details? to my vault$/.test(__panel.text(b)))!.click(),
  MARKS);
  await panel.until('the saved notice', (n: number) => new RegExp(`Saved ${n} details to your vault\\.`).test(document.body.textContent ?? ''), [count]);

  const after = await panel.ask<Array<{ key: string; value: string }>>({ type: 'vault:list' });
  const stored = new Map((after.data ?? []).map((entry) => [entry.key, entry.value]));
  expect(stored.size).toBe(count);
  expect(stored.get('education.class_12.registration_number')).toBe('765432');
  expect(stored.get('education.class_12.marks_physics')).toBe('81');
});

test('will not read a document while a new copy is being saved over it', async () => {
  await panel.choose((l: string) => __panel.slot(l)?.querySelector('input[type="file"]') ?? null, [MARKS], [
    fixture('scanned-three-pages.pdf'),
  ]);
  await panel.until('its Save button', (l: string) => __panel.button(`Save ${l} to vault`, __panel.slot(l)) !== null, [MARKS]);

  const pressableWhileSaving = await panel.run(async (l: string) => {
    __panel.button(`Save ${l} to vault`, __panel.slot(l))!.click();
    // The soonest a person could press anything: once the click has rendered.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return __panel.button('Read details from this', __panel.slot(l))?.disabled === false;
  }, MARKS);
  expect(pressableWhileSaving).toBe(false);

  await saved(MARKS);
  expect(await panel.run((l: string) => __panel.button('Read details from this', __panel.slot(l))?.disabled, MARKS)).toBe(false);
});

test('asks for a locked PDF’s password, saves nothing without it, and reads it exactly with it', async () => {
  test.setTimeout(120_000);
  const prompt = () => document.getElementById('pdf-password-doc.aadhaar_card') !== null;
  const documents = async () => (await panel.ask<Array<{ key: string; locked?: boolean }>>({ type: 'doc:list' })).data ?? [];

  await chooseAndSave(AADHAAR, fixture('locked-aadhaar.pdf'));
  await panel.until('the password question', prompt, []);
  expect((await documents()).some((doc) => doc.key === 'doc.aadhaar_card')).toBe(false);

  const unlock = (password: string) =>
    panel.run((p: string) => {
      __panel.type(document.querySelector<HTMLInputElement>('[id="pdf-password-doc.aadhaar_card"]')!, p);
      __panel.button('Unlock and save')!.click();
    }, password);

  await unlock('ravi1998');
  await panel.until('the wrong-password answer', (l: string) => /did not open it/.test(__panel.slot(l)?.textContent ?? ''), [AADHAAR]);
  expect((await documents()).some((doc) => doc.key === 'doc.aadhaar_card')).toBe(false);

  await unlock('RAVI1998');
  await saved(AADHAAR);
  const listing = await documents();
  expect(listing.find((doc) => doc.key === 'doc.aadhaar_card')?.locked).toBe(true);
  expect(JSON.stringify(listing)).not.toContain('RAVI1998');

  const reading = await read(AADHAAR);
  expect(reading.notes.join(' ')).toMatch(/Read directly from the document/);
  // Exact, and checksum-verified, so the only row that starts ticked.
  expect(valueOf(reading, 'id.aadhaar')).toMatchObject({ value: '999999990019', ticked: true });
  expect(valueOf(reading, 'identity.dob')?.value).toBe('1998-03-14');
});

test('fills an entrance form from what the documents gave the vault, both uploads too, and submits nothing', async () => {
  // The whole of it: a marks card read into the vault a few tests ago, and the
  // locked e-Aadhaar saved with its password, filled into a form that asks for
  // each subject by name and for both documents as PDFs.
  test.setTimeout(120_000);
  const portal = await panel.context.newPage();
  await portal.goto(PORTAL);
  await portal.bringToFront();
  await panel.pressToolbarButton(PORTAL);

  await panel.run(() => __panel.button('Scan page')!.click());
  await panel.until('the scan', () => __panel.button('Fill this form') !== null || __panel.text(document.querySelector('[role="alert"]')) !== '', [], 60_000);
  expect(await panel.run(() => __panel.text(document.querySelector('[role="alert"]')))).toBe('');

  await panel.run(() => __panel.button('Fill this form')!.click());
  await panel.until('the fill', () => __panel.button('Undo') !== null || __panel.text(document.querySelector('[role="alert"]')) !== '', [], 120_000);
  expect(await panel.run(() => __panel.text(document.querySelector('[role="alert"]')))).toBe('');

  // Each subject in its own box, read off a scanned card's second page.
  const typed = await portal.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll<HTMLInputElement>('input:not([type="file"])')].map((box) => [box.id, box.value]),
    ),
  );
  expect(typed).toEqual({
    candName: 'PRIYA S',
    pucReg: '765432',
    pucCollege: 'SRI VIDYA PU COLLEGE, TUMKUR',
    pucYear: '2022',
    phy: '81',
    che: '77',
    mat: '88',
    bio: '90',
    eng: '82',
    tot: '509',
    max: '600',
  });

  // Both documents, as the boxes ask: PDFs inside their limits — and the
  // e-Aadhaar unlocked, since nobody on the portal's side has its password.
  const files = await portal.evaluate(() =>
    Promise.all(
      ['aadhaarFile', 'marksFile'].map(async (id) => {
        const file = document.querySelector<HTMLInputElement>(`#${id}`)?.files?.[0];
        if (file === undefined) return null;
        const text = new TextDecoder('latin1').decode(new Uint8Array(await file.arrayBuffer()));
        return { type: file.type, size: file.size, pdf: text.startsWith('%PDF'), locked: text.includes('/Encrypt') };
      }),
    ),
  );
  expect(files[0]).toMatchObject({ type: 'application/pdf', pdf: true, locked: false });
  expect(files[0]!.size).toBeLessThanOrEqual(500 * 1024);
  expect(files[1]).toMatchObject({ type: 'application/pdf', pdf: true, locked: false });
  expect(files[1]!.size).toBeLessThanOrEqual(2 * 1024 * 1024);

  // And the e-Aadhaar copy shows the document, not a blank page: the picture
  // inside it, measured for ink. (Made from a locked file, it is a fresh page
  // drawn from the original — the step most likely to come out empty.)
  const ink = await portal.evaluate(async () => {
    const file = document.querySelector<HTMLInputElement>('#aadhaarFile')!.files![0]!;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const text = new TextDecoder('latin1').decode(bytes);
    const image = text.indexOf('/DCTDecode');
    const length = Number(/\/Length (\d+)/.exec(text.slice(image))?.[1]);
    const start = text.indexOf('stream\n', image) + 'stream\n'.length;
    const bitmap = await createImageBitmap(new Blob([bytes.slice(start, start + length)], { type: 'image/jpeg' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i]! + data[i + 1]! + data[i + 2]! < 384) dark += 1;
    return dark / (data.length / 4);
  });
  expect(ink).toBeGreaterThan(0.002);

  // Filled, and left for the person to review and submit.
  expect(portal.url()).toBe(PORTAL);
  await portal.close();
});

test('answers a Google Forms-style survey by choosing options, "Other" included, and submits nothing', async () => {
  // A Google Form has no <select> and no radio button: every answer here is an
  // option the page shows, chosen by pressing it, and none of them says the
  // value the way the vault does. Made-up answers, stored the way the vault
  // editor stores them.
  test.setTimeout(120_000);
  const answers: Record<string, string> = {
    'identity.gender': 'Female',
    'identity.category': 'OBC',
    'family.annual_income': '30000',
    'education.class_10.board_or_university': 'KARNATAKA SECONDARY EDUCATION EXAMINATION BOARD',
    'education.undergraduate.course': 'B.E.',
    'education.undergraduate.branch': 'Computer Science and Engineering',
    'education.undergraduate.board_or_university': 'Tumkur University',
  };
  for (const [key, value] of Object.entries(answers)) {
    const reply = await panel.run(
      (k: string, v: string) =>
        chrome.runtime.sendMessage({ __af: true, at: Date.now(), payload: { type: 'vault:set', key: k, value: v } }),
      key,
      value,
    );
    expect(reply, key).toMatchObject({ ok: true });
  }

  const SURVEY = 'http://localhost:4173/choice-portal/google-form.html';
  const portal = await panel.context.newPage();
  await portal.goto(SURVEY);
  await portal.bringToFront();
  await panel.pressToolbarButton(SURVEY);

  await panel.run(() => __panel.button('Scan page')!.click());
  await panel.until('the scan', () => __panel.button('Fill this form') !== null || __panel.text(document.querySelector('[role="alert"]')) !== '', [], 60_000);
  expect(await panel.run(() => __panel.text(document.querySelector('[role="alert"]')))).toBe('');

  await panel.run(() => __panel.button('Fill this form')!.click());
  await panel.until('the fill', () => __panel.button('Undo') !== null || __panel.text(document.querySelector('[role="alert"]')) !== '', [], 120_000);
  expect(await panel.run(() => __panel.text(document.querySelector('[role="alert"]')))).toBe('');

  // What the page itself recorded — the hidden entry each question writes to
  // when one of its options is pressed — and which options it shows chosen.
  const recorded = await portal.evaluate(() => ({
    entries: [...document.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map((input) => input.value),
    chosen: [...document.querySelectorAll('[aria-checked="true"]')].map((el) => el.getAttribute('aria-label')),
    lists: [...document.querySelectorAll('[role="listbox"]')].map((list) => ({
      shown: list.querySelector('.closed [aria-selected="true"]')?.textContent?.trim(),
      open: list.getAttribute('aria-expanded'),
    })),
    other: [...document.querySelectorAll<HTMLInputElement>('[aria-label="Other response"]')].map((box) => box.value),
    name: document.querySelector<HTMLInputElement>('input[aria-labelledby="i1"]')!.value,
    submitted: document.getElementById('mG61Hd')!.hasAttribute('data-submitted'),
  }));
  expect(recorded).toEqual({
    entries: ['', 'Female', 'Computer Science / IT', 'OBC', 'Below ₹1,00,000', 'State Board', 'Tumkur University'],
    chosen: ['Female', 'OBC', 'State Board', 'Other:'],
    lists: [
      { shown: 'Computer Science / IT', open: 'false' },
      { shown: 'Below ₹1,00,000', open: 'false' },
    ],
    // Gender's, the board's and the university's boxes: only the last is "Other".
    other: ['', '', 'Tumkur University'],
    name: 'PRIYA S',
    submitted: false,
  });

  // Filled, and left for the person to review and submit.
  expect(portal.url()).toBe(SURVEY);
  await portal.close();
});

test('reads a certificate printed in Hindi, and answers "Name in Hindi" with it — never "Name in Kannada"', async () => {
  // Made up (`scripts/make-indic-fixtures.mjs`), rendered by the browser so its
  // Hindi is shaped as print is, a watermark across two of its lines.
  test.setTimeout(240_000);
  const INCOME = 'Income certificate';
  await chooseAndSave(INCOME, picture('hindi-income-certificate.jpg'));
  await saved(INCOME);
  const reading = await read(INCOME);

  expect(reading.alerts).toEqual([]);
  expect(valueOf(reading, 'family.annual_income')?.value).toBe('48000');
  // The names as printed, kept as the names in the holder's language — not
  // offered as the English name, which is what this card does not print.
  expect(valueOf(reading, 'identity.full_name_local')?.value).toBe('सीमा वर्मा');
  expect(valueOf(reading, 'family.father_name_local')?.value).toBe('राजेश वर्मा');
  expect(valueOf(reading, 'identity.full_name')).toBeUndefined();

  // Save what was read.
  await panel.run((l: string) => {
    const box = __panel.reading(l)!;
    for (const tick of box.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) if (!tick.checked) tick.click();
  }, INCOME);
  await panel.until(
    'the save button',
    (l: string) => [...__panel.reading(l)!.querySelectorAll('button')].some((b) => /^Save \d+ details? to my vault$/.test(__panel.text(b))),
    [INCOME],
  );
  await panel.run(
    (l: string) =>
      [...__panel.reading(l)!.querySelectorAll('button')].find((b) => /^Save \d+ details? to my vault$/.test(__panel.text(b)))!.click(),
    INCOME,
  );
  await panel.until('the saved notice', () => /Saved \d+ details? to your vault\./.test(document.body.textContent ?? ''), []);

  // And a form that asks for the name in English, in Hindi and in Kannada.
  const FORM = 'http://localhost:4173/indic-portal/name-in-hindi.html';
  const portal = await panel.context.newPage();
  await portal.goto(FORM);
  await portal.bringToFront();
  await panel.pressToolbarButton(FORM);
  await panel.run(() => __panel.button('Scan page')!.click());
  await panel.until('the scan', () => __panel.button('Fill this form') !== null || __panel.text(document.querySelector('[role="alert"]')) !== '', [], 60_000);
  await panel.run(() => __panel.button('Fill this form')!.click());
  await panel.until('the fill', () => __panel.button('Undo') !== null || __panel.text(document.querySelector('[role="alert"]')) !== '', [], 120_000);
  expect(await panel.run(() => __panel.text(document.querySelector('[role="alert"]')))).toBe('');

  const filled = await portal.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll<HTMLInputElement>('input')].map((box) => [box.id, box.value])),
  );
  expect(filled).toEqual({
    nameEn: 'PRIYA S',
    nameHi: 'सीमा वर्मा',
    fatherHi: 'राजेश वर्मा',
    // The vault holds the name in Hindi, and this asks for it in Kannada.
    nameKn: '',
    income: '48000',
  });
  expect(await panel.run(() => /left blank — they ask for the name in a\s+language your vault does not hold it in/.test(document.body.textContent ?? ''))).toBe(true);
  expect(await portal.evaluate(() => document.body.hasAttribute('data-submitted'))).toBe(false);
  await portal.close();
});

test('reads a photo of a curled marks card with every subject’s marks beside the right subject', async () => {
  // Made up (`scripts/make-curled-photo-fixture.*`): curled, tilted, on a
  // table. Read as photographed, each subject's marks paired with the next
  // subject's name; UVDoc flattens it first, and each picture beside a value is
  // cut from the flattened page the value was read off.
  test.setTimeout(240_000);
  const CARD = 'Class 10 marks card';
  await chooseAndSave(CARD, picture('curled-marks-card.jpg'));
  await saved(CARD);
  const reading = await read(CARD);

  expect(reading.alerts).toEqual([]);
  const marks = Object.fromEntries(
    ['english', 'mathematics', 'science', 'social_science'].map((subject) => [
      subject,
      valueOf(reading, `education.class_10.marks_${subject}`)?.value,
    ]),
  );
  expect(marks).toEqual({ english: '87', mathematics: '93', science: '89', social_science: '84' });
  expect(valueOf(reading, 'education.class_10.registration_number')?.value).toBe('4815162342');
  expect(valueOf(reading, 'identity.dob')?.value).toBe('2006-07-09');
  expect(reading.rows.every((row) => row.picture), 'a value without its picture').toBe(true);
  expect(reading.notes.join(' ')).toMatch(/flattened before it was read/);
});

test('reads a semester grade card’s table: its courses, their total, SGPA, CGPA and backlogs', async () => {
  // Made up (`scripts/make-grade-card-fixtures.mjs`). Read as lines, this card
  // gave the vault its result, "of the Student ARJUN MEHTA" as a name and
  // "Seat Number 1SA21CS042" as a university. Its courses are a table, read
  // cell by cell by SLANet_plus and the reader's own text.
  test.setTimeout(240_000);
  const CARD = 'Semester marks card';
  await chooseAndSave(CARD, picture('grade-card-ruled.png'));
  await saved(CARD);
  const reading = await read(CARD);

  expect(reading.alerts).toEqual([]);
  const value = (key: string) => valueOf(reading, key)?.value;
  expect(value('identity.full_name')).toBe('ARJUN MEHTA');
  expect(value('education.undergraduate.registration_number')).toBe('1SA21CS042');
  expect(value('education.undergraduate.board_or_university')).toBe('SAMPLE TECHNOLOGICAL UNIVERSITY');
  expect(value('education.undergraduate.sgpa')).toBe('8.45');
  expect(value('education.undergraduate.cgpa')).toBe('8.21');
  expect(value('education.undergraduate.result_status')).toBe('PASS');
  // From the table alone: the lines cannot say these.
  expect(value('education.undergraduate.subjects')).toBe(
    [
      'Transform Calculus, Fourier Series and Numerical Techniques',
      'Data Structures and Applications',
      'Analog and Digital Electronics',
      'Computer Organization and Architecture',
      'Object Oriented Programming with Java',
      'Data Structures Laboratory',
      'Samskrutika Kannada',
    ].join('; '),
  );
  expect(value('education.undergraduate.marks_obtained')).toBe('659');
  expect(value('education.undergraduate.backlogs')).toBe('0');
  // The card's semester is not the one the student is in now.
  expect(value('education.undergraduate.semester')).toBeUndefined();
  // Nothing on a grade card carries a checksum: nothing is ticked for the user.
  expect(reading.rows.filter((row) => row.ticked)).toEqual([]);
});

test('reads a certificate’s issuing authority off its seal, and fills a reservation form with it', async () => {
  // Made up (`scripts/make-seal-fixtures.mjs`): the authority is printed only
  // in the seal. Read, ticked, saved — then a central-style reservation form
  // asks for it under "OBC Certificate Details", in boxes that name no
  // certificate, and asks "Date of Issue" again under "Passport Details".
  test.setTimeout(240_000);
  const CASTE = 'Caste certificate';
  await chooseAndSave(CASTE, picture('caste-certificate-seal.png'));
  await saved(CASTE);
  const reading = await read(CASTE);

  expect(reading.alerts).toEqual([]);
  const authority = valueOf(reading, 'eligibility.caste_certificate_authority');
  expect(authority?.value).toBe('TAHSILDAR, SAMPLEPURA TALUK');
  // Its picture is the seal it was read from.
  expect(authority?.picture).toBe(true);
  expect(authority?.ticked).toBe(false);
  expect(valueOf(reading, 'eligibility.caste_certificate_date')?.value).toBe('2024-03-14');
  // Its zero printed as a small o, and read as one.
  expect(valueOf(reading, 'eligibility.caste_certificate_number')?.value).toBe('RD0987654321012');

  // Save the certificate's own three, and nothing else it says.
  const CERTIFICATE = ['number', 'date', 'authority'].map((part) => `eligibility.caste_certificate_${part}`);
  await panel.run(
    (l: string, keys: string[]) => {
      for (const key of keys) {
        const row = document.getElementById(`extract-${key}`)!.closest('li')!;
        const tick = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
        if (!tick.checked) tick.click();
      }
      void l;
    },
    CASTE,
    CERTIFICATE,
  );
  await panel.until(
    'the save button',
    (l: string) => [...__panel.reading(l)!.querySelectorAll('button')].some((b) => /^Save 3 details to my vault$/.test(__panel.text(b))),
    [CASTE],
  );
  await panel.run(
    (l: string) =>
      [...__panel.reading(l)!.querySelectorAll('button')].find((b) => /^Save 3 details to my vault$/.test(__panel.text(b)))!.click(),
    CASTE,
  );
  await panel.until('the saved notice', () => /Saved 3 details to your vault\./.test(document.body.textContent ?? ''), []);
  const vault = await panel.ask<Array<{ key: string; value: string }>>({ type: 'vault:list' });
  const stored = new Map((vault.data ?? []).map((entry) => [entry.key, entry.value]));

  const FORM = 'http://localhost:4173/certificate-portal/reservation.html';
  const portal = await panel.context.newPage();
  await portal.goto(FORM);
  await portal.bringToFront();
  await panel.pressToolbarButton(FORM);
  await panel.run(() => __panel.button('Scan page')!.click());
  await panel.until('the scan', () => __panel.button('Fill this form') !== null || __panel.text(document.querySelector('[role="alert"]')) !== '', [], 60_000);
  await panel.run(() => __panel.button('Fill this form')!.click());
  await panel.until('the fill', () => __panel.button('Undo') !== null || __panel.text(document.querySelector('[role="alert"]')) !== '', [], 120_000);
  expect(await panel.run(() => __panel.text(document.querySelector('[role="alert"]')))).toBe('');

  const filled = await portal.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll<HTMLInputElement>('input')].map((box) => [box.id, box.value])),
  );
  // Under "OBC Certificate Details": the caste certificate's, the date as the box asks for it.
  expect(filled.f1).toBe('RD0987654321012');
  expect(filled.f2).toBe('14/03/2024');
  expect(filled.f3).toBe('TAHSILDAR, SAMPLEPURA TALUK');
  // Under "EWS Certificate Details": the income certificate's, if the vault has one — never the caste one's.
  expect(filled.f4).toBe(stored.get('eligibility.income_certificate_number') ?? '');
  expect(filled.f6).toBe(stored.get('eligibility.income_certificate_authority') ?? '');
  expect(filled.f6).not.toBe('TAHSILDAR, SAMPLEPURA TALUK');
  // A passport's date of issue: nothing the vault holds.
  expect(filled.f10).toBe('');
  expect(await portal.evaluate(() => document.body.hasAttribute('data-submitted'))).toBe(false);
  await portal.close();
});

test('makes a clean scan of a stored photo, shows it, and keeps it only when saved', async () => {
  test.setTimeout(240_000);
  const CARD = 'Class 10 marks card';
  const before = await panel.ask<Array<{ key: string; meta: { width: number; height: number } }>>({ type: 'doc:list' });
  const was = before.data!.find((document) => document.key === 'doc.marksheet_10')!.meta;

  // "Read details from this" toggles a slot's reading, and the panel shows one
  // reading at a time: whether this slot's is open depends on which test read
  // last. Closed here if it is open, and opened fresh at the end.
  if (await panel.run((l: string) => __panel.reading(l) !== null, CARD)) {
    await panel.run((l: string) => __panel.button('Read details from this', __panel.slot(l))!.click(), CARD);
    await panel.until('the reading to close', (l: string) => __panel.reading(l) === null, [CARD]);
  }

  await panel.run((l: string) => __panel.button('Make a clean scan', __panel.slot(l))!.click(), CARD);
  await panel.until(
    'the clean scan',
    (l: string) => __panel.slot(l)?.querySelector('img[alt^="The clean scan"]') !== null,
    [CARD],
    120_000,
  );
  const shown = await panel.run((l: string) => {
    const slot = __panel.slot(l)!;
    const img = slot.querySelector<HTMLImageElement>('img[alt^="The clean scan"]')!;
    return {
      loaded: img.complete && img.naturalWidth > 0,
      caption: __panel.text(slot.querySelector('figcaption')),
      staged: /Ready to save: clean-scan\.jpg/.test(slot.textContent ?? ''),
    };
  }, CARD);
  expect(shown.loaded).toBe(true);
  expect(shown.caption).toMatch(/^Flattened/);
  expect(shown.staged).toBe(true);

  // Nothing stored until Save.
  const unchanged = await panel.ask<Array<{ key: string; meta: { width: number; height: number } }>>({ type: 'doc:list' });
  expect(unchanged.data!.find((document) => document.key === 'doc.marksheet_10')!.meta).toMatchObject(was);

  await panel.run((l: string) => __panel.button(`Save ${l} to vault`, __panel.slot(l))!.click(), CARD);
  await saved(CARD);
  const after = await panel.ask<Array<{ key: string; meta: { width: number; height: number; mime: string } }>>({
    type: 'doc:list',
  });
  const now = after.data!.find((document) => document.key === 'doc.marksheet_10')!.meta;
  expect(now.mime).toBe('image/jpeg');
  // The table trimmed off: the scan is the page, smaller than the photo.
  expect(now.height).toBeLessThan(was.height);

  // And the scan reads as well as the photo did — now with nothing to flatten.
  const reading = await read(CARD);
  expect(valueOf(reading, 'education.class_10.marks_mathematics')?.value).toBe('93');
  expect(reading.notes.join(' ')).not.toMatch(/flattened/);
});

test('previews a bank passbook whole, as a document, large enough to check', async () => {
  // Found on the user's own passbook: previewed against a passport photo's
  // 3.5 x 4.5 cm — the one example requirement every document got — it came
  // back cut down the middle, as a 64-pixel thumbnail.
  await chooseAndSave(PASSBOOK, fileURLToPath(new URL('../../fixtures/images/passbook.jpg', import.meta.url)));
  await panel.until(
    'the save',
    (l: string) => !/Ready to save:/.test(__panel.slot(l)?.textContent ?? '') && __panel.button('Preview for this portal', __panel.slot(l)) !== null,
    [PASSBOOK],
    60_000,
  );
  await panel.run((l: string) => __panel.button('Preview for this portal', __panel.slot(l))!.click(), PASSBOOK);
  await panel.until(
    'the preview',
    (l: string) => {
      const picture = __panel.slot(l)?.querySelector<HTMLImageElement>('img[alt^="Derived"]');
      return picture !== null && picture !== undefined && picture.complete && picture.naturalWidth > 0;
    },
    [PASSBOOK],
    60_000,
  );

  const preview = await panel.run((l: string) => {
    const slot = __panel.slot(l)!;
    const picture = slot.querySelector<HTMLImageElement>('img[alt^="Derived"]')!;
    return {
      natural: [picture.naturalWidth, picture.naturalHeight],
      shown: picture.clientWidth,
      slotWidth: slot.clientWidth,
      text: __panel.text(slot),
      fullSize: [...slot.querySelectorAll('a')].some((a) => /full size/.test(__panel.text(a))),
    };
  }, PASSBOOK);

  // The whole page, the shape it was — not a portrait cut from its middle.
  expect(preview.natural).toEqual([1600, 1000]);
  // Across the panel, not a thumbnail; and the whole of it a click away.
  expect(preview.shown).toBeGreaterThan(preview.slotWidth * 0.75);
  expect(preview.fullSize).toBe(true);
  // Previewed against an example for a document, and saying so.
  expect(preview.text).toMatch(/JPEG\/PDF, ≤ 500 KB — an example for this kind of document/);
});

test('remakes a scanned PDF of three pages as three pages, inside the portal’s limit', async () => {
  // A copy of a PDF of several pages, remade because the portal's limits do
  // not take it as it is, used to be made from page 1 alone: a marks card's
  // subjects and total, on pages 2 and 3, never reached the portal.
  test.setTimeout(120_000);
  await panel.run((requirement: string) => {
    const field = [...document.querySelectorAll('textarea')].find((t) => /upload box/.test(t.placeholder))!;
    __panel.type(field, requirement);
  }, 'PDF only, up to 1 MB, maximum 1000 x 1500 pixels');

  await panel.run((l: string) => __panel.button('Preview for this portal', __panel.slot(l))!.click(), MARKS);
  await panel.until('the copy', (l: string) => /\d+ KB · \d+×\d+ px/.test(__panel.slot(l)?.textContent ?? '') || /could not|cannot|over the portal/i.test(__panel.slot(l)?.textContent ?? ''), [MARKS], 90_000);

  const copy = await panel.run(async (l: string) => {
    const slot = __panel.slot(l)!;
    const link = [...slot.querySelectorAll('a')].find((a) => /full size/.test(__panel.text(a)));
    const bytes = link ? new Uint8Array(await (await fetch(link.href)).arrayBuffer()) : new Uint8Array();
    const text = new TextDecoder('latin1').decode(bytes);
    // The ink on each page's picture: a page drawn blank would still count.
    const ink: number[] = [];
    for (let at = text.indexOf('/DCTDecode'); at !== -1; at = text.indexOf('/DCTDecode', at + 1)) {
      const length = Number(/\/Length (\d+)/.exec(text.slice(at))?.[1]);
      const start = text.indexOf('stream\n', at) + 'stream\n'.length;
      const bitmap = await createImageBitmap(new Blob([bytes.slice(start, start + length)], { type: 'image/jpeg' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i]! + data[i + 1]! + data[i + 2]! < 384) dark += 1;
      ink.push(dark / (data.length / 4));
    }
    return {
      line: __panel.text(slot),
      size: bytes.length,
      pages: (text.match(/\/Type \/Page /g) ?? []).length,
      locked: text.includes('/Encrypt'),
      ink,
    };
  }, MARKS);

  expect(copy.line).toMatch(/px · 3 pages/);
  expect(copy.pages).toBe(3);
  expect(copy.locked).toBe(false);
  expect(copy.size).toBeLessThanOrEqual(1024 * 1024);
  // Every page drawn: the fax page and the JPEG 2000 page included.
  expect(copy.ink).toHaveLength(3);
  for (const [index, share] of copy.ink.entries()) expect(share, `page ${index + 1}`).toBeGreaterThan(0.002);

  // Leave the requirement empty for whatever runs next.
  await panel.run(() => {
    const field = [...document.querySelectorAll('textarea')].find((t) => /upload box/.test(t.placeholder))!;
    __panel.type(field, '');
  });
});

test('sends nothing anywhere, from any extension page or worker', async () => {
  // The watch must have seen where a document goes — the worker, the offscreen
  // page, the reader inside it — or "nothing" would mean nothing. The reader
  // fetching its models from the package is the proof it was watched.
  expect([...panel.watched]).toEqual(expect.arrayContaining(['page', 'service_worker', 'worker']));
  expect(
    panel.traffic.some((request) => request.type === 'worker' && request.url.endsWith('/ocr/PP-OCRv5_mobile_det.onnx')),
  ).toBe(true);
  expect(panel.outside).toEqual([]);
  expect(panel.problems).toEqual([]);
});

test('logs no error or warning on any extension page or worker', async () => {
  // What chrome://extensions lists under the extension's Errors. The reader's
  // runtime announced, on every load, each unused weight left in its models
  // by their conversion — a screenful of "errors" for a reader that worked.
  // The reader was watched, or an empty list would prove nothing.
  expect([...panel.watched]).toEqual(expect.arrayContaining(['page', 'service_worker', 'worker']));
  expect(panel.logged).toEqual([]);
});
