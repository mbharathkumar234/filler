import { describe, expect, it } from 'vitest';

import { createOcrHost, type PageReading, type Reader, type RenderedPage } from './ocr-host';
import type { OcrItem } from '@/shared/messages';

/**
 * The worker's side of a reading (§ reading a document).
 *
 * Two things live here and both have gone wrong before. First, who opens and
 * closes the one offscreen reader: two reads at once used to kill each other,
 * the first to finish shutting the page under the second — the user saw "A
 * listener indicated an asynchronous response by returning true, but the
 * message channel closed before a response was received". Second, what the
 * worker makes of the boxes it gets back: lines the field rules can read, with
 * the English model's guesses at another alphabet left out.
 *
 * The real host runs against a reader that records what happened to it, so
 * the timeline is the evidence.
 */

type Event = string;

const item = (text: string, x0: number, y0: number, x1: number, y1: number, score = 0.98): OcrItem => ({
  text,
  score,
  box: { x0, y0, x1, y1 },
});

const CLEAN: OcrItem[] = [
  item('CENTRAL BOARD OF SECONDARY EDUCATION', 330, 330, 1110, 365),
  item('Roll No.', 110, 652, 200, 674),
  item('18315726', 265, 650, 380, 672),
];

/** A reader that takes `ms` per page and writes down everything done to it. */
function recordingReader(answer: () => PageReading, ms = 20) {
  const events: Event[] = [];
  let open = false;
  let reading = 0;

  const reader: Reader = {
    async open() {
      events.push('open');
      open = true;
    },
    async close() {
      // The failure mode itself: the page closed under somebody still reading.
      if (reading > 0) events.push('CLOSED-MID-READ');
      events.push('close');
      open = false;
    },
    async recognise() {
      if (!open) events.push('READ-WITH-NO-PAGE');
      reading += 1;
      if (reading > 1) events.push('OVERLAP');
      events.push('start');
      await new Promise((resolve) => setTimeout(resolve, ms));
      events.push('end');
      reading -= 1;
      return answer();
    },
    keepAlive: () => () => {},
  };

  return { reader, events };
}

const page = async (): Promise<RenderedPage> => ({
  image: new Uint8Array([1, 2, 3]),
  mime: 'image/png',
  notes: [],
});

const reading = (items: OcrItem[]): PageReading => ({ items, width: 1500, height: 2000 });

describe('two reads at once', () => {
  it('never closes the reader under a read that is still going', async () => {
    const { reader, events } = recordingReader(() => reading(CLEAN));
    const host = createOcrHost(reader, page);

    // The StrictMode double press, exactly.
    await Promise.all([
      host.recognise(new Uint8Array(), 'image/png', ['Latin']),
      host.recognise(new Uint8Array(), 'image/png', ['Latin']),
    ]);

    expect(events).not.toContain('CLOSED-MID-READ');
    expect(events).not.toContain('READ-WITH-NO-PAGE');
  });

  it('reads one page at a time, since the engine can only do one anyway', async () => {
    const { reader, events } = recordingReader(() => reading(CLEAN));
    const host = createOcrHost(reader, page);

    await Promise.all([
      host.recognise(new Uint8Array(), 'image/png', ['Latin']),
      host.recognise(new Uint8Array(), 'image/png', ['Latin']),
      host.recognise(new Uint8Array(), 'image/png', ['Latin']),
    ]);

    expect(events).not.toContain('OVERLAP');
  });

  it('closes the reader once, when the last read is done', async () => {
    const { reader, events } = recordingReader(() => reading(CLEAN));
    const host = createOcrHost(reader, page);

    await Promise.all([
      host.recognise(new Uint8Array(), 'image/png', ['Latin']),
      host.recognise(new Uint8Array(), 'image/png', ['Latin']),
    ]);

    expect(events.filter((event) => event === 'close')).toHaveLength(1);
    expect(events.at(-1)).toBe('close');
  });

  it('does not let a failed read stop the next one, and still closes the reader', async () => {
    let calls = 0;
    const { reader, events } = recordingReader(() => {
      calls += 1;
      if (calls === 1) throw new Error('the engine fell over');
      return reading(CLEAN);
    });
    const host = createOcrHost(reader, page);

    const [failed, succeeded] = await Promise.allSettled([
      host.recognise(new Uint8Array(), 'image/png', ['Latin']),
      host.recognise(new Uint8Array(), 'image/png', ['Latin']),
    ]);

    expect(failed.status).toBe('rejected');
    expect(succeeded.status).toBe('fulfilled');
    expect(events.at(-1)).toBe('close');
  });
});

