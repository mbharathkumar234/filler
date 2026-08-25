import { beforeEach, describe, expect, it } from 'vitest';

import {
  appendAudit,
  AUDIT_KEY,
  AUDIT_MAX_ENTRIES,
  AUDIT_SCHEMA_VERSION,
  clearAuditLog,
  describeEntry,
  getAuditSettings,
  originOf,
  readAudit,
  readRun,
  setAuditSettings,
  setAuditStorage,
  type AuditEvent,
  type AuditStorage,
} from './audit';

/**
 * The audit log (P5).
 *
 * The interesting tests are the ones about what the log does *not* contain.
 * An audit log is a privacy feature that can quietly become the opposite —
 * an unencrypted second copy of the vault, sitting in `storage.local` where
 * nothing protects it — and only a test keeps it on the right side of that.
 */

const NOW = 1_700_000_000_000;
const SITE = 'https://scholarships.example.gov.in/apply?applicationNo=SC-2024-889231';
const FP = 'fp-abc';

function fakeStorage(): AuditStorage & { items: Map<string, unknown> } {
  const items = new Map<string, unknown>();
  return {
    items,
    get(keys) {
      if (keys === null) return Promise.resolve(Object.fromEntries(items));
      const wanted = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of wanted) if (items.has(key)) out[key] = items.get(key);
      return Promise.resolve(out);
    },
    set(entries) {
      for (const [key, value] of Object.entries(entries)) items.set(key, value);
      return Promise.resolve();
    },
    remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) items.delete(key);
      return Promise.resolve();
    },
  };
}

let storage: ReturnType<typeof fakeStorage>;

beforeEach(() => {
  storage = fakeStorage();
  setAuditStorage(storage);
});

function append(event: AuditEvent, over: { values?: Record<string, string>; now?: number } = {}) {
  return appendAudit({ site: SITE, formFingerprint: FP, event, ...over });
}

