/**
 * Made-up semester grade cards, for the table reader's tests (Stage 3).
 *
 * One with ruled cells and one without — the two kinds of table a university
 * prints — each with a course title long enough to wrap onto a second line,
 * which is what a reader pairing words by row gets wrong. Drawn by Chromium.
 * Every name, number and institution is invented; each says SAMPLE on its face.
 *
 * Usage: node scripts/make-grade-card-fixtures.mjs (writes into fixtures/images/).
 */

import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../fixtures/images/', import.meta.url));

const COURSES = [
  ['21MAT31', 'Transform Calculus, Fourier Series and Numerical Techniques', 3, 45, 52, 97, 'A'],
  ['21CS32', 'Data Structures and Applications', 4, 47, 58, 105, 'A+'],
  ['21CS33', 'Analog and Digital Electronics', 4, 42, 49, 91, 'A'],
  ['21CS34', 'Computer Organization and Architecture', 3, 40, 45, 85, 'B+'],
  ['21CS35', 'Object Oriented Programming with Java', 3, 46, 55, 101, 'A+'],
  ['21CSL36', 'Data Structures Laboratory', 1, 48, 47, 95, 'A'],
  ['21KSK37', 'Samskrutika Kannada', 1, 44, 41, 85, 'B+'],
];

const page = (ruled) => `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #fff; }
  .card { width: 1180px; padding: 40px 48px; font: 20px Arial, sans-serif; color: #111; background: #fff; }
  h1 { text-align: center; font-size: 28px; margin: 0 0 4px; }
  .sub { text-align: center; font-size: 18px; margin: 0 0 22px; }
  .row { display: flex; gap: 12px; margin: 8px 0; }
  .row b { width: 260px; }
  table { border-collapse: collapse; width: 100%; margin: 20px 0; }
  th, td { padding: 8px 10px; text-align: left; vertical-align: top; ${ruled ? 'border: 1px solid #333;' : 'border: 0;'} }
  th { ${ruled ? '' : 'border-bottom: 2px solid #333;'} }
  td.title { width: 380px; }
  .note { font-size: 15px; color: #666; margin-top: 16px; }
</style></head><body><div class="card" id="card">
  <h1>SAMPLE TECHNOLOGICAL UNIVERSITY</h1>
  <p class="sub">PROVISIONAL GRADE CARD — SAMPLE</p>
  <div class="row"><b>Name of the Student</b><span>ARJUN MEHTA</span></div>
  <div class="row"><b>University Seat Number</b><span>1SA21CS042</span></div>
  <div class="row"><b>Semester</b><span>III</span></div>
  <table>
    <tr><th>Course Code</th><th>Course Title</th><th>Credits</th><th>Internal</th><th>External</th><th>Total</th><th>Grade</th></tr>
    ${COURSES.map(([code, title, credits, internal, external, total, grade]) =>
      `<tr><td>${code}</td><td class="title">${title}</td><td>${credits}</td><td>${internal}</td><td>${external}</td><td>${total}</td><td>${grade}</td></tr>`,
    ).join('\n    ')}
  </table>
  <div class="row"><b>SGPA</b><span>8.45</span></div>
  <div class="row"><b>CGPA</b><span>8.21</span></div>
  <div class="row"><b>Result</b><span>PASS</span></div>
  <div class="note">SAMPLE — made up for software tests. Not a real document.</div>
</div></body></html>`;

const browser = await chromium.launch();
const tab = await browser.newPage({ viewport: { width: 1300, height: 1200 }, deviceScaleFactor: 1 });
for (const [file, ruled] of [['grade-card-ruled.png', true], ['grade-card-open.png', false]]) {
  await tab.setContent(page(ruled));
  await tab.locator('#card').screenshot({ path: `${OUT}${file}` });
  console.log(`wrote fixtures/images/${file}`);
}
/*
 * The same card as a university portal hands it over: a PDF with real text in
 * it, which is read exactly rather than recognised — and whose table has no
 * picture for a table model, only where each piece of text sits.
 */
await tab.setContent(page(true));
await tab.pdf({ path: fileURLToPath(new URL('../fixtures/pdf/grade-card.pdf', import.meta.url)), width: '1280px', height: '780px', printBackground: true });
console.log('wrote fixtures/pdf/grade-card.pdf');
await browser.close();
