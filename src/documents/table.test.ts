import { describe, expect, it } from 'vitest';

import { modelConfigFrom, type RgbaImage, type TableConfig } from './paddle';
import {
  decodeStructure,
  fillTable,
  tableInput,
  tableRegions,
  widenToRules,
  type PlacedText,
  type TableStructure,
} from './table';

const placed = ([text, x0, y0, x1, y1]: [string, number, number, number, number]): PlacedText => ({
  text,
  box: { x0, y0, x1, y1 },
});

/*
 * What the reader found on `fixtures/images/grade-card-ruled.png`, a made-up
 * card: each piece of text and its box, rounded to the pixel.
 */
const CARD: PlacedText[] = (
  [
    ['SAMPLE TECHNOLOGICAL UNIVERSITY', 365, 40, 910, 68],
    ['PROVISIONAL GRADE CARD — SAMPLE', 461, 73, 816, 96],
    ['Name of the Student', 45, 116, 247, 141],
    ['ARJUN MEHTA', 317, 117, 465, 141],
    ['University Seat Number', 44, 147, 278, 175],
    ['1SA21CS042', 317, 146, 444, 173],
    ['Semester', 44, 177, 143, 206],
    ['III', 314, 177, 343, 206],
    ['Course Code', 56, 229, 188, 258],
    ['Course Title', 252, 229, 376, 258],
    ['Credits', 651, 227, 732, 259],
    ['Internal', 773, 228, 857, 258],
    ['External', 900, 229, 989, 257],
    ['Total', 1035, 228, 1095, 258],
    ['Grade', 1126, 229, 1194, 258],
    ['21MAT31', 52, 267, 148, 297],
    ['Transform Calculus, Fourier Series and', 255, 270, 606, 295],
    ['3', 651, 268, 673, 297],
    ['45', 772, 268, 809, 298],
    ['52', 898, 268, 934, 298],
    ['97', 1034, 268, 1069, 299],
    ['A', 1127, 270, 1150, 297],
    ['Numerical Techniques', 253, 293, 456, 321],
    ['21CS32', 53, 331, 137, 361],
    ['Data Structures and Applications', 255, 334, 549, 359],
    ['4', 652, 333, 674, 361],
    ['47', 771, 331, 808, 363],
    ['58', 898, 330, 934, 362],
    ['105', 1035, 331, 1081, 361],
    ['A+', 1124, 331, 1163, 362],
    ['21CS33', 53, 371, 137, 401],
    ['Analog and Digital Electronics', 254, 375, 524, 400],
    ['4', 652, 373, 674, 402],
    ['42', 771, 370, 809, 404],
    ['49', 898, 371, 934, 404],
    ['91', 1033, 371, 1069, 404],
    ['A', 1125, 371, 1154, 406],
    ['SGPA', 42, 583, 110, 613],
    ['8.45', 313, 583, 365, 613],
    ['CGPA', 42, 613, 111, 644],
    ['8.21', 313, 613, 365, 645],
    ['Result', 42, 644, 117, 676],
    ['PASS', 313, 643, 379, 676],
  ] as Array<[string, number, number, number, number]>
).map(placed);

describe('finding a table among what was read', () => {
  it('finds the course table: from its header to its last row, a wrapped title inside it', () => {
    const regions = tableRegions(CARD);
    expect(regions).toHaveLength(1);
    const { box } = regions[0]!;
    // The header's top and the last course row's bottom; the label rows above
    // it ("Semester  III") and below it ("SGPA  8.45") are not table rows.
    expect(box).toEqual({ x0: 52, y0: 227, x1: 1194, y1: 406 });
    expect(regions[0]!.lineHeight).toBeGreaterThan(24);
    expect(regions[0]!.lineHeight).toBeLessThan(34);
  });

  it('finds none on a page of labels and their values', () => {
    expect(tableRegions(CARD.filter((item) => item.box.y0 < 210 || item.box.y0 > 570))).toEqual([]);
  });

  it('needs three rows across before it calls something a table', () => {
    const twoRows = CARD.filter((item) => item.box.y0 < 300 && !/Numerical/.test(item.text));
    expect(tableRegions(twoRows)).toEqual([]);
  });

  it('finds two tables with a heading between them as two', () => {
    const below = CARD.filter((item) => item.box.y0 >= 227 && item.box.y1 <= 406).map((item) => ({
      ...item,
      box: { ...item.box, y0: item.box.y0 + 400, y1: item.box.y1 + 400 },
    }));
    const heading = placed(['Supplementary Examination', 400, 560, 700, 590]);
    const page = [...CARD.filter((item) => item.box.y1 <= 406), heading, ...below];
    expect(tableRegions(page)).toHaveLength(2);
  });
});

