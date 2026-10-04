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
      pdfText: async () => ({ text: `Government of India\nRavi Kumar\nDOB: 14/03/1998\n${AADHAAR}` }),
      ocr,
    });

    expect(result.source).toBe('pdf-text-layer');
    expect(spy).not.toHaveBeenCalled();
  });

  it('marks a text-layer read as exact, for the screen to say so once', async () => {
    const result = await readDocumentText(new Uint8Array([1]), { mime: 'application/pdf' }, {
      pdfText: async () => ({ text: `Government of India\nRavi Kumar\nDOB: 14/03/1998\n${AADHAAR}` }),
    });
    expect(result.source).toBe('pdf-text-layer');
    expect(result.notes.join(' ')).not.toMatch(/exact/i);
  });

  it('falls through to OCR when a PDF is a scan with no real text', async () => {
    const result = await readDocumentText(new Uint8Array([1]), { mime: 'application/pdf' }, {
      pdfText: async () => ({ text: 'Page 1' }), // scanner furniture, not content
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
      pdfText: async () => ({ text: 'never called for an image' }),
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
      pdfText: async () => ({ text: `Ravi Kumar\nDOB: 14/03/1998\n${AADHAAR}\nGovernment of India` }),
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

describe('a table in a PDF’s own text', () => {
  it('reaches the rules that read it, as a table recognised from a photo does', async () => {
    const tables = [
      {
        rows: [
          ['Course Code', 'Course Title', 'Total', 'Grade'],
          ['21CS32', 'Data Structures and Applications', '105', 'A+'],
          ['21CS33', 'Analog and Digital Electronics', '91', 'F'],
          ['21CS35', 'Object Oriented Programming with Java', '101', 'A+'],
        ],
      },
    ];
    const text = 'SAMPLE TECHNOLOGICAL UNIVERSITY\nPROVISIONAL GRADE CARD\nSGPA 6.10';
    const result = await readAndExtract(new Uint8Array([1]), { mime: 'application/pdf' }, {
      pdfText: async () => ({ text, tables }),
      hint: { documentKey: 'doc.semester_marksheet' },
    });
    expect(result.read.source).toBe('pdf-text-layer');
    expect(result.read.tables).toEqual(tables);
    const value = (key: string) => result.candidates.find((c) => c.key === key)?.value;
    expect(value('education.undergraduate.backlogs')).toBe('1');
    expect(value('education.undergraduate.marks_obtained')).toBe('297');
  });
});

describe('a table the reader found', () => {
  const GRADES = {
    rows: [
      ['Course Code', 'Course Title', 'Total', 'Grade'],
      ['21CS32', 'Data Structures and Applications', '105', 'A+'],
      ['21CS33', 'Analog and Digital Electronics', '91', 'F'],
      ['21CS35', 'Object Oriented Programming with Java', '101', 'A+'],
    ],
  };

  it('reaches the rules that read it, which learn from it what the lines alone cannot say', async () => {
    const result = await readAndExtract(new Uint8Array([1]), { mime: 'image/png' }, {
      ocr: engine('SAMPLE TECHNOLOGICAL UNIVERSITY\nSGPA 6.10', {
        recognise: async () => ({ text: 'SAMPLE TECHNOLOGICAL UNIVERSITY\nSGPA 6.10', tables: [GRADES] }),
      }),
      hint: { documentKey: 'doc.semester_marksheet' },
    });
    expect(result.read.tables).toEqual([GRADES]);
    const value = (key: string) => result.candidates.find((c) => c.key === key)?.value;
    expect(value('education.undergraduate.backlogs')).toBe('1');
    expect(value('education.undergraduate.marks_obtained')).toBe('297');
  });

  it('is not kept for a page that read as nothing', async () => {
    const result = await readDocumentText(new Uint8Array([1]), { mime: 'image/png' }, {
      ocr: engine('', { recognise: async () => ({ text: '', tables: [GRADES] }) }),
    });
    expect(result.tables).toBeUndefined();
  });
});

describe('the guess is discounted, and the certainty is not', () => {
  const CARD = `Government of India\nRavi Kumar\nDOB: 14/03/1998\n${AADHAAR}`;

  it('scores a value read from a text layer at full confidence', async () => {
    const result = await readAndExtract(new Uint8Array([1]), { mime: 'application/pdf' }, {
      pdfText: async () => ({ text: CARD }),
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
      pdfText: async () => ({ text: CARD }),
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

describe('the codes it read, checked against RBI’s and India Post’s lists', () => {
  /* A real public branch code: an IFSC is a branch's address, not anyone's detail. */
  const PASSBOOK = 'STATE BANK OF INDIA\nBranch : KOLKATA MAIN\nIFSC : SBIN0000001\nAccount Number : 30123456789';
  const KOLKATA_MAIN = {
    ifsc: 'SBIN0000001',
    bank: 'State Bank of India',
    branch: 'KOLKATA MAIN',
    address: 'SAMRIDDHI BHAWAN, 1 STRAND ROAD, KOLKATA 700 001',
    city: 'Kolkata',
    district: 'Kolkata',
    state: 'West Bengal',
    micr: '700002021',
  };
  const lists = () => ({
    ifsc: vi.fn(async (code: string) => (code === 'SBIN0000001' ? KOLKATA_MAIN : null)),
    pincode: vi.fn(async () => null),
  });

  it('offers what the list knows and the page did not print, and says the code agrees with the page', async () => {
    const result = await readAndExtract(new Uint8Array([1]), { mime: 'application/pdf' }, {
      pdfText: async () => ({ text: PASSBOOK }),
      reference: lists(),
    });
    const pick = (key: string) => result.candidates.find((c) => c.key === key);
    expect(pick('bank.micr')?.value).toBe('700002021');
    expect(pick('bank.branch_address')?.evidence).toBe('RBI’s list of IFSC codes: SBIN0000001');
    expect(pick('bank.ifsc')?.agreement).toMatch(/State Bank of India’s KOLKATA MAIN branch/);
    expect(pick('bank.ifsc')?.suggestChecked).toBe(false);
    expect(pick('bank.branch')?.value).toBe('KOLKATA MAIN');
  });

  it('still discounts a code read off a photo that the list agrees with: only a checksum keeps its standing', async () => {
    const fromPdf = await readAndExtract(new Uint8Array([1]), { mime: 'application/pdf' }, {
      pdfText: async () => ({ text: PASSBOOK }),
      reference: lists(),
    });
    const fromImage = await readAndExtract(new Uint8Array([1]), { mime: 'image/jpeg' }, {
      ocr: engine(PASSBOOK),
      reference: lists(),
    });
    const pick = (r: typeof fromPdf) => r.candidates.find((c) => c.key === 'bank.ifsc')!;
    expect(pick(fromImage).agreement).toBeDefined();
    expect(pick(fromImage).confidence).toBeLessThan(pick(fromPdf).confidence);
  });

  it('warns of a code read off a photo that the list does not have', async () => {
    const result = await readAndExtract(new Uint8Array([1]), { mime: 'image/jpeg' }, {
      ocr: engine(PASSBOOK.replace('SBIN0000001', 'SBIN0000007')),
      reference: lists(),
    });
    expect(result.warnings.some((w) => w.startsWith('SBIN0000007 is not in RBI’s list of IFSC codes.'))).toBe(true);
    expect(result.candidates.find((c) => c.key === 'bank.micr')).toBeUndefined();
  });

  it('reads as it always did without the lists', async () => {
    const result = await readAndExtract(new Uint8Array([1]), { mime: 'application/pdf' }, {
      pdfText: async () => ({ text: PASSBOOK }),
    });
    expect(result.candidates.find((c) => c.key === 'bank.micr')).toBeUndefined();
    expect(result.candidates.find((c) => c.key === 'bank.ifsc')?.agreement).toBeUndefined();
  });

  describe('a passbook whose IFSC was read a character short', () => {
    /* The user's own passbook's layout and the reader's slips, with made-up values. */
    const SHORT = [
      'Sample Bank Ltd.',
      'SAMPLEPURT-NIHRUNAGAR',
      'Branch Name & Address',
      'SAVINGS BANK A/C No.: 1234500100067890 Business Hours, Weekly Holidays, Telephone Nos.',
      'NAME AND ADORESS OF THE ACCOUNT HOLDER/S:',
      '1.MEHTA R ARJUN KUMAR',
      'S/0 R RAMAPPA,',
      'SAMPLEPURA',
      '572101 INDIA',
      'Customer-id: 1)123456789',
      'SC COd: ZZZZ000123 MICR CODE:572052123 P.BRANCH MANAGER',
    ].join('\n');
    const NEHRU_NAGAR = {
      ifsc: 'ZZZZ0000123',
      bank: 'Sample Bank',
      branch: 'NEHRU NAGAR',
      address: '1 MG ROAD, NEHRU NAGAR, SAMPLEPURA-572101',
      city: 'Samplepura',
      district: 'Samplepura',
      state: 'Karnataka',
      micr: '572052103',
    };
    const PLACE = { pin: '572101', states: ['Karnataka'], districts: ['Samplepura'], offices: ['Samplepura S.O'] };
    const listsFor = () => ({
      ifsc: vi.fn(async () => null),
      ifscNear: vi.fn(async (code: string) => (code === 'ZZZZ000123' ? [NEHRU_NAGAR] : [])),
      pincode: vi.fn(async (pin: string) => (pin === '572101' ? PLACE : null)),
    });

    it('offers everything the passbook says, the IFSC put right and saying so', async () => {
      const result = await readAndExtract(new Uint8Array([1]), { mime: 'image/jpeg' }, {
        ocr: engine(SHORT),
        hint: { documentKey: 'doc.bank_passbook' },
        reference: listsFor(),
      });
      const pick = (key: string) => result.candidates.find((c) => c.key === key);
      expect(pick('bank.account_number')?.value).toBe('1234500100067890');
      expect(pick('bank.account_holder')?.value).toBe('MEHTA R ARJUN KUMAR');
      expect(pick('family.father_name')?.value).toBe('R RAMAPPA');
      expect(pick('bank.micr')?.value).toBe('572052123');
      expect(pick('address.permanent.pincode')?.value).toBe('572101');
      expect(pick('address.permanent.state')?.listed).toEqual({ list: 'pincode', code: '572101' });
      expect(pick('bank.ifsc')).toMatchObject({ value: 'ZZZZ0000123', suggestChecked: false });
      expect(pick('bank.ifsc')?.correction).toMatch(/^Read as ZZZZ000123, a character short\./);
      expect(pick('bank.ifsc')?.agreement).toMatch(/the branch printed on this document \(“SAMPLEPURT-NIHRUNAGAR”\)/);
      expect(pick('bank.branch')?.value).toBe('NEHRU NAGAR');
      expect(result.candidates.filter((c) => c.suggestChecked)).toEqual([]);
    });

    it('says the code was read a character short when it has no lists to put it right with', async () => {
      const result = await readAndExtract(new Uint8Array([1]), { mime: 'image/jpeg' }, {
        ocr: engine(SHORT),
        hint: { documentKey: 'doc.bank_passbook' },
      });
      expect(result.candidates.find((c) => c.key === 'bank.ifsc')).toBeUndefined();
      expect(result.warnings).toContain('The IFSC was read as ZZZZ000123, a character short. Check it against the passbook or a cheque, and type it in.');
    });
  });

  it('asks nothing of the lists for a document with no code on it', async () => {
    const reference = lists();
    await readAndExtract(new Uint8Array([1]), { mime: 'image/jpeg' }, {
      ocr: engine(`Government of India\nRavi Kumar\nDOB: 14/03/1998\n${AADHAAR}`),
      reference,
    });
    expect(reference.ifsc).not.toHaveBeenCalled();
    expect(reference.pincode).not.toHaveBeenCalled();
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

  it('passes on each line’s page, and how far that page was turned to be read', async () => {
    // A scanned PDF is read page by page, and each page may have been turned
    // upright on its own. The boxes are places on the upright page, so the
    // piece cut from the stored document needs both.
    const pages = [
      { text: 'Name : PRIYA S', box },
      { text: 'PHYSICS 100 81 81', box, page: 2, turns: 3 as const },
    ];
    const read = await readDocumentText(new Uint8Array(), { mime: 'application/pdf' }, {
      ocr: engine('', {
        recognise: async () => ({ text: pages.map((l) => l.text).join('\n'), lines: pages }),
      }),
    });
    expect(read.lines?.[0]).toEqual({ text: 'Name : PRIYA S', box });
    expect(read.lines?.[1]).toMatchObject({ page: 2, turns: 3 });
  });

  it('forgets the pages and the turns along with the boxes they belong to', async () => {
    const turned = two.map((line) => ({ ...line, page: 2, turns: 3 as const }));
    const read = await readDocumentText(new Uint8Array(), { mime: 'image/jpeg' }, {
      ocr: engine('', {
        recognise: async () => ({ text: 'Roll No. : 18315726', lines: turned }),
      }),
    });
    expect(read.lines).toBeUndefined();
    expect(JSON.stringify(read)).not.toMatch(/turns|"page"/);
  });

  it('has no boxes for text taken from a PDF’s own text layer', async () => {
    const read = await readDocumentText(new Uint8Array(), { mime: 'application/pdf' }, {
      pdfText: async () => ({ text: 'Permanent Account Number ABCPE1234F and enough text to be a text layer' }),
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
          return { text: TEXT };
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
        pdfText: async () => ({ text: 'Page 1' }),
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
        return { text: TEXT };
      },
    });
    expect(given).toEqual([undefined]);
  });
});
