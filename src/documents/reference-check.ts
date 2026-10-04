/**
 * What a document read, checked against RBI's and India Post's lists
 * (`reference/ifsc.ts`, `reference/pincode.ts`).
 *
 * An IFSC is a branch's address and a PIN a delivery area's, so each says
 * something the document may also print beside it — the bank and branch, the
 * district and state. Two that disagree mean one of them was misread, and the
 * user is told so rather than handed both. Two that agree are said to, on the
 * IFSC's own row — and left for the user to tick, because only a checksum
 * pre-ticks a row: a code misread by one digit can still be a real branch.
 *
 * A PIN is never said to agree. Its digits narrow from region to post office,
 * so a PIN misread in its last digit is its neighbour, in the same district
 * and state; agreeing with them proves nothing about the digit that was wrong.
 *
 * And what the document did not print, the list knows: a passbook's MICR code
 * and branch address, an Aadhaar's district. Those are offered, each marked as
 * the list's (`Candidate.listed`), and never over anything the document printed.
 *
 * An IFSC read a character short (`NearMiss`) is put right only when the list
 * leaves one branch it can be — or one that the branch printed on the document
 * names — and its row says what was read and what it was put right to.
 *
 * Pure: the lookups are done before (`lookUp`, through a port), so this is
 * tested without a browser.
 */

import type { FieldKey } from '@/matching/taxonomy';
import { describeBranch, formerBanks, notListed, type IfscRecord } from '@/reference/ifsc';
import { pinNotListed, type PinRecord } from '@/reference/pincode';
import { canonicalState } from '@/reference/places';
import type { Candidate, ExtractionResult } from './extract';

/** The two lists, as whoever has them answers. */
export interface ReferenceLookup {
  ifsc(code: string): Promise<IfscRecord | null>;
  /** The branches a code read a character short or long can be (`reference/ifsc.ts` → `nearCodes`). */
  ifscNear?(code: string): Promise<IfscRecord[]>;
  pincode(pin: string): Promise<PinRecord | null>;
}

/**
 * What the lists said about each code: a record, or null when the list has no
 * such code. A code missing from the map was not checked — a lookup that failed
 * says nothing about the code.
 */
export interface ReferenceFinds {
  ifsc: ReadonlyMap<string, IfscRecord | null>;
  pins: ReadonlyMap<string, PinRecord | null>;
  /** For each IFSC read a character from its shape, the branches it can be. */
  near?: ReadonlyMap<string, readonly IfscRecord[]>;
}

const PINCODE_KEY = /^address\.(permanent|correspondence)\.pincode$/;

/** The IFSCs, near misses and PINs a reading has, each once, in the order read. */
export function codesIn(result: ExtractionResult): { ifscs: string[]; near: string[]; pins: string[] } {
  const ifscs: string[] = [];
  const pins: string[] = [];
  for (const candidate of result.candidates) {
    if (candidate.key === 'bank.ifsc' && !ifscs.includes(candidate.value)) ifscs.push(candidate.value);
    if (PINCODE_KEY.test(candidate.key) && !pins.includes(candidate.value)) pins.push(candidate.value);
  }
  const near = [...new Set((result.nearMisses ?? []).map((miss) => miss.read))];
  return { ifscs, near, pins };
}

/** Ask the lists about each code once. A lookup that fails leaves its code unchecked. */
export async function lookUp(result: ExtractionResult, lookup: ReferenceLookup): Promise<ReferenceFinds> {
  const { ifscs, near, pins } = codesIn(result);
  const ifsc = new Map<string, IfscRecord | null>();
  const nearby = new Map<string, IfscRecord[]>();
  const found = new Map<string, PinRecord | null>();
  for (const code of ifscs) {
    try {
      ifsc.set(code, await lookup.ifsc(code));
    } catch {
      // Unchecked, not absent.
    }
  }
  for (const code of near) {
    if (lookup.ifscNear === undefined) break;
    try {
      nearby.set(code, await lookup.ifscNear(code));
    } catch {
      // Unchecked, not absent.
    }
  }
  for (const pin of pins) {
    try {
      found.set(pin, await lookup.pincode(pin));
    } catch {
      // Unchecked, not absent.
    }
  }
  return { ifsc, pins: found, near: nearby };
}

