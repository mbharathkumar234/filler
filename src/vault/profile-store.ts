/**
 * Profile store (§ Phase 1): CRUD over the taxonomy, with per-key
 * `{value, verifiedAt, source}` provenance.
 *
 * Every function takes the `CryptoKey` explicitly rather than closing over it.
 * That is deliberate: the session (see `session.ts`) is the single owner of the
 * unlocked key, so auto-lock only has to drop one reference, and no store
 * object can outlive the lock holding a copy.
 */

import { FIELD_KEYS, isFieldKey, type FieldKey } from '@/matching/taxonomy';
import { decryptText, encryptText } from './crypto';
import type { ProvenanceSource, StoredProfileRecord, VaultDb } from './db';

/** A decrypted profile entry, as the UI and the matcher see it. */
export interface ProfileEntry {
  key: FieldKey;
  value: string;
  verifiedAt: string;
  source: ProvenanceSource;
}

export interface Completeness {
  filled: number;
  total: number;
  /** 0–1. Drives the completeness meter. */
  ratio: number;
}

export async function setField(
  db: VaultDb,
  cryptoKey: CryptoKey,
  key: FieldKey,
  value: string,
  source: ProvenanceSource = 'user',
): Promise<void> {
  if (!isFieldKey(key)) {
    throw new Error(`Refusing to store an unknown taxonomy key: ${key}`);
  }

  // An empty value is a deletion, not a stored empty string. Keeping empties
  // would make the completeness meter lie and give the matcher blanks to fill.
  if (value === '') {
    await deleteField(db, key);
    return;
  }

  const record: StoredProfileRecord = {
    key,
    sealed: await encryptText(cryptoKey, value),
    verifiedAt: new Date().toISOString(),
    source,
  };
  await db.put('profile', record);
}

export async function getField(
  db: VaultDb,
  cryptoKey: CryptoKey,
  key: FieldKey,
): Promise<ProfileEntry | undefined> {
  const record = await db.get('profile', key);
  if (!record) return undefined;
  return {
    key: record.key,
    value: await decryptText(cryptoKey, record.sealed),
    verifiedAt: record.verifiedAt,
    source: record.source,
  };
}

export async function getAllFields(db: VaultDb, cryptoKey: CryptoKey): Promise<ProfileEntry[]> {
  const records = await db.getAll('profile');
  const entries = await Promise.all(
    records.map(async (record) => ({
      key: record.key,
      value: await decryptText(cryptoKey, record.sealed),
      verifiedAt: record.verifiedAt,
      source: record.source,
    })),
  );
  // Stable taxonomy order, so the editor and review screen never reshuffle.
  const order = new Map(FIELD_KEYS.map((k, i) => [k as string, i]));
  return entries.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
}

export async function deleteField(db: VaultDb, key: FieldKey): Promise<void> {
  await db.delete('profile', key);
}

/** Which keys hold a value, without decrypting any of them. */
export async function storedKeys(db: VaultDb): Promise<FieldKey[]> {
  return db.getAllKeys('profile');
}

/**
 * Blocks that only apply to some people, and so only count once claimed.
 *
 * Nobody holds a diploma *and* an undergraduate degree *and* a postgraduate
 * degree *and* a doctorate, and almost nobody claims a reservation under every
 * heading. Counting all of them against everybody would mean a fully prepared
 * applicant reads "18% complete" forever — a meter that can never be finished
 * is not a meter, it is a reproach.
 *
 * So a conditional block joins the denominator the moment its owner puts
 * anything in it, and is invisible until then. Filling in your Class 12 marks
 * does not make you less complete; it adds a block you have already started.
 */
const CONDITIONAL_PREFIXES: readonly string[] = [
  // The level-less block is nobody's to fill: `matching/qualifications.ts`
  // answers a question that names no qualification from the most recent one.
  // It counts only for a vault that still holds values typed before that.
  'education[].',
  'education.class_10.',
  'education.class_12.',
  'education.diploma.',
  'education.undergraduate.',
  'education.postgraduate.',
  'education.professional_degree.',
  'education.phd.',
  'eligibility.',
];

/**
 * Completeness over the non-document taxonomy. Documents live in Phase 2 and
 * would otherwise drag the meter down before the feature exists.
 */
export async function completeness(db: VaultDb): Promise<Completeness> {
  const stored = new Set(await storedKeys(db));

  const started = new Set(
    CONDITIONAL_PREFIXES.filter((prefix) => [...stored].some((k) => k.startsWith(prefix))),
  );

  const countable = FIELD_KEYS.filter((key) => {
    if (key.startsWith('doc.')) return false;
    const conditional = CONDITIONAL_PREFIXES.find((prefix) => key.startsWith(prefix));
    return conditional === undefined || started.has(conditional);
  });

  const filled = countable.filter((k) => stored.has(k)).length;
  return {
    filled,
    total: countable.length,
    ratio: countable.length === 0 ? 0 : filled / countable.length,
  };
}

/**
 * Write many fields in one transaction — used by import, where a partial
 * restore would leave the vault in a state the user never chose.
 */
export async function setFields(
  db: VaultDb,
  cryptoKey: CryptoKey,
  entries: ReadonlyArray<{ key: FieldKey; value: string; source?: ProvenanceSource }>,
): Promise<void> {
  const records: StoredProfileRecord[] = await Promise.all(
    entries
      .filter((e) => e.value !== '' && isFieldKey(e.key))
      .map(async (e) => ({
        key: e.key,
        sealed: await encryptText(cryptoKey, e.value),
        verifiedAt: new Date().toISOString(),
        source: e.source ?? 'imported',
      })),
  );

  const tx = db.transaction('profile', 'readwrite');
  await Promise.all([...records.map((r) => tx.store.put(r)), tx.done]);
}