/** White, with black lines drawn where asked. */
function paper(width: number, height: number, rules: Array<{ x0: number; y0: number; x1: number; y1: number }> = []) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const rule of rules) {
    for (let y = rule.y0; y <= rule.y1; y += 1) {
      for (let x = rule.x0; x <= rule.x1; x += 1) {
        const at = (y * width + x) * 4;
        data[at] = 0;
        data[at + 1] = 0;
        data[at + 2] = 0;
      }
    }
  }
  return { data, width, height } satisfies RgbaImage;
}

describe('the picture the table model is shown', () => {
  const region = { box: { x0: 40, y0: 50, x1: 360, y1: 150 }, lineHeight: 20 };

  it('reaches out to a ruled table’s own border, which the text stops short of', () => {
    // The border drawn 20 pixels outside the text on every side: cut at the
    // text, the model saw a table with no edge and merged its first two rows.
    const ruled = paper(400, 200, [
      { x0: 20, y0: 30, x1: 380, y1: 30 },
      { x0: 20, y0: 170, x1: 380, y1: 170 },
      { x0: 20, y0: 30, x1: 20, y1: 170 },
      { x0: 380, y0: 30, x1: 380, y1: 170 },
    ]);
    const box = widenToRules(ruled, region);
    expect(box.x0).toBeLessThanOrEqual(20);
    expect(box.x0).toBeGreaterThanOrEqual(16);
    expect(box.x1).toBeGreaterThan(380);
    expect(box.x1).toBeLessThanOrEqual(385);
    expect(box.y0).toBeLessThanOrEqual(30);
    expect(box.y1).toBeGreaterThan(170);
  });

  it('leaves a margin round an open table, which has no border to find', () => {
    expect(widenToRules(paper(400, 200), region)).toEqual({ x0: 32, y0: 42, x1: 368, y1: 158 });
  });

  it('does not run to a line too far away to be the table’s', () => {
    const far = paper(400, 200, [{ x0: 2, y0: 0, x1: 2, y1: 199 }]);
    expect(widenToRules(far, region).x0).toBe(32);
  });

  it('is brought to the model’s size by its longer side, in blue, green, red, and padded with nothing', () => {
    const config = { size: 488, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], scale: 1 / 255 };
    const red = { data: new Uint8ClampedArray(976 * 300 * 4), width: 976, height: 300 } satisfies RgbaImage;
    for (let i = 0; i < red.data.length; i += 4) {
      red.data[i] = 255;
      red.data[i + 3] = 255;
    }
    const { data, ratio } = tableInput(red, { x0: 0, y0: 0, x1: 976, y1: 300 }, config);
    expect(ratio).toBe(0.5);
    expect(data).toHaveLength(3 * 488 * 488);
    const plane = 488 * 488;
    // Blue first: PaddleOCR reads pictures as OpenCV does.
    expect(data[0]).toBeCloseTo((0 - 0.485) / 0.229, 4);
    expect(data[2 * plane]).toBeCloseTo((1 - 0.406) / 0.225, 4);
    // 300 rows become 150; below them, the padding is zero.
    expect(data[160 * 488]).toBe(0);
    expect(data[2 * plane + 160 * 488]).toBe(0);
  });
});

