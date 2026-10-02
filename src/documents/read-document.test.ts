import { describe, expect, it, vi } from 'vitest';

import { readAndExtract, readDocumentText, type OcrEngine } from './read-document';
import type { IndicScript } from './indic';

/**
 * Choosing how to read a document (§ document extraction).
 *
 * The decision this module makes is small and easy to get backwards: a PDF's
 * embedded text layer is *exact*, and OCR is a *guess*. Running OCR over a
 * document that already contains real characters throws away certainty and
 * replaces it with a confident-looking approximation — which, for a twelve
 * digit ID number, is the worst possible trade.
 *
 * So most of these tests are about preferring the exact source, and about the
 * difference surviving all the way to the value the user is shown.
 */

const AADHAAR = '999999990019';

function engine(text: string, over: Partial<OcrEngine> = {}): OcrEngine {
  return {
    availableScripts: async () => ['Latin', 'Devanagari'] as IndicScript[],
    recognise: async () => ({ text, confidence: 0.9 }),
    ...over,
  };
}

describe('exact beats guessed, every time', () => {
  it('reads a PDF text layer and does not touch OCR', async () => {
    const ocr = engine('this should never run');
    const spy = vi.spyOn(ocr, 'recognise');

    const result = await readDocumentText(new Uint8Array([1]), { mime: 'application/pdf' }, {
      pdfText: async () => `Government of India\nRavi Kumar\nDOB: 14/03/1998\n${AADHAAR}`,
      ocr,
    });

    expect(result.source).toBe('pdf-text-layer');
    expect(spy).not.toHaveBeenCalled();
  });

  it('marks a text-layer read as exact, for the screen to say so once', async () => {
    const result = await readDocumentText(new Uint8Array([1]), { mime: 'application/pdf' }, {
      pdfText: async () => `Government of India\nRavi Kumar\nDOB: 14/03/1998\n${AADHAAR}`,
    });
    expect(result.source).toBe('pdf-text-layer');
    expect(result.notes.join(' ')).not.toMatch(/exact/i);
  });

  it('falls through to OCR when a PDF is a scan with no real text', async () => {
    const result = await readDocumentText(new Uint8Array([1]), { mime: 'application/pdf' }, {
      pdfText: async () => 'Page 1', // scanner furniture, not content
      ocr: engine(`Ravi Kumar\n${AADHAAR}`),
    });

    expect(result.source).toBe('ocr');
    expect(result.notes.join(' ')).toMatch(/scan|image/i);
  });

  it('falls through when the text layer cannot be read at all', async () => {
    const result = await readDocumentText(new Uint8Array([1]), { mime: 'application/pdf' }, {
      pdfText: async () => {
        throw new Error('encrypted');
      },
      ocr: engine(`Ravi Kumar\n${AADHAAR}`),
    });
    expect(result.source).toBe('ocr');
  });

  it('goes straight to OCR for an image', async () => {
    const result = await readDocumentText(new Uint8Array([1]), { mime: 'image/jpeg' }, {
      pdfText: async () => 'never called for an image',
      ocr: engine(`Ravi Kumar\n${AADHAAR}`),
    });
    expect(result.source).toBe('ocr');
  });

  it('says it guessed through its source, and leaves the words to the screen', async () => {
    // The screen captions every reading from `source` ("Recognised from an
    // image. Please compare each value…"). A note saying the same thing put
    // the same warning on the screen twice, one line under the other.
    const result = await readDocumentText(new Uint8Array([1]), { mime: 'image/jpeg' }, {
      ocr: engine(`Ravi Kumar\n${AADHAAR}`),
    });
    expect(result.source).toBe('ocr');
    expect(result.notes.join(' ')).not.toMatch(/check each value|recognised from/i);
  });
});