/** Words that say nothing about which bank or branch: "of", "the", "bank", "branch". */
const NOT_NAMES = new Set(['THE', 'AND', 'LTD', 'LIMITED', 'BANK', 'BRANCH', 'OFFICE', 'COOPERATIVE', 'OPERATIVE']);

/**
 * Towns by the names they had. A passbook printed before Bangalore became
 * Bengaluru still says Bangalore — and so, often, does RBI's list.
 */
const RENAMED: Readonly<Record<string, string>> = {
  BANGALORE: 'BENGALURU',
  MYSORE: 'MYSURU',
  MANGALORE: 'MANGALURU',
  BELGAUM: 'BELAGAVI',
  HUBLI: 'HUBBALLI',
  GULBARGA: 'KALABURAGI',
  BELLARY: 'BALLARI',
  BIJAPUR: 'VIJAYAPURA',
  SHIMOGA: 'SHIVAMOGGA',
  TUMKUR: 'TUMAKURU',
  CHIKMAGALUR: 'CHIKKAMAGALURU',
  HOSPET: 'HOSAPETE',
  BOMBAY: 'MUMBAI',
  MADRAS: 'CHENNAI',
  CALCUTTA: 'KOLKATA',
  GURGAON: 'GURUGRAM',
  TRIVANDRUM: 'THIRUVANANTHAPURAM',
  COCHIN: 'KOCHI',
  CALICUT: 'KOZHIKODE',
  POONA: 'PUNE',
  BARODA: 'VADODARA',
  PONDICHERRY: 'PUDUCHERRY',
  GAUHATI: 'GUWAHATI',
  SIMLA: 'SHIMLA',
};

/** The words of a name that name something, each town by its present name. */
function words(text: string): string[] {
  return text
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter((word) => word.length >= 3 && !NOT_NAMES.has(word))
    .map((word) => RENAMED[word] ?? word);
}

/** Do two names share a word that names something? */
function shareAWord(a: string, b: string): boolean {
  const these = new Set(words(a));
  return words(b).some((word) => these.has(word));
}

/** The fewest letters changed, added or dropped to make one word the other. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * One name spelled two ways — MALLESHWARAM and MALLESWARAM, or SAMPLEPURA read
 * SAMPLEPURT — and not two names a couple of letters apart: JAYANAGAR is not
 * VIJAYANAGAR.
 */
function sameName(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  if (shorter < 6) return false;
  return editDistance(a, b) <= (shorter >= 12 ? 2 : 1);
}

/**
 * Is the branch printed beside a code the branch RBI's list names for it?
 *
 * Compared by the branch's own name, less its town: a bank has a hundred
 * branches in Bengaluru, and a code misread by a digit is often one of them.
 * The same name, however spelled or spaced, is `same`; a name sharing no word
 * with the listed one is `other`; anything between — part of the listed name,
 * or the town alone — is `part`, and said rather than judged.
 */
function compareBranch(printed: string, record: IfscRecord): 'same' | 'part' | 'other' {
  const town = [...words(record.city), ...words(record.district), ...words(record.state)];
  const isTown = (word: string) => town.some((name) => sameName(word, name));
  const said = words(printed).filter((word) => !isTown(word));
  const listed = words(record.branch).filter((word) => !isTown(word));
  if (said.length === 0 || listed.length === 0) return 'part';
  if (sameName(said.join(''), listed.join(''))) return 'same';
  return said.some((a) => listed.some((b) => sameName(a, b))) ? 'part' : 'other';
}

/** "State Bank of India" as SBI. */
function initials(name: string): string {
  return name
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter((word) => word !== '' && !['OF', 'THE', 'AND', 'LTD', 'LIMITED'].includes(word))
    .map((word) => word[0])
    .join('');
}

/** The code's bank, by its name, its initials, or a name its passbooks had before a merger. */
function sameBank(printed: string, record: IfscRecord): boolean {
  const compact = printed.toUpperCase().replace(/[^A-Z]/g, '');
  return [record.bank, ...formerBanks(record.ifsc)].some((name) => compact === initials(name) || shareAWord(printed, name));
}