/** SLANet_plus's settings file, cut down to what the decoder reads. */
const SETTINGS = {
  Global: { model_name: 'SLANet_plus' },
  PreProcess: {
    transform_ops: [
      { ResizeTableImage: { max_len: 488 } },
      { NormalizeImage: { mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], scale: '1./255.', order: 'hwc' } },
      { PaddingTableImage: { size: [488, 488] } },
    ],
  },
  PostProcess: {
    name: 'TableLabelDecode',
    merge_no_span_structure: true,
    character_dict: ['<thead>', '</thead>', '<tbody>', '</tbody>', '<tr>', '</tr>', '<td>', '<td', '>', '</td>', ' colspan="2"', ' rowspan="2"'],
  },
};

describe('the table model’s settings', () => {
  it('reads its tokens as PaddleOCR does: a start, the list with "<td></td>" for "<td>", an end', () => {
    const config = modelConfigFrom(SETTINGS);
    expect(config.table?.classes).toEqual([
      'sos',
      '<thead>',
      '</thead>',
      '<tbody>',
      '</tbody>',
      '<tr>',
      '</tr>',
      '<td',
      '>',
      '</td>',
      ' colspan="2"',
      ' rowspan="2"',
      '<td></td>',
      'eos',
    ]);
    expect(config.table).toMatchObject({ size: 488, scale: 1 / 255, locCount: 8 });
    // Not an alphabet: no space is added to it, and nothing reads it as one.
    expect(config.characters).toBeUndefined();
  });
});

describe('reading the table model’s answer', () => {
  const config: TableConfig = modelConfigFrom(SETTINGS).table!;

  /** The model's two outputs for a run of tokens, each cell token with its corners. */
  function answer(tokens: Array<string | [string, number, number, number, number]>) {
    const classes = config.classes.length;
    const steps = tokens.length;
    const probs = new Float32Array(steps * classes);
    const locs = new Float32Array(steps * 8);
    tokens.forEach((token, step) => {
      const [name, x0, y0, x1, y1] = typeof token === 'string' ? [token, 0, 0, 0, 0] : token;
      probs[step * classes + config.classes.indexOf(name)] = 1;
      locs.set([x0, y0, x1, y0, x1, y1, x0, y1], step * 8);
    });
    return { probs, locs, steps };
  }

  it('builds rows of cells, with their spans, placed back on the page', () => {
    const output = answer([
      'sos',
      '<thead>',
      '<tr>',
      ['<td></td>', 0.1, 0.1, 0.2, 0.2],
      ['<td', 0.2, 0.1, 0.4, 0.2],
      ' colspan="2"',
      '>',
      '</td>',
      '</tr>',
      '</thead>',
      '<tr>',
      ['<td></td>', 0.1, 0.2, 0.2, 0.3],
      ['<td></td>', 0.2, 0.2, 0.3, 0.3],
      ['<td></td>', 0.3, 0.2, 0.4, 0.3],
      '</tr>',
      'eos',
      // Past the end: never read.
      '<tr>',
    ]);
    const structure = decodeStructure(output, config, { ratio: 0.5, offset: { x: 100, y: 10 } });

    expect(structure.rows.map((row) => row.map((cell) => cell.colspan))).toEqual([
      [1, 2],
      [1, 1, 1],
    ]);
    // 0.1 of 488, at half size, is 97.6 pixels of the crop; the crop starts at x=100.
    expect(structure.rows[0]![0]!.box.x0).toBeCloseTo(100 + 97.6, 3);
    expect(structure.rows[0]![0]!.box.y1).toBeCloseTo(10 + 195.2, 3);
  });

  it('reads nothing from an answer that ends at once', () => {
    expect(decodeStructure(answer(['eos', '<tr>']), config, { ratio: 1, offset: { x: 0, y: 0 } }).rows).toEqual([]);
  });
});