describe('when there is no engine', () => {
  it('still reads a PDF text layer', async () => {
    const result = await readDocumentText(new Uint8Array([1]), { mime: 'application/pdf' }, {
      pdfText: async () => `Ravi Kumar\nDOB: 14/03/1998\n${AADHAAR}\nGovernment of India`,
    });
    expect(result.source).toBe('pdf-text-layer');
  });

  it('explains itself for an image rather than failing', async () => {
    // A build without an OCR engine is a real, supported configuration — the
    // engine is a large dependency. It must degrade to a sentence, not an error.
    const result = await readDocumentText(new Uint8Array([1]), { mime: 'image/jpeg' }, {});
    expect(result.source).toBe('none');
    expect(result.text).toBe('');
    expect(result.notes.join(' ')).toMatch(/not available|downloaded from the issuing website/i);
  });
});

describe('language packs it does not have', () => {
  it('says which is missing rather than returning empty', async () => {
    const tamilOnlyDocument = await readDocumentText(new Uint8Array([1]), { mime: 'image/jpeg' }, {
      scripts: ['Tamil'],
      ocr: engine('', { availableScripts: async () => ['Latin'] as IndicScript[] }),
    });

    expect(tamilOnlyDocument.source).toBe('none');
    expect(tamilOnlyDocument.notes.join(' ')).toMatch(/language pack/i);
  });

  it('uses only the scripts the engine actually has', async () => {
    const asked: IndicScript[][] = [];
    await readDocumentText(new Uint8Array([1]), { mime: 'image/jpeg' }, {
      scripts: ['Latin', 'Devanagari', 'Tamil'],
      ocr: engine('text', {
        availableScripts: async () => ['Latin', 'Devanagari'] as IndicScript[],
        recognise: async (_b, _m, scripts) => {
          asked.push(scripts);
          return { text: 'text' };
        },
      }),
    });

    expect(asked[0]).toEqual(['Latin', 'Devanagari']);
  });

  it('says nothing could be read when the image is unreadable', async () => {
    const result = await readDocumentText(new Uint8Array([1]), { mime: 'image/jpeg' }, {
      ocr: engine('   '),
    });
    expect(result.source).toBe('none');
    expect(result.notes.join(' ')).toMatch(/sharper|better light/i);
  });
});

describe('the guess is discounted, and the certainty is not', () => {
  const CARD = `Government of India\nRavi Kumar\nDOB: 14/03/1998\n${AADHAAR}`;

  it('scores a value read from a text layer at full confidence', async () => {
    const result = await readAndExtract(new Uint8Array([1]), { mime: 'application/pdf' }, {
      pdfText: async () => CARD,
    });
    const name = result.candidates.find((c) => c.key === 'identity.full_name')!;
    expect(name.confidence).toBeCloseTo(0.65, 5);
  });

  it('discounts the same value when it was recognised from pixels', async () => {
    const result = await readAndExtract(new Uint8Array([1]), { mime: 'image/jpeg' }, {
      ocr: engine(CARD),
    });
    const name = result.candidates.find((c) => c.key === 'identity.full_name')!;
    expect(name.confidence).toBeLessThan(0.65);
  });

  it('does not discount a checksum-verified value, whatever read it', async () => {
    // A Verhoeff check is a Verhoeff check. If the digits pass it, how they
    // were obtained stops mattering — and pretending otherwise would push the
    // one value we can actually prove below the ones we cannot.
    const fromPdf = await readAndExtract(new Uint8Array([1]), { mime: 'application/pdf' }, {
      pdfText: async () => CARD,
    });
    const fromImage = await readAndExtract(new Uint8Array([1]), { mime: 'image/jpeg' }, {
      ocr: engine(CARD),
    });

    const pick = (r: typeof fromPdf) => r.candidates.find((c) => c.key === 'id.aadhaar')!;
    expect(pick(fromImage).confidence).toBe(pick(fromPdf).confidence);
    expect(pick(fromImage).verified).toBe(true);
  });

  it('still pre-ticks only the verified value after discounting', async () => {
    const result = await readAndExtract(new Uint8Array([1]), { mime: 'image/jpeg' }, {
      ocr: engine(CARD),
    });
    expect(result.candidates.filter((c) => c.suggestChecked).map((c) => c.key)).toEqual(['id.aadhaar']);
  });

  it('carries the read details through, so the screen can say where text came from', async () => {
    const result = await readAndExtract(new Uint8Array([1]), { mime: 'image/jpeg' }, {
      ocr: engine(CARD),
    });
    expect(result.read.source).toBe('ocr');
    expect(result.read.engineConfidence).toBe(0.9);
  });
});

