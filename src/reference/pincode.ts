/**
 * India Post's PIN code directory, packed for the extension.
 *
 * The All India Pincode Directory, Department of Posts, Government of India,
 * published on data.gov.in under the Government Open Data License – India,
 * which allows its reuse with credit. Fetched once when the extension is built,
 * pinned by hash, and shipped inside it — never fetched while it runs
 * (`scripts/fetch-reference-data.mjs`).
 *
 * A PIN names a delivery area, not a person. Looking one up says which
 * district and state it is in — what a form asks beside it — and whether a
 * PIN read off a photo exists at all. Pure.
 */

// With its extension: `vite.config.ts` loads this file itself, and Vite's own
// config loader will not resolve a relative import without one.
import { canonicalState, placeName } from './places.ts';

/** A PIN's places: its state (rarely two), its districts, its post offices. */
export interface PinRecord {
  pin: string;
  states: string[];
  districts: string[];
  offices: string[];
}

/** The directory as the build ships it: each state and district named once. */
export interface PinTable {
  source: string;
  states: string[];
  districts: string[];
  pins: Record<string, [number[], number[], string[]]>;
}

const PIN = /^[1-9][0-9]{5}$/;

/** A CSV file as rows of cells: quoted cells, commas and doubled quotes inside them. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') {
        quoted = false;
      } else {
        cell += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += c;
    }
  }
  row.push(cell);
  if (row.some((value) => value !== '')) rows.push(row);
  return rows;
}

/** The directory, read from India Post's CSV. */
export function compactPincodes(csv: string, source: string): PinTable {
  const [header, ...rows] = parseCsv(csv);
  const column = (name: string) => (header ?? []).findIndex((cell) => cell.trim().toLowerCase() === name);
  const at = { pin: column('pincode'), office: column('officename'), district: column('district'), state: column('statename') };
  if (Object.values(at).some((index) => index === -1)) {
    throw new Error('Not India Post’s directory: it needs Pincode, OfficeName, District and StateName columns.');
  }

  const table: PinTable = { source, states: [], districts: [], pins: {} };
  const stateAt = new Map<string, number>();
  const districtAt = new Map<string, number>();
  const indexOf = (map: Map<string, number>, list: string[], name: string) => {
    let index = map.get(name);
    if (index === undefined) {
      index = list.length;
      list.push(name);
      map.set(name, index);
    }
    return index;
  };

  for (const row of rows) {
    const pin = (row[at.pin] ?? '').trim();
    if (!PIN.test(pin)) continue;
    const state = canonicalState(row[at.state] ?? '');
    const district = placeName(row[at.district] ?? '');
    const office = (row[at.office] ?? '').trim();
    const entry = (table.pins[pin] ??= [[], [], []]);
    if (state !== '') {
      const s = indexOf(stateAt, table.states, state);
      if (!entry[0].includes(s)) entry[0].push(s);
    }
    if (district !== '') {
      const d = indexOf(districtAt, table.districts, district);
      if (!entry[1].includes(d)) entry[1].push(d);
    }
    if (office !== '' && !entry[2].includes(office)) entry[2].push(office);
  }
  return table;
}

/**
 * Why a PIN is not in the directory, said to whoever has it — read off a
 * document, or typed. The directory is India Post's of December 2020, so a PIN
 * opened since is missing from it without being wrong.
 */
export function pinNotListed(pin: string, how: 'read' | 'typed'): string {
  return how === 'read'
    ? `PIN ${pin} is not in India Post’s PIN directory. It was probably misread — check it against the document.`
    : `PIN ${pin} is not in India Post’s PIN directory of 2020. Check it against a letter sent to this address.`;
}

/** A PIN's places; null when the directory has no such PIN. */
export function pinRecord(table: PinTable, pin: string): PinRecord | null {
  if (!PIN.test(pin)) return null;
  const entry = table.pins[pin];
  if (entry === undefined) return null;
  return {
    pin,
    states: entry[0].map((index) => table.states[index]!),
    districts: entry[1].map((index) => table.districts[index]!),
    offices: [...entry[2]],
  };
}
