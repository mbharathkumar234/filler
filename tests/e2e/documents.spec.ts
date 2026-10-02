import { expect, test, type Frame, type Page } from '@playwright/test';

/**
 * Documents into real pages, in a real browser.
 *
 * jsdom has no `DataTransfer` and no `DragEvent`, so every claim that a file
 * actually lands somewhere — and that the page sees it land — is made here.
 * It is the "ran somewhere more permissive than production" trap STATUS.md
 * records three times, avoided on purpose.
 */

const PORTAL = '/documents-portal/page-1.html';
const GOOGLE_STYLE = '/documents-portal/google-style.html';
const PHOTO = '/photo-4mb.jpg';

/** A small stand-in for a derived file: the pages check names and types, not pixels. */
const BYTES = Buffer.from('fake jpeg bytes for an upload test').toString('base64');

async function withHarness(page: Page, url: string) {
  await page.goto(url);
  const src = await page.evaluate(async () => {
    const html = await (await fetch('/_harness/index.html')).text();
    return /src="([^"]+)"/.exec(html)?.[1]?.replace('./', '/_harness/') ?? '';
  });
  expect(src).toBeTruthy();
  await page.addScriptTag({ url: src, type: 'module' });
  await page.waitForFunction(() => typeof window.__documents === 'object');
}

test.describe('file boxes', () => {
  test('a document lands in the box, and the page hears it land', async ({ page }) => {
    await withHarness(page, PORTAL);
    await page.evaluate(() => {
      (window as unknown as { __changes: number }).__changes = 0;
      document.getElementById('fuPhoto')!.addEventListener('change', () => {
        (window as unknown as { __changes: number }).__changes += 1;
      });
    });

    const records = await page.evaluate(
      (b64) => window.__documents.attach('fuPhoto', b64, 'image/jpeg', 'photo.jpg'),
      BYTES,
    );

    expect(records).toEqual([{ ref: 'fuPhoto', ok: true, strategy: 'file', reason: '' }]);
    expect(await page.evaluate(() => window.__documents.file('fuPhoto'))).toEqual({
      name: 'photo.jpg',
      type: 'image/jpeg',
      size: Buffer.from(BYTES, 'base64').length,
    });
    expect(await page.evaluate(() => (window as unknown as { __changes: number }).__changes)).toBeGreaterThan(0);
  });

  test('a box hidden behind a styled "Choose file" label takes one too', async ({ page }) => {
    await withHarness(page, PORTAL);
    const [record] = await page.evaluate(
      (b64) => window.__documents.attach('aadhaarDoc', b64, 'application/pdf', 'aadhaar_card.pdf'),
      BYTES,
    );
    expect(record?.ok).toBe(true);
    expect((await page.evaluate(() => window.__documents.file('aadhaarDoc')))?.name).toBe('aadhaar_card.pdf');
  });

  test('the real pipeline fits the real photo to the box’s own words', async ({ page }) => {
    // "JPEG only, 20 KB to 50 KB, 3.5 cm x 4.5 cm", read off the page beside
    // the box, then a 3.6 MB phone photo derived to it and attached.
    await withHarness(page, PORTAL);
    const result = await page.evaluate((url) => window.__documents.deriveAndAttach('fuPhoto', url, 'image/jpeg'), PHOTO);

    expect(result.ok, result.reason).toBe(true);
    expect(result.minBytes).toBe(20 * 1024);
    expect(result.maxBytes).toBe(50 * 1024);

    const file = await page.evaluate(() => window.__documents.file('fuPhoto'));
    expect(file?.type).toBe('image/jpeg');
    expect(file!.size).toBeGreaterThanOrEqual(20 * 1024);
    expect(file!.size).toBeLessThanOrEqual(50 * 1024);
  });

  test('Undo empties a box that was empty', async ({ page }) => {
    await withHarness(page, PORTAL);

    await page.evaluate((b64) => window.__documents.attach('fuSign', b64, 'image/jpeg', 'signature.jpg'), BYTES);
    expect(await page.evaluate(() => window.__documents.undo())).toBe(1);
    expect(await page.evaluate(() => window.__documents.file('fuSign'))).toBeNull();
  });

  test('Undo gives back a file the user had chosen themselves', async ({ page }) => {
    // Setting `.value` on a file box throws once it holds a file, which is how
    // Undo used to break here. The user's own pick must come back whole.
    await withHarness(page, PORTAL);
    await page.setInputFiles('#fuSign', {
      name: 'mine.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from('the user picked this'),
    });

    await page.evaluate((b64) => window.__documents.attach('fuSign', b64, 'image/jpeg', 'signature.jpg'), BYTES);
    expect((await page.evaluate(() => window.__documents.file('fuSign')))?.name).toBe('signature.jpg');

    expect(await page.evaluate(() => window.__documents.undo())).toBe(1);
    expect((await page.evaluate(() => window.__documents.file('fuSign')))?.name).toBe('mine.jpg');
  });

  test('reads each box’s requirement and accept list off the page', async ({ page }) => {
    await withHarness(page, PORTAL);
    const boxes = await page.evaluate(() => window.__documents.harvest());

    expect(boxes.find((b) => b.id === 'fuPhoto')).toMatchObject({
      labelText: 'Upload your recent passport size photo',
      accept: '.jpg,.jpeg',
      requirementText: 'JPEG only, 20 KB to 50 KB, 3.5 cm x 4.5 cm',
    });
    expect(boxes.find((b) => b.name === 'aadhaarDoc')?.labelText).toBe('Upload your Aadhaar card copy');
    expect(boxes.find((b) => b.id === 'degree-input')?.labelText).toBe('');
  });
});

