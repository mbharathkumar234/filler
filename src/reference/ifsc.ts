/**
 * RBI's list of IFSC codes, packed for the extension.
 *
 * From razorpay/ifsc (MIT), which republishes the list RBI keeps of every bank
 * branch: its code, its bank, its name, address and MICR code. Fetched once
 * when the extension is built, pinned by hash, and shipped inside it — never
 * fetched while it runs (`scripts/fetch-reference-data.mjs`).
 *
 * An IFSC is the address of a bank branch, not anybody's detail. Looking one up
 * in this list lets the extension say which branch it is — and whether a code
 * read off a passbook photo exists at all.
 *
 * Packed one bank to a file, so a lookup opens the one bank it is about: the
 * whole list is 24 MB as JSON, State Bank of India alone a megabyte zipped.
 * Pure: the build packs with `compactIfsc`, and the background worker unpacks
 * with `ifscRecord` (`background/reference-data.ts`).
 */

// With its extension: `vite.config.ts` loads this file itself, and Vite's own
// config loader will not resolve a relative import without one.
import { canonicalState, placeName } from './places.ts';

/** A branch as razorpay/ifsc publishes it, the fields read here. */
export interface RawBranch {
  BANK?: string | null;
  IFSC?: string | null;
  MICR?: string | null;
  BRANCH?: string | null;
  ADDRESS?: string | null;
  CITY?: string | null;
  DISTRICT?: string | null;
  STATE?: string | null;
}

/** A branch, from its code. */
export interface IfscRecord {
  ifsc: string;
  bank: string;
  branch: string;
  address: string;
  city: string;
  district: string;
  state: string;
  /** Empty where the list has none. */
  micr: string;
}

/** Every bank's name by its four letters, and the states the branches name, once each. */
export interface IfscIndex {
  source: string;
  banks: Record<string, string>;
  states: string[];
}

/** One bank's branches by the six characters after the zero: branch, address, city, district, state, MICR. */
export type IfscShard = Record<string, [string, string, string, string, number, string]>;

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/** Four capitals, a zero, then six capitals or digits. */
export function isIfsc(code: string): boolean {
  return IFSC.test(code);
}

/** What the published list writes where it has nothing: "NA", "Na", "N/A". */
const PLACEHOLDER = /^(?:n\.?\s?a\.?|n\/a|null|nil|none|-+)$/i;

const text = (value: string | null | undefined) => {
  const cleaned = (value ?? '').replace(/\s+/g, ' ').trim();
  return PLACEHOLDER.test(cleaned) ? '' : cleaned;
};

/** A bank that merged into another: its name, and the bank its branches are part of now. */
export interface MergedBank {
  name: string;
  into: string;
  /** The four letters the branches' codes begin with now. */
  intoCode: string;
}

/**
 * Banks merged into others, by the four letters their codes began with.
 *
 * Their branches were given the new bank's codes, and RBI's list keeps none of
 * the old ones. So an old passbook's IFSC is not in the list without having
 * been misread — it is out of date, and a form wants the new one.
 */
const MERGED_BANKS: Readonly<Record<string, MergedBank>> = {
  ANDB: { name: 'Andhra Bank', into: 'Union Bank of India', intoCode: 'UBIN' },
  CORP: { name: 'Corporation Bank', into: 'Union Bank of India', intoCode: 'UBIN' },
  ORBC: { name: 'Oriental Bank of Commerce', into: 'Punjab National Bank', intoCode: 'PUNB' },
  UTBI: { name: 'United Bank of India', into: 'Punjab National Bank', intoCode: 'PUNB' },
  ALLA: { name: 'Allahabad Bank', into: 'Indian Bank', intoCode: 'IDIB' },
  SYNB: { name: 'Syndicate Bank', into: 'Canara Bank', intoCode: 'CNRB' },
  VIJB: { name: 'Vijaya Bank', into: 'Bank of Baroda', intoCode: 'BARB' },
  BKDN: { name: 'Dena Bank', into: 'Bank of Baroda', intoCode: 'BARB' },
  LAVB: { name: 'Lakshmi Vilas Bank', into: 'DBS Bank India', intoCode: 'DBSS' },
  VYSA: { name: 'ING Vysya Bank', into: 'Kotak Mahindra Bank', intoCode: 'KKBK' },
  SBMY: { name: 'State Bank of Mysore', into: 'State Bank of India', intoCode: 'SBIN' },
  SBHY: { name: 'State Bank of Hyderabad', into: 'State Bank of India', intoCode: 'SBIN' },
  SBTR: { name: 'State Bank of Travancore', into: 'State Bank of India', intoCode: 'SBIN' },
  SBBJ: { name: 'State Bank of Bikaner and Jaipur', into: 'State Bank of India', intoCode: 'SBIN' },
  STBP: { name: 'State Bank of Patiala', into: 'State Bank of India', intoCode: 'SBIN' },
  BMBL: { name: 'Bharatiya Mahila Bank', into: 'State Bank of India', intoCode: 'SBIN' },
};

