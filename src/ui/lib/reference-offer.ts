/**
 * What RBI's and India Post's lists add once an IFSC or PIN is saved (§ the
 * vault editor).
 *
 * The user types the code once. The list knows the bank, branch, MICR code and
 * branch address that go with an IFSC, and the district and state a PIN is in.
 * Those are offered for the boxes still empty — never over anything the user
 * typed — and saved only when the user says so. The lists are read by the
 * worker from the extension's own files (`background/reference-data.ts`), so a
 * code looked up goes nowhere.
 *
 * Pure, so it is tested without the panel.
 */

import type { FieldKey } from '@/matching/taxonomy';
import { describeBranch, isIfsc, notListed, type IfscRecord } from '@/reference/ifsc';
import { pinNotListed, type PinRecord } from '@/reference/pincode';
import { canonicalState } from '@/reference/places';

/** A code that was saved, and what its list said of it. */
export type Looked =
  | { list: 'ifsc'; key: FieldKey; code: string; record: IfscRecord | null }
  | { list: 'pincode'; key: FieldKey; code: string; record: PinRecord | null };

export interface ReferenceOffer {
  /** What the list says of the code, or why it has nothing. */
  message: string;
  found: boolean;
  /** The empty boxes the list can fill, and what with. */
  fills: Array<[FieldKey, string]>;
}

const PINCODE_KEY = /^address\.(permanent|correspondence)\.pincode$/;

/** The code to ask about, when a saved value is one: an IFSC in capitals, a PIN without its space. */
export function codeToLookUp(key: FieldKey, value: string): { list: 'ifsc' | 'pincode'; code: string } | null {
  if (key === 'bank.ifsc') {
    const code = value.trim().toUpperCase();
    return isIfsc(code) ? { list: 'ifsc', code } : null;
  }
  if (PINCODE_KEY.test(key)) {
    const pin = value.replace(/\s+/g, '');
    return /^[1-9][0-9]{5}$/.test(pin) ? { list: 'pincode', code: pin } : null;
  }
  return null;
}

/** "Bengaluru Urban and Ramanagara". */
function andList(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** What to say and offer, against the vault as it is now. */
export function offerFor(looked: Looked, values: ReadonlyMap<FieldKey, string>): ReferenceOffer {
  const saved = (key: FieldKey) => (values.get(key) ?? '').trim();

  if (looked.list === 'ifsc') {
    if (looked.record === null) return { message: notListed(looked.code, 'typed'), found: false, fills: [] };
    const record = looked.record;
    const fills = (
      [
        ['bank.bank_name', record.bank],
        ['bank.branch', record.branch],
        ['bank.micr', record.micr],
        ['bank.branch_address', record.address],
      ] as Array<[FieldKey, string]>
    ).filter(([key, value]) => value !== '' && saved(key) === '');
    return { message: `RBI’s list has ${looked.code} as ${describeBranch(record)}.`, found: true, fills };
  }

  if (looked.record === null) return { message: pinNotListed(looked.code, 'typed'), found: false, fills: [] };
  const record = looked.record;
  const section = PINCODE_KEY.exec(looked.key)?.[1] ?? 'permanent';
  const districtKey = `address.${section}.district` as FieldKey;
  const stateKey = `address.${section}.state` as FieldKey;

  const fills: Array<[FieldKey, string]> = [];
  if (record.districts.length === 1 && saved(districtKey) === '') fills.push([districtKey, record.districts[0]!]);
  if (record.states.length === 1 && saved(stateKey) === '') fills.push([stateKey, record.states[0]!]);

  let message =
    `India Post’s PIN directory has ${looked.code} in ${andList(record.districts)}, ${andList(record.states)}` +
    (record.districts.length > 1 ? ' — choose the district yourself.' : '.');
  const state = saved(stateKey);
  if (state !== '' && record.states.length > 0 && !record.states.includes(canonicalState(state))) {
    message += ` The state saved here is “${state}” — one of the two is wrong.`;
  }
  return { message, found: true, fills };
}