test.describe('a drag-and-drop area with no file box', () => {
  test('the widget receives the dropped file', async ({ page }) => {
    await withHarness(page, PORTAL);
    const [record] = await page.evaluate(
      (b64) => window.__documents.attach('degree-drop', b64, 'application/pdf', 'degree_certificate.pdf'),
      BYTES,
    );

    expect(record).toMatchObject({ ok: true, strategy: 'drop' });
    expect(await page.evaluate(() => window.__dropped)).toEqual([
      { name: 'degree_certificate.pdf', type: 'application/pdf', size: Buffer.from(BYTES, 'base64').length },
    ]);
  });

  test('is found as an upload question with the question’s own words', async ({ page }) => {
    await withHarness(page, PORTAL);
    const slots = await page.evaluate(() => window.__documents.slots());
    expect(slots).toEqual([
      expect.objectContaining({ kind: 'drop', label: 'Upload Degree Certificate', requirementText: 'PDF only, up to 2 MB' }),
    ]);
  });
});

test.describe('a portal’s own Upload button', () => {
  test('is recorded beside its box, and never as the final submit', async ({ page }) => {
    await withHarness(page, PORTAL);
    expect(await page.evaluate(() => window.__documents.uploadButton('fuPhoto'))).toEqual({
      selector: '#btnUploadPhoto',
      label: 'Upload',
    });
  });

  test('is blocked unapproved — even pressed by the user — and posts once, with one document, approved', async ({ page }) => {
    await withHarness(page, PORTAL);
    await page.evaluate(() => window.__installGuard());
    await page.evaluate((b64) => window.__documents.attach('fuPhoto', b64, 'image/jpeg', 'photo.jpg'), BYTES);
    await page.evaluate((b64) => window.__documents.attach('fuSign', b64, 'image/jpeg', 'signature.jpg'), BYTES);

    // Unapproved: the guard blocks the press, and the page stays put.
    await page.click('#btnUploadPhoto');
    expect(page.url()).toContain(PORTAL);
    expect((await page.evaluate(() => window.__guardReport())).blocked).toBeGreaterThan(0);

    // Approved: exactly that button, and the form carries only that document.
    await Promise.all([
      page.waitForURL(/uploaded\.html/),
      page.evaluate(() => window.__documents.pressUpload('#btnUploadPhoto', 'fuPhoto')),
    ]);
    const posted = new URL(page.url()).searchParams;
    expect(posted.get('btnUploadPhoto')).toBe('Upload');
    expect(posted.get('fuPhoto')).toBe('photo.jpg');
    expect(posted.get('fuSign'), 'the unapproved document went with it').toBe('');
    expect(posted.has('btnFinal')).toBe(false);
  });
});