describe('what the worker makes of the boxes', () => {
  it('hands the field rules lines, with each label beside its value', async () => {
    const { reader } = recordingReader(() => reading(CLEAN), 1);
    const result = await createOcrHost(reader, page).recognise(new Uint8Array(), 'image/png', ['Latin']);
    expect(result.text).toContain('Roll No. : 18315726');
    expect(result.text).toContain('CENTRAL BOARD OF SECONDARY EDUCATION');
  });

  it('leaves out what the English model could only guess at in another alphabet', async () => {
    const { reader } = recordingReader(
      () => reading([...CLEAN, item('socoted rou', 110, 700, 200, 715, 0.42)]),
      1,
    );
    const result = await createOcrHost(reader, page).recognise(new Uint8Array(), 'image/png', ['Latin']);
    expect(result.text).not.toContain('socoted');
  });

  it('reports its confidence from what it kept, not from the guesses it dropped', async () => {
    const { reader } = recordingReader(
      () => reading([item('Roll No.', 110, 652, 200, 674, 0.9), item('socoted rou', 110, 700, 200, 715, 0.3)]),
      1,
    );
    const result = await createOcrHost(reader, page).recognise(new Uint8Array(), 'image/png', ['Latin']);
    expect(result.confidence).toBeCloseTo(0.9, 5);
  });

  it('passes on what it learned about the picture', async () => {
    const { reader } = recordingReader(() => reading(CLEAN), 1);
    const small = async (): Promise<RenderedPage> => ({ ...(await page()), notes: ['This scan is 600 × 800 pixels.'] });
    const result = await createOcrHost(reader, small).recognise(new Uint8Array(), 'image/png', ['Latin']);
    expect(result.notes).toEqual(['This scan is 600 × 800 pixels.']);
  });

  it('does not pretend to read a script it has no model for', async () => {
    const { reader, events } = recordingReader(() => reading(CLEAN), 1);
    const result = await createOcrHost(reader, page).recognise(new Uint8Array(), 'image/png', ['Tamil']);
    expect(result.text).toBe('');
    expect(events).toEqual([]);
  });
});

describe('where each line sat', () => {
  it('hands back every line’s place as a share of the page', async () => {
    const { reader } = recordingReader(() => reading(CLEAN), 1);
    const result = await createOcrHost(reader, page).recognise(new Uint8Array(), 'image/png', ['Latin']);

    // Line for line with the text, or the wrong piece of the card gets shown.
    expect(result.lines?.map((line) => line.text).join('\n')).toBe(result.text);

    // "Roll No." at x 110–380 of a 1500-wide page, y 650–674 of 2000.
    const roll = result.lines?.find((line) => line.text === 'Roll No. : 18315726');
    expect(roll?.box.x0).toBeCloseTo(110 / 1500, 3);
    expect(roll?.box.x1).toBeCloseTo(380 / 1500, 3);
    expect(roll?.box.y0).toBeCloseTo(650 / 2000, 3);
  });
});

describe('a page that was photographed sideways', () => {
  /*
   * The reader stands it upright before reading, and its boxes are places on
   * the upright page. The worker has to pass on how far it was turned — the
   * piece of the card shown beside a value is cut from the document as stored,
   * which is still sideways — and it has to tell the user, who would otherwise
   * wonder why the picture on the screen is not the way they took it.
   */
  it('passes on how far the page was turned', async () => {
    const { reader } = recordingReader(() => ({ ...reading(CLEAN), turns: 3 }));
    const result = await createOcrHost(reader, page).recognise(new Uint8Array(), 'image/png', ['Latin']);
    expect(result.turns).toBe(3);
  });

  it('says so', async () => {
    const { reader } = recordingReader(() => ({ ...reading(CLEAN), turns: 1 }));
    const result = await createOcrHost(reader, page).recognise(new Uint8Array(), 'image/png', ['Latin']);
    expect(result.notes?.join(' ')).toMatch(/turned upright/i);
  });

  it('says nothing about a page that was upright all along', async () => {
    for (const upright of [reading(CLEAN), { ...reading(CLEAN), turns: 0 as const }]) {
      const { reader } = recordingReader(() => upright);
      const result = await createOcrHost(reader, page).recognise(new Uint8Array(), 'image/png', ['Latin']);
      expect(result.turns).toBeUndefined();
      expect(result.notes?.join(' ') ?? '').not.toMatch(/turned/i);
    }
  });
});
