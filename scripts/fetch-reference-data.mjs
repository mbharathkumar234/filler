/**
 * The lists the extension looks codes up in, fetched once at build time and
 * pinned by hash.
 *
 *  - RBI's list of IFSC codes, as razorpay/ifsc publishes it (MIT): every bank
 *    branch's code, name, address and MICR code. A tagged release, so its file
 *    never changes under the same name.
 *  - India Post's All India Pincode Directory, Department of Posts, Government
 *    of India, from data.gov.in under the Government Open Data License – India,
 *    which allows reuse with credit. Republished there every month under one
 *    name: when the file changes, its hash no longer matches and the build
 *    stops, exactly as for a model — check the new file, then update the pin.
 *
 * **At build time, never at run time**, like the models: the files land in
 * `vendor/reference/` (not committed), `referenceData()` in `vite.config.ts`
 * packs them into `dist/reference/`, and the extension reads only those. Its
 * CSP would refuse anything else. A lookup is a branch's or a delivery area's
 * public details; nothing about the user is involved in building them.
 *
 * Usage: `node scripts/fetch-reference-data.mjs` — a no-op when every file is
 * already present and verified.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REFERENCE_DATA = [
  {
    name: 'ifsc',
    file: 'ifsc-by-bank-v2.0.62.tar.gz',
    url: 'https://github.com/razorpay/ifsc/releases/download/v2.0.62/by-bank.tar.gz',
    sha256: '90c10afab97341ce5c6def9266720d169b3b8cea87db5acab570be71e0cee679',
    source: 'RBI’s list of IFSC codes, from razorpay/ifsc v2.0.62 (MIT)',
  },
  {
    name: 'pincode',
    file: 'all-india-pincode-directory.csv',
    // data.gov.in serves the directory from its bare host; www. redirects to itself.
    url: 'https://data.gov.in/files/ogdpv2dms/s3fs-public/dataurl03122020/pincode.csv',
    sha256: '84af12fa29adddedfa9addcf46546000d89d2e2899b2993dc88050fafc8861e2',
    source:
      'All India Pincode Directory, Department of Posts, Government of India, data.gov.in (Government Open Data License – India)',
  },
];

export const REFERENCE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'reference');

export const referencePath = (entry) => join(REFERENCE_DIR, entry.file);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function ensure(entry) {
  const path = referencePath(entry);
  if (existsSync(path) && sha256(readFileSync(path)) === entry.sha256) return 'present';

  // data.gov.in answers a browser, not a bare client.
  const response = await fetch(entry.url, { headers: { 'User-Agent': 'Mozilla/5.0 (AutoFill Assistant build)' } });
  if (!response.ok) throw new Error(`${entry.name}: HTTP ${response.status} from ${entry.url}`);
  const bytes = Buffer.from(await response.arrayBuffer());

  const actual = sha256(bytes);
  if (actual !== entry.sha256) {
    throw new Error(
      `${entry.name}: the file at ${entry.url} has changed (sha256 ${actual}, expected ${entry.sha256}). ` +
        'Nothing was written. Check the new file, then update the pin in scripts/fetch-reference-data.mjs.',
    );
  }

  mkdirSync(REFERENCE_DIR, { recursive: true });
  writeFileSync(path, bytes);
  return 'fetched';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const entry of REFERENCE_DATA) {
    const outcome = await ensure(entry);
    console.log(`${entry.name}: ${outcome}`);
  }
}