test.describe('an upload window the user opens (Google Forms style)', () => {
  async function openWindow(page: Page, button: string): Promise<Frame> {
    await page.click(button);
    for (;;) {
      const frame = page.frame({ name: 'upload-window' });
      if (frame) {
        await frame.waitForSelector('#upload');
        return frame;
      }
      await page.waitForTimeout(50);
    }
  }

  test('each question is found, with its caption and its hint', async ({ page }) => {
    await withHarness(page, GOOGLE_STYLE);
    const slots = await page.evaluate(() => window.__documents.slots());
    expect(slots.map((s) => [s.kind, s.label])).toEqual([
      ['window', 'Upload your recent passport size photo'],
      ['window', 'Upload your Aadhaar card copy'],
      ['window', 'Upload your PAN card copy'],
      ['window', 'Upload your 10th marks card'],
    ]);
    expect(slots[1]?.requirementText).toBe('Upload 1 supported file: PDF. Max 10 MB.');
  });

  test('the file goes into the window, from the functions’ own source, and nothing is pressed', async ({ page }) => {
    await withHarness(page, GOOGLE_STYLE);
    const { probe, place } = await page.evaluate(() => window.__documents.windowFunctions());
    const frame = await openWindow(page, '#add-photo');

    // Run exactly as `executeScript({ func })` does: the source text alone,
    // in a page that has nothing of ours in it. A function that reached for
    // anything outside itself fails here.
    const found = await frame.evaluate(`(${probe})()`);
    expect(found).toMatchObject({ top: false, fileBoxes: 1, dropAreas: 1 });

    const result = await frame.evaluate(`(${place})(${JSON.stringify(BYTES)}, 'image/jpeg', 'photo.jpg', 'box')`);
    expect(result).toEqual({ placed: true, route: 'file-box' });

    expect(await frame.evaluate(() => window.__received)).toEqual([
      { name: 'photo.jpg', type: 'image/jpeg', size: Buffer.from(BYTES, 'base64').length, via: 'box' },
    ]);
    expect(await frame.evaluate(() => window.__uploadPresses), 'the extension pressed Upload').toBe(0);
  });

  test('the second try drops the file instead', async ({ page }) => {
    await withHarness(page, GOOGLE_STYLE);
    const { place } = await page.evaluate(() => window.__documents.windowFunctions());
    const frame = await openWindow(page, '#add-pan');

    const result = await frame.evaluate(`(${place})(${JSON.stringify(BYTES)}, 'application/pdf', 'pan_card.pdf', 'drop')`);

    expect(result).toEqual({ placed: true, route: 'drop' });
    expect((await frame.evaluate(() => window.__received))?.map((r) => r.via)).toEqual(['drop']);
  });

  test('Add file is pressed with a live approval, and not with a lapsed one', async ({ page }) => {
    await withHarness(page, GOOGLE_STYLE);
    const { open } = await page.evaluate(() => window.__documents.windowFunctions());

    const lapsed = await page.evaluate(
      `(${open})('Upload your PAN card copy', ['#add-pan'], { value: 't', expiresAt: 1 })`,
    );
    expect(lapsed).toBe('');
    expect(page.frame({ name: 'upload-window' })).toBeNull();

    const live = await page.evaluate(
      `(${open})('Upload your PAN card copy', ['#add-pan'], { value: 't', expiresAt: Date.now() + 60000 })`,
    );
    expect(live).toBe('by caption');
    await expect(page.locator('.dialog iframe')).toHaveCount(1);
    expect(await page.locator('.dialog').getAttribute('data-for')).toBe('add-pan');
  });

  test('finds each question’s Add file by its words, even when a recorded path has gone stale', async ({ page }) => {
    // The first upload changes the page; a path recorded before it can point
    // anywhere. Here every recorded path is wrong on purpose.
    await withHarness(page, GOOGLE_STYLE);
    const { open } = await page.evaluate(() => window.__documents.windowFunctions());
    const token = '{ value: "t", expiresAt: Date.now() + 60000 }';

    const how = await page.evaluate(`(${open})('Upload your 10th marks card', ['#add-photo'], ${token})`);

    expect(how).toBe('by caption');
    expect(await page.locator('.dialog').getAttribute('data-for')).toBe('add-marks10');
  });

  test('presses nothing for a question that already has its file', async ({ page }) => {
    await withHarness(page, GOOGLE_STYLE);
    const { open } = await page.evaluate(() => window.__documents.windowFunctions());
    await page.evaluate(() => {
      (document.getElementById('add-photo') as HTMLElement).style.display = 'none';
    });

    const how = await page.evaluate(
      `(${open})('Upload your recent passport size photo', ['#add-photo'], { value: 't', expiresAt: Date.now() + 60000 })`,
    );

    expect(how).toBe('');
    await expect(page.locator('.dialog')).toHaveCount(0);
  });

  test('the window’s own Upload is pressed with an approval, and only that', async ({ page }) => {
    await withHarness(page, GOOGLE_STYLE);
    const { press } = await page.evaluate(() => window.__documents.windowFunctions());
    const frame = await openWindow(page, '#add-photo');

    expect(await frame.evaluate(`(${press})({ value: 't', expiresAt: 1 })`)).toBe(false);
    expect(await frame.evaluate(() => window.__uploadPresses)).toBe(0);

    expect(await frame.evaluate(`(${press})({ value: 't', expiresAt: Date.now() + 60000 })`)).toBe(true);
    expect(await frame.evaluate(() => window.__uploadPresses)).toBe(1);
  });

  test('the form, not memory, says whether a document is on it', async ({ page }) => {
    await withHarness(page, GOOGLE_STYLE);
    const { place, shows } = await page.evaluate(() => window.__documents.windowFunctions());
    const onForm = () =>
      page.evaluate(`(${shows})('Upload your recent passport size photo', 'photo.jpg')`);

    expect(await onForm()).toBe(false);

    const frame = await openWindow(page, '#add-photo');
    await frame.evaluate(`(${place})(${JSON.stringify(BYTES)}, 'image/jpeg', 'photo.jpg', 'box')`);
    await expect(page.locator('.chip')).toHaveText(/photo\.jpg/);
    expect(await onForm()).toBe(true);
    // Only that question: the next one's caption finds no file.
    expect(await page.evaluate(`(${shows})('Upload your Aadhaar card copy', 'photo.jpg')`)).toBe(false);

    // The user removes it with its ✕: the form says so at once.
    await page.click('.chip button');
    expect(await onForm()).toBe(false);
  });

  test('a window hidden and shown again for the next question reads as closed, then open', async ({ page }) => {
    await withHarness(page, GOOGLE_STYLE);
    const { probe, place, shows } = await page.evaluate(() => window.__documents.windowFunctions());

    const frame = await openWindow(page, '#add-photo');
    expect(await frame.evaluate(`(${probe})()`)).toMatchObject({ shown: true });
    await frame.evaluate(`(${place})(${JSON.stringify(BYTES)}, 'image/jpeg', 'photo.jpg', 'box')`);
    await expect(page.locator('.chip')).toHaveCount(1);

    // Hidden with `visibility`, full size from inside: it must still read as closed.
    expect(await frame.evaluate(`(${probe})()`)).toMatchObject({ shown: false });

    await page.click('#add-aadhaar');
    expect(await frame.evaluate(`(${probe})()`)).toMatchObject({ shown: true });
    await frame.evaluate(`(${place})(${JSON.stringify(BYTES)}, 'application/pdf', 'aadhaar_card.pdf', 'box')`);
    await expect(page.locator('.chip')).toHaveCount(2);
    expect(await page.evaluate(`(${shows})('Upload your Aadhaar card copy', 'aadhaar_card.pdf')`)).toBe(true);
  });

  const KEYS = {
    'Upload your recent passport size photo': 'doc.photo',
    'Upload your Aadhaar card copy': 'doc.aadhaar_card',
    'Upload your PAN card copy': 'doc.pan_card',
    'Upload your 10th marks card': 'doc.marksheet_10',
  };

  test('ONE hold uploads every document, one after another', async ({ page }) => {
    // The real batch, on a page that hides and reuses its one window, empties
    // its file box as it takes a file, and shifts its layout after the first
    // upload — everything that made one hold manage one document.
    test.setTimeout(120_000);
    await withHarness(page, GOOGLE_STYLE);

    const items = await page.evaluate((keys) => window.__documents.uploadAll(keys), KEYS);

    expect(
      items.map((item) => [item.label, item.uploaded]),
      JSON.stringify(items.map((item) => item.trace), null, 1),
    ).toEqual([
      ['Upload your recent passport size photo', true],
      ['Upload your Aadhaar card copy', true],
      ['Upload your PAN card copy', true],
      ['Upload your 10th marks card', true],
    ]);

    // Each file under its own question, and only there.
    const chipUnder = (id: string) => page.locator(`[role="listitem"]:has(#${id}) .chip span`);
    await expect(chipUnder('add-photo')).toHaveText('photo.jpg');
    await expect(chipUnder('add-aadhaar')).toHaveText('aadhaar_card.pdf');
    await expect(chipUnder('add-pan')).toHaveText('pan_card.pdf');
    await expect(chipUnder('add-marks10')).toHaveText('marksheet_10.pdf');
    await expect(page.locator('.chip')).toHaveCount(4);
  });

  test('holding again uploads nothing twice, and re-uploads only what the user removed', async ({ page }) => {
    test.setTimeout(120_000);
    await withHarness(page, GOOGLE_STYLE);
    await page.evaluate((keys) => window.__documents.uploadAll(keys), KEYS);

    // The user removes the PAN card with its ✕.
    await page.locator('[role="listitem"]:has(#add-pan) .chip button').click();
    await expect(page.locator('.chip')).toHaveCount(3);

    const again = await page.evaluate((keys) => window.__documents.uploadAll(keys), KEYS);

    expect(again.map((item) => item.why ?? 'uploaded')).toEqual([
      'Already on the form.',
      'Already on the form.',
      'uploaded',
      'Already on the form.',
    ]);
    await expect(page.locator('.chip')).toHaveCount(4);
  });

  test('the top page reports its open dialog, so the worker knows where to look', async ({ page }) => {
    await withHarness(page, GOOGLE_STYLE);
    const { probe } = await page.evaluate(() => window.__documents.windowFunctions());
    await openWindow(page, '#add-aadhaar');

    const top = await page.evaluate(`(${probe})()`);
    expect(top).toMatchObject({ top: true, dialog: true, fileBoxes: 0 });
  });
});