describe('putting the text into the cells', () => {
  const cell = (x0: number, y0: number, x1: number, y1: number, colspan = 1) => ({
    box: { x0, y0, x1, y1 },
    colspan,
    rowspan: 1,
  });

  it('puts each piece of text in the cell it sits in, a wrapped title whole and in reading order', () => {
    const structure: TableStructure = {
      rows: [
        [cell(0, 0, 100, 30), cell(100, 0, 300, 30), cell(300, 0, 400, 30)],
        [cell(0, 30, 100, 90), cell(100, 30, 300, 90), cell(300, 30, 400, 90)],
      ],
    };
    const items = [
      placed(['Code', 10, 5, 60, 25]),
      placed(['Title', 110, 5, 160, 25]),
      placed(['Total', 310, 5, 360, 25]),
      // The second line of the title first: reading order is the page's, not the reader's.
      placed(['Numerical Techniques', 110, 60, 280, 85]),
      placed(['Transform Calculus,', 110, 35, 280, 58]),
      placed(['21MAT31', 10, 35, 80, 58]),
      placed(['97', 310, 35, 340, 58]),
      // Outside the table: left out.
      placed(['SGPA 8.45', 10, 120, 120, 140]),
    ];
    expect(fillTable(structure, items).rows).toEqual([
      ['Code', 'Title', 'Total'],
      ['21MAT31', 'Transform Calculus, Numerical Techniques', '97'],
    ]);
  });

  it('splits a piece of text that runs across two cells between them', () => {
    // Narrow columns: the reader saw "45 52" as one piece of text.
    const structure: TableStructure = { rows: [[cell(0, 0, 100, 30), cell(100, 0, 140, 30), cell(140, 0, 180, 30)]] };
    const items = [placed(['Physics', 10, 5, 90, 25]), placed(['45 52', 108, 5, 172, 25])];
    expect(fillTable(structure, items).rows).toEqual([['Physics', '45', '52']]);
  });

  it('trusts a column over one cell of it drawn too wide', () => {
    // As SLANet drew the open grade card's header: its first cell reaching 287,
    // where every row under it ends near 233. Taken at its word, that cell cut
    // "Course Title" in two and kept "Course" for itself.
    const structure: TableStructure = {
      rows: [
        [cell(46, 222, 287, 260), cell(224, 222, 639, 260)],
        [cell(42, 260, 227, 300), cell(234, 260, 639, 300)],
        [cell(43, 300, 234, 340), cell(235, 300, 640, 340)],
        [cell(43, 340, 233, 380), cell(235, 340, 639, 380)],
      ],
    };
    const items = [
      placed(['Course Code', 54, 229, 186, 256]),
      placed(['Course Title', 253, 229, 375, 256]),
      placed(['21CS32', 53, 270, 136, 295]),
      placed(['Data Structures and Applications', 255, 270, 549, 295]),
      placed(['21CS33', 53, 310, 135, 335]),
      placed(['Analog and Digital Electronics', 254, 310, 525, 335]),
      placed(['21CS34', 53, 350, 135, 375]),
      placed(['Computer Organization', 255, 350, 470, 375]),
    ];
    expect(fillTable(structure, items).rows[0]).toEqual(['Course Code', 'Course Title']);
  });

  it('lays a spanning cell out over the columns it covers, its text in the first', () => {
    const structure: TableStructure = {
      rows: [
        [cell(0, 0, 100, 30), cell(100, 0, 300, 30, 2)],
        [cell(0, 30, 100, 60), cell(100, 30, 200, 60), cell(200, 30, 300, 60)],
      ],
    };
    const items = [
      placed(['Subject', 10, 5, 90, 25]),
      placed(['Marks', 150, 5, 250, 25]),
      placed(['Physics', 10, 35, 90, 55]),
      placed(['61', 110, 35, 140, 55]),
      placed(['P', 210, 35, 230, 55]),
    ];
    expect(fillTable(structure, items).rows).toEqual([
      ['Subject', 'Marks', ''],
      ['Physics', '61', 'P'],
    ]);
  });
});