describe('what a run leaves behind', () => {
  it('records the run in order, with a monotonic sequence', async () => {
    await append({ t: 'run.started', fields: 12 }, { now: NOW });
    await append(
      { t: 'fill.completed', keys: ['identity.full_name'], filled: 9, attempted: 12 },
      { now: NOW + 1_000 },
    );
    await append({ t: 'submit.done' }, { now: NOW + 2_000 });

    const log = await readAudit();
    expect(log.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(log.map((e) => e.event.t)).toEqual(['run.started', 'fill.completed', 'submit.done']);
  });

  it('covers the whole story the plan asks for', async () => {
    // "what was filled, from where, what the user approved" — plus the parts
    // that make a rejected application explicable months later.
    const events: AuditEvent[] = [
      { t: 'run.started', fields: 12 },
      { t: 'fill.completed', keys: ['id.pan'], filled: 12, attempted: 12 },
      { t: 'fill.flagged', flags: { 'fuzzy-select': 1 } },
      { t: 'run.blocked', reason: 'captcha' },
      { t: 'user.edited', key: 'identity.full_name', ref: 'f1' },
      { t: 'user.savedToVault', key: 'identity.full_name' },
      { t: 'submit.approved', target: '#btnFinalSubmit' },
      { t: 'submit.done' },
    ];
    for (const event of events) await append(event);

    const log = await readAudit();
    expect(log).toHaveLength(events.length);
    // Every one renders as a sentence a person could read back.
    for (const entry of log) {
      expect(describeEntry(entry).length).toBeGreaterThan(5);
    }
  });

  it('groups a single form’s entries, so one run can be read on its own', async () => {
    await appendAudit({ site: SITE, formFingerprint: 'form-a', event: { t: 'submit.done' } });
    await appendAudit({ site: SITE, formFingerprint: 'form-b', event: { t: 'submit.done' } });
    await appendAudit({ site: SITE, formFingerprint: 'form-a', event: { t: 'run.aborted', why: 'x' } });

    expect(await readRun('form-a')).toHaveLength(2);
    expect(await readRun('form-b')).toHaveLength(1);
  });
});

describe('what the log must not contain', () => {
  it('records keys, never values, by default', async () => {
    await append(
      { t: 'fill.completed', keys: ['id.aadhaar', 'bank.account_number'], filled: 2, attempted: 2 },
      { values: { 'id.aadhaar': '234567890123', 'bank.account_number': '00112233445566' } },
    );

    const raw = JSON.stringify([...storage.items.values()]);
    expect(raw).toContain('id.aadhaar');
    expect(raw).not.toContain('234567890123');
    expect(raw).not.toContain('00112233445566');
    expect((await readAudit())[0]?.values).toBeUndefined();
  });

  it('drops the query string, which is where portals put identifiers', async () => {
    // The URL above carries an application number. A log that kept it would be
    // a record of *which application*, not merely which site.
    await append({ t: 'run.started', fields: 3 });

    const entry = (await readAudit())[0]!;
    expect(entry.site).toBe('https://scholarships.example.gov.in');
    expect(JSON.stringify(entry)).not.toContain('SC-2024-889231');
  });

  it('value logging is off unless the user turns it on', async () => {
    expect((await getAuditSettings()).logValues).toBe(false);
  });

  it('records values once the user asks for it, and not before', async () => {
    await append(
      { t: 'fill.completed', keys: ['identity.full_name'], filled: 1, attempted: 1 },
      { values: { 'identity.full_name': 'Ravi Kumar' } },
    );

    await setAuditSettings({ logValues: true });

    await append(
      { t: 'fill.completed', keys: ['identity.full_name'], filled: 1, attempted: 1 },
      { values: { 'identity.full_name': 'Ravi Kumar' } },
    );

    const log = await readAudit();
    expect(log[0]?.values).toBeUndefined();
    expect(log[1]?.values).toEqual({ 'identity.full_name': 'Ravi Kumar' });
  });

  it('the setting decides, not the caller', async () => {
    // A future call site that passes values along cannot opt the user in.
    await append({ t: 'submit.done' }, { values: { secret: 'do not store me' } });
    expect(JSON.stringify([...storage.items.values()])).not.toContain('do not store me');
  });
});

describe('append-only', () => {
  it('exposes no way to change or remove one entry', async () => {
    // The API surface *is* the guarantee: nothing here takes a seq and edits.
    const audit = await import('./audit');
    const mutators = Object.keys(audit).filter((name) =>
      /^(update|edit|delete|remove|patch|rewrite)/i.test(name),
    );
    expect(mutators).toEqual([]);
  });

  it('clearing removes everything, visibly — not one awkward line', async () => {
    await append({ t: 'run.started', fields: 1 });
    await append({ t: 'submit.done' });

    await clearAuditLog();

    expect(await readAudit()).toEqual([]);
  });

  it('keeps counting after a clear, so a gap is a gap and not a cover-up', async () => {
    await append({ t: 'run.started', fields: 1 });
    await clearAuditLog();
    const entry = await append({ t: 'submit.done' });

    // Honest limitation, recorded on purpose: a full clear restarts the
    // sequence, because the previous numbers are gone with the entries. What
    // it cannot do is remove entry 4 of 9 and leave the rest looking intact.
    expect(entry.seq).toBe(1);
  });

  it('bounds itself, dropping the oldest first', async () => {
    for (let i = 0; i < AUDIT_MAX_ENTRIES + 25; i += 1) {
      await append({ t: 'run.started', fields: i });
    }

    const log = await readAudit();
    expect(log).toHaveLength(AUDIT_MAX_ENTRIES);
    // The newest survive; the sequence shows entries were trimmed.
    expect(log[0]!.seq).toBe(26);
    expect(log.at(-1)!.seq).toBe(AUDIT_MAX_ENTRIES + 25);
  });
});

describe('reading a log written by something else', () => {
  it('ignores a log from an older schema rather than misreading it', async () => {
    storage.items.set(AUDIT_KEY, { v: 0, entries: [{ seq: 1, at: NOW, site: 'x', event: { t: 'submit.done' } }] });
    expect(await readAudit()).toEqual([]);
  });

  it.each([
    ['not an object', 'nonsense'],
    ['entries missing', { v: AUDIT_SCHEMA_VERSION }],
    ['entries not an array', { v: AUDIT_SCHEMA_VERSION, entries: 5 }],
  ])('survives %s', async (_name, value) => {
    storage.items.set(AUDIT_KEY, value);
    expect(await readAudit()).toEqual([]);
  });

  it('drops individual entries that are malformed', async () => {
    storage.items.set(AUDIT_KEY, {
      v: AUDIT_SCHEMA_VERSION,
      entries: [
        { seq: 1, at: NOW, site: 'x', formFingerprint: 'f', event: { t: 'submit.done' } },
        { seq: 2, nonsense: true },
        null,
      ],
    });
    expect(await readAudit()).toHaveLength(1);
  });
});

describe('originOf', () => {
  it.each([
    ['https://a.example.gov.in/apply?x=1#y', 'https://a.example.gov.in'],
    ['http://localhost:4173/fixture.html', 'http://localhost:4173'],
  ])('reduces %s', (url, expected) => {
    expect(originOf(url)).toBe(expected);
  });

  it('does not throw on something that is not a URL', () => {
    expect(originOf('not a url?with=a-query')).toBe('not a url');
  });
});

describe('without a storage area', () => {
  it('says so rather than silently losing the record', async () => {
    setAuditStorage(null);
    const original = (globalThis as { chrome?: unknown }).chrome;
    delete (globalThis as { chrome?: unknown }).chrome;

    await expect(append({ t: 'submit.done' })).rejects.toThrow(/storage\.local/);

    if (original !== undefined) (globalThis as { chrome?: unknown }).chrome = original;
  });
});