describe('where on the page the text was', () => {
  /*
   * The suggestion screen shows the piece of the card each value was read
   * from. That is only honest if a line's box really is that line's — so the
   * boxes are passed on only when they are provably in step with the text.
   */
  const box = { x0: 0.1, y0: 0.2, x1: 0.6, y1: 0.22 };
  const two = [
    { text: 'Roll No. : 18315726', box },
    { text: 'Name : RAVI KUMAR', box },
  ];

  it('passes on each line’s place when the engine knows it', async () => {
    const read = await readDocumentText(new Uint8Array(), { mime: 'image/jpeg' }, {
      ocr: engine('', {
        recognise: async () => ({ text: two.map((l) => l.text).join('\n'), lines: two }),
      }),
    });
    expect(read.lines).toHaveLength(2);
    expect(read.lines?.[0]?.box).toEqual(box);
  });

  it('shows no piece of the card rather than the wrong one, if boxes and text disagree', async () => {
    const read = await readDocumentText(new Uint8Array(), { mime: 'image/jpeg' }, {
      ocr: engine('', {
        recognise: async () => ({ text: 'Roll No. : 18315726', lines: two }),
      }),
    });
    expect(read.lines).toBeUndefined();
  });

  it('passes on how far the page was turned, since the boxes are places on the upright page', async () => {
    const read = await readDocumentText(new Uint8Array(), { mime: 'image/jpeg' }, {
      ocr: engine('', {
        recognise: async () => ({ text: two.map((l) => l.text).join('\n'), lines: two, turns: 3 }),
      }),
    });
    expect(read.turns).toBe(3);
  });

  it('forgets the turn along with the boxes it belongs to', async () => {
    const read = await readDocumentText(new Uint8Array(), { mime: 'image/jpeg' }, {
      ocr: engine('', {
        recognise: async () => ({ text: 'Roll No. : 18315726', lines: two, turns: 3 }),
      }),
    });
    expect(read.lines).toBeUndefined();
    expect(read.turns).toBeUndefined();
  });

  it('has no boxes for text taken from a PDF’s own text layer', async () => {
    const read = await readDocumentText(new Uint8Array(), { mime: 'application/pdf' }, {
      pdfText: async () => 'Permanent Account Number ABCPE1234F and enough text to be a text layer',
    });
    expect(read.source).toBe('pdf-text-layer');
    expect(read.lines).toBeUndefined();
  });
});

describe('a PDF that opens with a password', () => {
  /*
   * The vault keeps a locked PDF's password with it (`pdf-lock.ts`). Reading
   * the file must use it on both paths: the exact text layer, and the pages
   * rendered for recognition when there is no text layer to read.
   */
  const TEXT = `Government of India\nRavi Kumar\nDOB: 14/03/1998\n${AADHAAR}`;

  it('opens the text layer with it', async () => {
    const given: Array<string | undefined> = [];
    const read = await readDocumentText(
      new Uint8Array([1]),
      { mime: 'application/pdf', password: 'RAVI1998' },
      {
        pdfText: async (_bytes, password) => {
          given.push(password);
          return TEXT;
        },
      },
    );
    expect(given).toEqual(['RAVI1998']);
    expect(read.source).toBe('pdf-text-layer');
  });

  it('opens the pages with it, when they have to be recognised', async () => {
    const given: Array<string | undefined> = [];
    await readDocumentText(
      new Uint8Array([1]),
      { mime: 'application/pdf', password: 'RAVI1998' },
      {
        pdfText: async () => 'Page 1',
        ocr: engine('', {
          recognise: async (_bytes, _mime, _scripts, password) => {
            given.push(password);
            return { text: TEXT };
          },
        }),
      },
    );
    expect(given).toEqual(['RAVI1998']);
  });

  it('passes no password for a document that has none', async () => {
    const given: Array<string | undefined> = [];
    await readDocumentText(new Uint8Array([1]), { mime: 'application/pdf' }, {
      pdfText: async (_bytes, password) => {
        given.push(password);
        return TEXT;
      },
    });
    expect(given).toEqual([undefined]);
  });
});
