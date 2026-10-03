/**
 * Made-up certificates printed in Hindi, Telugu and Tamil, for the reader's
 * tests (`tests/e2e/panel.spec.ts`).
 *
 * Rendered by Chromium, because shaping an Indian script — the conjuncts, the
 * vowel signs drawn before the letter they follow — is a browser's work, and an
 * image library without a shaping engine draws them wrongly. Every name, number
 * and place here is invented; each page says SAMPLE on its face.
 *
 * Usage: `node scripts/make-indic-fixtures.mjs` (writes into fixtures/images/).
 */

import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../fixtures/images/', import.meta.url));

const CERTIFICATES = [
  {
    file: 'hindi-income-certificate.jpg',
    lang: 'hi',
    title: 'आय प्रमाण पत्र',
    authority: 'नमूना राज्य शासन',
    lines: [
      'प्रमाण पत्र संख्या : 212340056789',
      'नाम : सीमा वर्मा',
      'पिता का नाम : राजेश वर्मा',
      'वार्षिक आय : 48000',
      'जारी करने की तिथि : 15/03/2024',
    ],
    signature: 'तहसीलदार',
  },
  {
    file: 'telugu-income-certificate.jpg',
    lang: 'te',
    title: 'ఆదాయ ధృవీకరణ పత్రం',
    authority: 'నమూనా రాష్ట్ర ప్రభుత్వం',
    lines: ['తండ్రి పేరు : వెంకట రావు', 'వార్షిక ఆదాయం : 72000', 'చిరునామా : విజయవాడ'],
    signature: 'తహసీల్దార్',
  },
  {
    file: 'tamil-income-certificate.jpg',
    lang: 'ta',
    title: 'வருமானச் சான்றிதழ்',
    authority: 'மாதிரி மாநில அரசு',
    lines: ['பெயர் : கவிதா முருகன்', 'தந்தை பெயர் : முருகன் செல்வம்', 'ஆண்டு வருமானம் : 60000'],
    signature: 'வட்டாட்சியர்',
  },
];

const page = (certificate) => `<!doctype html>
<html lang="${certificate.lang}"><head><meta charset="utf-8"><style>
  body { margin: 0; background: #e9e6df; }
  .sheet { width: 1100px; margin: 30px; padding: 60px 70px; background: #fffdf8; color: #1d1d1d;
    font: 34px 'Nirmala UI', 'Mangal', 'Gautami', 'Latha', sans-serif; position: relative;
    box-shadow: 0 2px 10px rgba(0,0,0,.25); }
  .authority { text-align: center; font-size: 30px; color: #444; }
  h1 { text-align: center; font-size: 46px; margin: 18px 0 40px; }
  p { margin: 0 0 30px; }
  /* Clear of the text: a watermark across a line damages it (measured — the
     father's name under one went unread), which is a test of its own. */
  .sample { position: absolute; bottom: 70px; left: 70px; font: bold 64px sans-serif; color: rgba(200,0,0,.18);
    transform: rotate(-8deg); }
  .sign { text-align: right; margin-top: 70px; }
  .note { font: 22px sans-serif; color: #777; margin-top: 30px; }
</style></head><body><div class="sheet" id="sheet">
  <div class="authority">${certificate.authority}</div>
  <h1>${certificate.title}</h1>
  ${certificate.lines.map((line) => `<p>${line}</p>`).join('\n  ')}
  <div class="sign">${certificate.signature}</div>
  <div class="note">SAMPLE — made up for software tests. Not a real document.</div>
  <div class="sample">SAMPLE</div>
</div></body></html>`;

const browser = await chromium.launch();
const tab = await browser.newPage({ viewport: { width: 1200, height: 1100 }, deviceScaleFactor: 1 });
for (const certificate of CERTIFICATES) {
  await tab.setContent(page(certificate));
  await tab.locator('#sheet').screenshot({ path: `${OUT}${certificate.file}`, type: 'jpeg', quality: 85 });
  console.log(`wrote fixtures/images/${certificate.file}`);
}
await browser.close();