/** The bank an old code belonged to, when it merged into another; null for a bank with codes of its own. */
export function mergedBank(code: string): MergedBank | null {
  return isIfsc(code) ? (MERGED_BANKS[code.slice(0, 4)] ?? null) : null;
}

/** Are two codes one character apart — one dropped, added or changed? */
function oneApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1 || a === b) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/**
 * The branches of a bank whose codes a misread code is one character from: a
 * character dropped ("SMPL000123" for SMPL0000123), or one too many. Every one
 * is returned — choosing among several is the caller's to do, or not to do.
 */
export function nearCodes(index: IfscIndex, shard: IfscShard, read: string): IfscRecord[] {
  const code = read.toUpperCase();
  if (!/^[A-Z]{4}0[A-Z0-9]{4,7}$/.test(code) || index.banks[code.slice(0, 4)] === undefined) return [];
  const tail = code.slice(5);
  return Object.keys(shard)
    .filter((branch) => oneApart(branch, tail))
    .map((branch) => ifscRecord(index, shard, `${code.slice(0, 4)}0${branch}`))
    .filter((record): record is IfscRecord => record !== null);
}

/** "State Bank of India’s KOLKATA MAIN branch, in Kolkata". */
export function describeBranch(record: IfscRecord): string {
  const town = record.city !== '' ? record.city : record.district;
  return `${record.bank}’s ${record.branch} branch${town === '' ? '' : `, in ${town}`}`;
}

/**
 * Why a code is not in the list, said to whoever has it — read off a document,
 * or typed. An old bank's code is out of date rather than wrong, and is told so.
 */
export function notListed(code: string, how: 'read' | 'typed'): string {
  const merged = mergedBank(code);
  if (merged !== null) {
    return (
      `${code} is a ${merged.name} code. ${merged.name} merged into ${merged.into}, and its branches were given new IFSCs — ` +
      'a form wants the new one, which is on a recent passbook page or cheque.'
    );
  }
  return how === 'read'
    ? `${code} is not in RBI’s list of IFSC codes. It was probably misread — check it against the passbook or a cheque.`
    : `${code} is not in RBI’s list of IFSC codes. Check it against your passbook or a cheque.`;
}

/** The banks merged into this code's bank, whose names its older passbooks still print. */
export function formerBanks(code: string): string[] {
  const bank = code.slice(0, 4);
  return Object.values(MERGED_BANKS)
    .filter((merged) => merged.intoCode === bank)
    .map((merged) => merged.name);
}

/** The list as the build ships it: an index, and one shard per bank. */
export function compactIfsc(
  byBank: Readonly<Record<string, Readonly<Record<string, RawBranch>>>>,
  source: string,
): { index: IfscIndex; shards: Record<string, IfscShard> } {
  const index: IfscIndex = { source, banks: {}, states: [] };
  const stateAt = new Map<string, number>();
  const shards: Record<string, IfscShard> = {};

  for (const bank of Object.keys(byBank).sort()) {
    const shard: IfscShard = {};
    for (const [code, row] of Object.entries(byBank[bank]!)) {
      if (!isIfsc(code) || code.slice(0, 4) !== bank) continue;
      index.banks[bank] ??= text(row.BANK);
      const state = canonicalState(text(row.STATE));
      let at = stateAt.get(state);
      if (at === undefined) {
        at = index.states.length;
        index.states.push(state);
        stateAt.set(state, at);
      }
      shard[code.slice(5)] = [
        text(row.BRANCH),
        text(row.ADDRESS),
        placeName(text(row.CITY)),
        placeName(text(row.DISTRICT)),
        at,
        /^\d{9}$/.test(text(row.MICR)) ? text(row.MICR) : '',
      ];
    }
    if (Object.keys(shard).length > 0) shards[bank] = shard;
  }
  return { index, shards };
}

/** A branch from its code and its bank's shard; null when the list has no such branch. */
export function ifscRecord(index: IfscIndex, shard: IfscShard, code: string): IfscRecord | null {
  if (!isIfsc(code)) return null;
  const row = shard[code.slice(5)];
  const bank = index.banks[code.slice(0, 4)];
  if (row === undefined || bank === undefined) return null;
  const [branch, address, city, district, state, micr] = row;
  return { ifsc: code, bank, branch, address, city, district, state: index.states[state] ?? '', micr };
}