/*
 * The test portal's own document page, captured as it renders
 * (`scripts/capture-page.mjs`), filled the way Fill fills it.
 *
 * The portal had refused "an income certificate" in its photo box. The matcher
 * reads that box as the photo, so this asks the next question: through the
 * real filler, does every box end up holding its own document and nothing
 * else?
 */
test.describe('the test portal, filled as Fill fills it', () => {
  const TEST_PORTAL = '/test-portal/documents.html';

  test('puts each document in its own box, and nothing in a box nobody could name', async ({ page }) => {
    await withHarness(page, TEST_PORTAL);

    const boxes = await page.evaluate(() => window.__documents.fillLikeFill());
    const holding = Object.fromEntries(boxes.map((box) => [box.label, box.filename]));

    expect(holding).toMatchObject({
      'Upload Recent Photograph': 'photo.jpg',
      'Upload Candidate Signature': 'signature.jpg',
      'Upload Class X Academic Record': 'marksheet_10.pdf',
      'Upload ST Category Certificate': 'caste_certificate.pdf',
      'Upload Candidate Resume': 'resume.pdf',
      'Upload supplementary evidence': null,
    });
    // And no box holds a file named for a different document than its own.
    expect(boxes.filter((box) => box.filename?.includes('income'))).toEqual([]);
  });
});

