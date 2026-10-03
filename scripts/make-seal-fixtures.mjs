/**
 * A made-up certificate whose issuing authority is printed only in its seal,
 * for the seal reader's tests (Stage 4).
 *
 * The central formats for EWS and OBC certificates end "Signature with seal of
 * Office": the officer's designation is stamped, not printed. The seal here is
 * round, violet, stamped at an angle over the signature as a rubber stamp is,
 * its office along the top of the ring and its taluk along the bottom. Drawn
 * by Chromium. Every name, number and place is invented; it says SAMPLE on its face.
 *
 * Usage: node scripts/make-seal-fixtures.mjs (writes into fixtures/images/).
 */

import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../fixtures/images/', import.meta.url));

const INK = 'rgb(76, 46, 158)';

/** A round seal: two rings, the office along the top, the taluk along the bottom, stars between. */
const seal = (top, bottom, turn) => `
<svg class="seal" width="260" height="260" viewBox="-130 -130 260 260" style="transform: rotate(${turn}deg)">
  <defs>
    <!-- Clockwise over the top: letters stand outward. -->
    <path id="over" d="M -100 0 A 100 100 0 0 1 100 0" />
    <!-- Anticlockwise under the bottom: letters stand inward, read left to right. -->
    <path id="under" d="M -112 0 A 112 112 0 0 0 112 0" />
  </defs>
  <g fill="none" stroke="${INK}">
    <circle r="122" stroke-width="4" />
    <circle r="80" stroke-width="2" />
  </g>
  <g fill="${INK}" font-family="Arial, sans-serif" font-weight="bold">
    <text font-size="23" letter-spacing="2"><textPath href="#over" startOffset="50%" text-anchor="middle">${top}</textPath></text>
    <text font-size="19" letter-spacing="1"><textPath href="#under" startOffset="50%" text-anchor="middle">${bottom}</textPath></text>
    <text x="-108" y="7" font-size="18">★</text>
    <text x="92" y="7" font-size="18">★</text>
    <text x="0" y="-6" font-size="15" text-anchor="middle">GOVT. OF</text>
    <text x="0" y="14" font-size="15" text-anchor="middle">KARNATAKA</text>
  </g>
</svg>`;

const page = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #fff; }
  .card { position: relative; width: 1100px; padding: 44px 56px 40px; font: 21px Georgia, serif; color: #141414; background: #fff; }
  h1 { text-align: center; font: bold 26px Arial, sans-serif; margin: 0 0 4px; }
  h2 { text-align: center; font: 19px Arial, sans-serif; margin: 0 0 18px; }
  h3 { text-align: center; font: bold 24px Arial, sans-serif; margin: 0 0 26px; letter-spacing: 1px; }
  p { line-height: 1.7; margin: 0 0 14px; }
  .row { margin: 8px 0; }
  .foot { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 30px; height: 250px; }
  .sign { position: relative; width: 420px; text-align: center; }
  .scribble { font: italic 34px 'Brush Script MT', cursive; color: #1b2a6b; }
  .seal { position: absolute; right: 120px; bottom: 20px; mix-blend-mode: multiply; opacity: 0.9; }
  .note { font-size: 15px; color: #666; margin-top: 18px; }
</style></head><body><div class="card" id="card">
  <h1>GOVERNMENT OF KARNATAKA — SAMPLE</h1>
  <h2>Revenue Department</h2>
  <h3>CASTE CERTIFICATE (SAMPLE)</h3>
  <div class="row">RD Number : RD0987654321012</div>
  <p>This is to certify that Sri ARJUN MEHTA, son of RAMESH MEHTA, resident of
  Samplepura village, Samplepura Taluk, belongs to the Samplecaste caste, which is
  recognised as Category-2A.</p>
  <div class="row">Date of Issue : 14/03/2024</div>
  <div class="row">Place : Samplepura</div>
  <div class="foot">
    <div></div>
    <div class="sign"><div class="scribble">R. Samplegowda</div><div>Signature of the issuing authority</div></div>
  </div>
  ${seal('TAHSILDAR', 'SAMPLEPURA TALUK', -14)}
  <div class="note">SAMPLE — made up for software tests. Not a real document.</div>
</div></body></html>`;

const browser = await chromium.launch();
const tab = await browser.newPage({ viewport: { width: 1200, height: 1100 }, deviceScaleFactor: 1 });
await tab.setContent(page);
await tab.locator('#card').screenshot({ path: `${OUT}caste-certificate-seal.png` });
console.log('wrote fixtures/images/caste-certificate-seal.png');
await browser.close();