/** "Karnataka and Kerala"; "Bengaluru Urban and Ramanagara". */
function andList(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "KOLKATA MAIN branch, in Kolkata". */
function place(record: IfscRecord): string {
  return `${record.branch} branch${record.city === '' ? '' : `, in ${record.city}`}`;
}

/** Fields the lists fill, named as the user's notes name them. */
const NAMED: Partial<Record<FieldKey, string>> = {
  'bank.bank_name': 'bank name',
  'bank.branch': 'branch',
  'bank.micr': 'MICR code',
  'bank.branch_address': 'branch address',
};

/**
 * The reading, checked against the lists. `lines` is the document's text, where
 * a branch stamped with no label is looked for. Returns a new result; the one
 * given is left as it was.
 */
export function checkAgainstReference(
  result: ExtractionResult,
  finds: ReferenceFinds,
  lines: readonly string[] = [],
): ExtractionResult {
  const candidates = result.candidates.map((candidate) => ({ ...candidate }));
  const warnings = [...result.warnings];
  const notes = [...result.notes];
  const known = new Map(finds.ifsc);
  const has = (key: string) => candidates.find((candidate) => candidate.key === key);
  /** A value from a list, on the line of the code it was found by — never over one the page printed. */
  const offer = (key: FieldKey, value: string, from: Candidate, list: 'ifsc' | 'pincode', evidence: string) => {
    if (value === '' || has(key) !== undefined) return false;
    candidates.push({
      key,
      value,
      confidence: 0.8,
      evidence,
      line: from.line,
      verified: false,
      confirmed: false,
      suggestChecked: false,
      listed: { list, code: from.value },
    });
    return true;
  };
  /** The line of the document naming this branch the list's way, read a letter off or not. */
  const printedBranch = (record: IfscRecord) => lines.map((line) => line.trim()).find((line) => compareBranch(line, record) === 'same');

  // ---- An IFSC read a character short ----------------------------------------
  for (const miss of result.nearMisses ?? []) {
    if (has(miss.key) !== undefined) continue;
    const off = miss.read.length < 11 ? 'a character short' : 'a character too long';
    const options = finds.near?.get(miss.read);
    if (options === undefined) {
      warnings.push(`The IFSC was read as ${miss.read}, ${off}. Check it against the passbook or a cheque, and type it in.`);
      continue;
    }
    const stamped = options.filter((record) => printedBranch(record) !== undefined);
    const chosen = options.length === 1 ? options[0]! : stamped.length === 1 ? stamped[0]! : null;
    if (chosen === null) {
      warnings.push(
        options.length === 0
          ? `The IFSC was read as ${miss.read}, ${off}, and RBI’s list has no branch it can be. Check it against the passbook or a cheque, and type it in.`
          : `The IFSC was read as ${miss.read}, ${off}, and RBI’s list has ${options.length} ${options[0]!.bank} branches it could be. Check it against the passbook or a cheque, and type it in.`,
      );
      continue;
    }
    candidates.push({
      key: 'bank.ifsc',
      value: chosen.ifsc,
      // Put right from the list: no surer than the reading it came from.
      confidence: 0.6,
      evidence: miss.evidence,
      line: miss.line,
      verified: false,
      confirmed: false,
      suggestChecked: false,
      correction:
        options.length === 1
          ? `Read as ${miss.read}, ${off}. RBI’s list has one ${chosen.bank} branch it can be: ${chosen.ifsc}, its ${place(chosen)}.`
          : `Read as ${miss.read}, ${off}. RBI’s list has ${options.length} ${chosen.bank} branches it can be; ${chosen.ifsc}, ` +
            `its ${place(chosen)}, is the one printed on this document.`,
    });
    known.set(chosen.ifsc, chosen);
  }

  // ---- IFSC ----------------------------------------------------------------
  for (const ifsc of candidates.filter((candidate) => candidate.key === 'bank.ifsc')) {
    if (!known.has(ifsc.value)) continue;
    const record = known.get(ifsc.value) ?? null;
    if (record === null) {
      warnings.push(notListed(ifsc.value, 'read'));
      continue;
    }

    const branch = has('bank.branch');
    const bank = has('bank.bank_name');
    const verdict = branch === undefined ? null : compareBranch(branch.value, record);
    if (branch !== undefined && verdict === 'other') {
      warnings.push(
        `${ifsc.value} is ${record.bank}’s ${record.branch} branch in RBI’s list, but this document reads "${branch.value}". ` +
          'One of the two was misread — check both against the passbook.',
      );
      continue;
    }
    if (bank !== undefined && !sameBank(bank.value, record)) {
      warnings.push(
        `${ifsc.value} belongs to ${record.bank} in RBI’s list, but this document reads "${bank.value}". ` +
          'One of the two was misread — check both against the passbook.',
      );
      continue;
    }
    if (verdict === 'same') {
      ifsc.agreement = `RBI’s list has ${ifsc.value} as ${describeBranch(record)} — the branch printed beside it.`;
    } else if (branch !== undefined) {
      notes.push(
        `RBI’s list has ${ifsc.value} as ${describeBranch(record)}; this document reads "${branch.value}". ` +
          'If those are different branches, one of the two was misread.',
      );
    } else {
      // No branch labelled: a passbook stamps it under the bank's name instead.
      const stamped = printedBranch(record);
      if (stamped !== undefined) {
        ifsc.agreement = `RBI’s list has ${ifsc.value} as ${describeBranch(record)} — the branch printed on this document (“${stamped}”).`;
      }
    }

    // The page's own MICR code stays; a different one in the list is said.
    const micr = has('bank.micr');
    if (micr !== undefined && micr.listed === undefined && record.micr !== '' && record.micr !== micr.value) {
      notes.push(`RBI’s list gives ${ifsc.value} the MICR code ${record.micr}; this document prints ${micr.value}.`);
    }

    const evidence = `RBI’s list of IFSC codes: ${ifsc.value}`;
    const filled = (
      [
        ['bank.bank_name', record.bank],
        ['bank.branch', record.branch],
        ['bank.micr', record.micr],
        ['bank.branch_address', record.address],
      ] as Array<[FieldKey, string]>
    )
      .filter(([key, value]) => offer(key, value, ifsc, 'ifsc', evidence))
      .map(([key]) => NAMED[key]!);
    if (filled.length > 0) {
      notes.push(`The ${andList(filled)} ${filled.length === 1 ? 'is' : 'are'} from RBI’s list of IFSC codes, for ${ifsc.value}.`);
    }
  }

  // ---- PIN ------------------------------------------------------------------
  for (const pincode of candidates.filter((candidate) => PINCODE_KEY.test(candidate.key))) {
    if (!finds.pins.has(pincode.value)) continue;
    const record = finds.pins.get(pincode.value) ?? null;
    if (record === null) {
      warnings.push(pinNotListed(pincode.value, 'read'));
      continue;
    }

    const section = PINCODE_KEY.exec(pincode.key)![1]!;
    const stateKey = `address.${section}.state` as FieldKey;
    const districtKey = `address.${section}.district` as FieldKey;
    const state = has(stateKey);
    if (state !== undefined && !record.states.includes(canonicalState(state.value))) {
      warnings.push(
        `PIN ${pincode.value} is in ${andList(record.states)} in India Post’s PIN directory, but this document reads "${state.value}". ` +
          'One of the two was misread — check both.',
      );
      continue;
    }

    const evidence = `India Post’s PIN directory: ${pincode.value}`;
    const filled: string[] = [];
    if (record.districts.length === 1 && offer(districtKey, record.districts[0]!, pincode, 'pincode', evidence)) {
      filled.push('district');
    }
    if (record.states.length === 1 && offer(stateKey, record.states[0]!, pincode, 'pincode', evidence)) filled.push('state');
    if (filled.length > 0) {
      notes.push(`The ${filled.join(' and ')} ${filled.length === 1 ? 'is' : 'are'} from India Post’s PIN directory, for ${pincode.value}.`);
    }
    if (has(districtKey) === undefined && record.districts.length > 1) {
      notes.push(`PIN ${pincode.value} covers ${andList(record.districts)}; the district is left for you to choose.`);
    }
  }

  return { ...result, candidates, warnings, notes };
}
