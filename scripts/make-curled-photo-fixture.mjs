/**
 * The flat page `make-curled-photo-fixture.py` bends: a made-up marks card,
 * drawn by Chromium. Every name, number and institution on it is invented.
 *
 * Usage: node scripts/make-curled-photo-fixture.mjs && python scripts/make-curled-photo-fixture.py
 */

import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../fixtures/images/flat-marks-card.png', import.meta.url));

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #fff; }
  .card { width: 1000px; padding: 48px 56px; font: 24px Arial, sans-serif; color: #111; background: #fff; }
  .head { text-align: center; }
  .head h1 { font-size: 30px; margin: 0 0 6px; }
  .head p { margin: 0 0 4px; font-size: 20px; }
  .row { display: flex; gap: 12px; margin: 14px 0; }
  .row b { width: 280px; }
  table { border-collapse: collapse; width: 100%; margin-top: 18px; }
  td, th { border: 1px solid #333; padding: 8px 10px; font-size: 22px; text-align: left; }
  .note { font-size: 16px; color: #666; margin-top: 18px; }
</style></head><body><div class="card" id="card">
  <div class="head">
    <h1>SAMPLE BOARD OF SECONDARY EDUCATION</h1>
    <p>STATEMENT OF MARKS — SAMPLE</p>
  </div>
  <div class="row"><b>Name of the Candidate</b><span>ANIKA RAO</span></div>
  <div class="row"><b>Register Number</b><span>4815162342</span></div>
  <div class="row"><b>Date of Birth</b><span>09/07/2006</span></div>
  <div class="row"><b>School</b><span>SAMPLE PUBLIC SCHOOL, NAVANAGAR</span></div>
  <table>
    <tr><th>Subject</th><th>Max</th><th>Obtained</th></tr>
    <tr><td>English</td><td>100</td><td>87</td></tr>
    <tr><td>Mathematics</td><td>100</td><td>93</td></tr>
    <tr><td>Science</td><td>100</td><td>89</td></tr>
    <tr><td>Social Science</td><td>100</td><td>84</td></tr>
    <tr><td>Total</td><td>400</td><td>353</td></tr>
  </table>
  <div class="row"><b>Result</b><span>FIRST CLASS WITH DISTINCTION</span></div>
  <div class="note">SAMPLE — made up for software tests. Not a real document.</div>
</div></body></html>`;

const browser = await chromium.launch();
const tab = await browser.newPage({ viewport: { width: 1100, height: 1000 }, deviceScaleFactor: 1 });
await tab.setContent(html);
await tab.locator('#card').screenshot({ path: OUT });
await browser.close();
console.log('wrote fixtures/images/flat-marks-card.png');