test.describe('an upload window in the page itself', () => {
  const TEST_PORTAL = '/test-portal/documents.html';

  test('never reaches the page’s own file boxes when no window is open', async ({ page }) => {
    // The route by which an income certificate reached a photo box: a
    // document meant for "the window" put into the first box on the page that
    // would take a JPEG — which was the photograph's.
    await withHarness(page, TEST_PORTAL);
    const { place } = await page.evaluate(() => window.__documents.windowFunctions());

    const result = await page.evaluate(
      `(${place})(btoa('stand-in'), 'image/jpeg', 'income_certificate.jpg', 'box')`,
    );

    expect(result).toMatchObject({ placed: false });
    const photo = await page.evaluate(
      () =>
        (document.querySelector('input[aria-label="Upload Recent Photograph"]') as HTMLInputElement)
          .files?.length ?? 0,
    );
    expect(photo).toBe(0);
  });

  test('puts the file in the open dialog’s box, and in no other', async ({ page }) => {
    await withHarness(page, TEST_PORTAL);
    await page.evaluate(() => {
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.style.cssText = 'position:fixed;inset:20% 20%;background:#fff;padding:1rem';
      dialog.innerHTML = '<p>Upload category certificate</p><input type="file" id="in-dialog" accept=".pdf" />';
      document.body.append(dialog);
    });
    const { place } = await page.evaluate(() => window.__documents.windowFunctions());

    const result = await page.evaluate(
      `(${place})(btoa('stand-in'), 'application/pdf', 'caste_certificate.pdf', 'box')`,
    );

    expect(result).toMatchObject({ placed: true, route: 'file-box' });
    const where = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input[type="file"]'))
        .filter((box) => ((box as HTMLInputElement).files?.length ?? 0) > 0)
        .map((box) => box.id || box.getAttribute('aria-label')),
    );
    expect(where).toEqual(['in-dialog']);
  });
});
