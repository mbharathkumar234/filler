import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocConstraint, FieldDescriptor, MatchResult } from '@/shared/types';
import type { FieldKey } from '@/matching/taxonomy';
import { REAUTH_IDLE_MS } from '@/runtime/reauth';
import type { MatchedSlot, TabHarvest } from './harvest-service';
import type { VariantOutcome } from './document-service';

/**
 * The worker's side of a fill.
 *
 * Two things are tested here and nowhere else, because this is the only place
 * they exist:
 *
 *  - **Which values leave the worker.** Filling a field means putting its value
 *    in the DOM; that is inherent. Shipping the whole vault into a hostile tab
 *    is not, and `buildWrites` is the line between them.
 *  - **What a refill request from inside the page can obtain.** § Phase 6 gave
 *    the content script a way to ask for values again after a postback. The
 *    containment on that is the run authorisation, and a boundary with no test
 *    is a boundary that will be widened by accident.
 */

const session = {
  unlocked: true,
  authenticatedAt: null as number | null,
};

vi.mock('@/vault/session', () => ({
  isUnlocked: () => session.unlocked,
  lastAuthenticatedAt: () => session.authenticatedAt,
  VaultLockedError: class VaultLockedError extends Error {
    constructor() {
      super('The vault is locked. Enter your passphrase to continue.');
    }
  },
  withKey: async (fn: (db: unknown, key: unknown) => Promise<unknown>) => fn({}, {}),
}));

const vaultValues = new Map<string, string>([
  ['identity.full_name', 'Ravi Kumar'],
  ['contact.email', 'ravi@example.com'],
  ['id.aadhaar', '234567890123'],
  ['bank.account_number', '00112233445566'],
]);

vi.mock('@/vault/profile-store', () => ({
  getAllFields: async () => [...vaultValues].map(([key, value]) => ({ key, value })),
}));

vi.mock('@/vault/db', () => ({ openVaultDb: async () => ({ count: async () => 1 }) }));

/** The page as the next harvest will see it. */
let nextHarvest: TabHarvest | null = null;
vi.mock('./harvest-service', () => ({
  harvestTab: async () =>
    nextHarvest ? { ok: true, data: nextHarvest } : { ok: false, error: 'no page' },
}));

/** Every constraint a document was fitted to, and what the pipeline says. */
const fitted: { key: string; constraint: DocConstraint }[] = [];
let variantReply: (key: string) => VariantOutcome = () => ({
  ok: true,
  bytes: new Uint8Array([1, 2, 3]),
  mime: 'image/jpeg',
  width: 276,
  height: 354,
  warnings: [],
  fromCache: false,
  passedThrough: false,
});
vi.mock('./document-service', () => ({
  variantFor: async (key: string, constraint: DocConstraint) => {
    fitted.push({ key, constraint });
    return variantReply(key);
  },
}));

vi.mock('@/runtime/audit', () => ({ appendAudit: async () => ({}) }));

const sent: unknown[] = [];
let tabReply: unknown = { ok: true, data: { records: [], aborted: false, blocked: 0 } };

(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: {
    sendMessage: (_tabId: number, message: unknown) => {
      sent.push(message);
      return Promise.resolve(tabReply);
    },
  },
};

const {
  buildWrites,
  authoriseRun,
  authorisedRun,
  endRun,
  fillTab,
  refillTab,
  MAX_ATTACH_BYTES_PER_FILL,
  RUN_AUTHORISATION_MS,
  __resetRunsForTests,
  unrecognisedUploadsIn,
  liveRunTabs,
  onRunEnded,
} = await import('./fill-service');
const { noteUploaded } = await import('./upload-state');

const NOW = 1_700_000_000_000;

function match(fieldRef: string, key: string, confidence = 0.95): MatchResult {
  return { fieldRef, key: key as FieldKey, confidence, rationale: 'test', source: 'rule' };
}

beforeEach(() => {
  __resetRunsForTests();
  sent.length = 0;
  fitted.length = 0;
  nextHarvest = null;
  variantReply = () => ({
    ok: true,
    bytes: new Uint8Array([1, 2, 3]),
    mime: 'image/jpeg',
    width: 276,
    height: 354,
    warnings: [],
    fromCache: false,
    passedThrough: false,
  });
  session.unlocked = true;
  // The real clock: `refillTab` reads `Date.now()` internally, so a run
  // authorised at a fixed historical timestamp would already have expired.
  session.authenticatedAt = Date.now();
  tabReply = { ok: true, data: { records: [], aborted: false, blocked: 0 } };
});

describe('buildWrites — what leaves the worker', () => {
  const selectors = new Map([
    ['f1', ['#name']],
    ['f2', ['#email']],
  ]);

  it('sends one value per matched field, and nothing else from the vault', () => {
    const { writes } = buildWrites(
      [match('f1', 'identity.full_name')],
      vaultValues,
      new Set(),
      selectors,
    );

    expect(writes).toEqual([{ ref: 'f1', key: 'identity.full_name', value: 'Ravi Kumar' }]);
    // The Aadhaar sat in the same map and was not asked for. It stays put.
    expect(JSON.stringify(writes)).not.toContain('234567890123');
  });

  it('leaves a low-confidence match blank rather than guessing', () => {
    const { writes, skipped } = buildWrites(
      [match('f1', 'identity.full_name', 0.4)],
      vaultValues,
      new Set(),
      selectors,
    );

    expect(writes).toEqual([]);
    expect(skipped).toEqual([{ key: 'identity.full_name', confidence: 0.4 }]);
  });

  it('skips a field the matcher could not identify', () => {
    const { writes } = buildWrites([match('f1', 'unknown')], vaultValues, new Set(), selectors);
    expect(writes).toEqual([]);
  });

  it('skips a key the vault has no value for', () => {
    const { writes } = buildWrites(
      [match('f1', 'identity.middle_name')],
      vaultValues,
      new Set(),
      selectors,
    );
    expect(writes).toEqual([]);
  });

  it('flags a dependent select, so the fill engine waits for its options', () => {
    const { writes } = buildWrites(
      [match('f2', 'contact.email')],
      vaultValues,
      new Set(['email']),
      new Map([['f2', ['#email']]]),
    );
    expect(writes[0]?.dependent).toBe(true);
  });

  it('routes a document key to the document path, not the value path', () => {
    const { writes, documents } = buildWrites(
      [match('f1', 'doc.photo')],
      vaultValues,
      new Set(),
      selectors,
    );
    expect(writes).toEqual([]);
    expect(documents).toEqual([{ ref: 'f1', key: 'doc.photo' }]);
  });

  it('never routes a low-confidence document guess anywhere', () => {
    const { documents, skipped } = buildWrites(
      [match('f1', 'doc.photo', 0.3)],
      vaultValues,
      new Set(),
      selectors,
    );
    expect(documents).toEqual([]);
    expect(skipped).toEqual([{ key: 'doc.photo', confidence: 0.3 }]);
  });
});

// ---------------------------------------------------------------------------
// Documents in a fill
// ---------------------------------------------------------------------------

function field(overrides: Partial<FieldDescriptor> & Pick<FieldDescriptor, 'ref'>): FieldDescriptor {
  return {
    selectors: [`#${overrides.ref}`],
    tag: 'input',
    labelText: '',
    nearbyText: '',
    required: false,
    frameId: 0,
    visible: true,
    enabled: true,
    ...overrides,
  };
}

function page(parts: {
  fields: FieldDescriptor[];
  matches: MatchResult[];
  uploadSlots?: MatchedSlot[];
  documentRules?: TabHarvest['documentRules'];
}): TabHarvest {
  return {
    tabId: 7,
    url: 'https://portal.example.gov.in/apply',
    title: 'Application',
    frames: [],
    fields: parts.fields,
    blockers: [],
    wizard: null,
    fingerprint: 'fp-docs',
    visibleCount: parts.fields.length,
    labelledCount: parts.fields.length,
    matches: parts.matches,
    profileUsed: null,
    profileStale: null,
    sameAsPermanent: null,
    llmNotice: null,
    llmUsed: false,
    profileHealth: null,
    uploadSlots: parts.uploadSlots ?? [],
    uploadButtons: {},
    documentRules: parts.documentRules ?? [],
  };
}

const NAME = field({ ref: 'f1', labelText: 'Full Name' });
const PHOTO = field({
  ref: 'f2',
  tag: 'file',
  type: 'file',
  labelText: 'Upload Photograph',
  requirementText: 'JPEG, 20 KB to 50 KB',
  accept: '.jpg,.jpeg',
  selectors: ['#fuPhoto'],
});

interface ApplyMessage {
  payload: {
    writes: { ref: string; key: string; value: unknown }[];
    plan?: { fields: { fieldRef: string }[]; documents: { fieldRef: string; key: string }[] };
  };
}

function applied(): ApplyMessage['payload'] {
  expect(sent).toHaveLength(1);
  return (sent[0] as ApplyMessage).payload;
}

describe('fillTab — documents ride the same run', () => {
  it('attaches the photo, fitted to what the page says, after every text field', async () => {
    nextHarvest = page({
      fields: [PHOTO, NAME],
      matches: [match('f2', 'doc.photo', 0.81), match('f1', 'identity.full_name')],
    });
    tabReply = {
      ok: true,
      data: {
        records: [
          { ref: 'f1', key: 'identity.full_name', ok: true, attempts: 1 },
          { ref: 'f2', key: 'doc.photo', ok: true, strategy: 'file', attempts: 1 },
        ],
        aborted: false,
        blocked: 0,
      },
    };

    const result = await fillTab(7);

    // The page's own words decide the size, and the box's accept list the format.
    expect(fitted).toEqual([
      { key: 'doc.photo', constraint: expect.objectContaining({ mime: ['image/jpeg'], minBytes: 20 * 1024, maxBytes: 50 * 1024 }) },
    ]);

    const { writes, plan } = applied();
    expect(writes.map((w) => w.ref)).toEqual(['f1', 'f2']);
    expect(writes[1]?.value).toEqual({ base64: 'AQID', mime: 'image/jpeg', filename: 'photo.jpg' });

    // Documents are planned apart from fields, so re-verification never refills one.
    expect(plan?.fields.map((f) => f.fieldRef)).toEqual(['f1']);
    expect(plan?.documents).toEqual([
      expect.objectContaining({ fieldRef: 'f2', key: 'doc.photo' }),
    ]);

    expect(result.ok && result.data.documents).toEqual([
      expect.objectContaining({
        ref: 'f2',
        key: 'doc.photo',
        route: 'file-box',
        attached: true,
        requirement: 'JPEG, 20 KB–50 KB',
        variant: { mime: 'image/jpeg', bytes: 3, width: 276, height: 354, passedThrough: false },
      }),
    ]);
  });

  it('never names the file after the person', async () => {
    nextHarvest = page({ fields: [PHOTO], matches: [match('f2', 'doc.photo', 0.81)] });
    await fillTab(7);
    const value = applied().writes[0]?.value as { filename: string };
    expect(value.filename).toBe('photo.jpg');
    expect(JSON.stringify(sent)).not.toContain('Ravi');
  });

  it('asks for the passphrase before decrypting a high-sensitivity document', async () => {
    const aadhaar = field({ ref: 'f3', tag: 'file', labelText: 'Aadhaar card copy' });
    nextHarvest = page({ fields: [aadhaar], matches: [match('f3', 'doc.aadhaar_card', 0.84)] });
    session.authenticatedAt = Date.now() - REAUTH_IDLE_MS - 1;

    const result = await fillTab(7);

    expect(result.ok === false && result.code).toBe('REAUTH_REQUIRED');
    expect(fitted, 'a document was decrypted before the gate').toEqual([]);
    expect(sent).toEqual([]);
  });

  it('reports a document it could not make, in the pipeline’s words, and still fills the text', async () => {
    nextHarvest = page({
      fields: [NAME, PHOTO],
      matches: [match('f1', 'identity.full_name'), match('f2', 'doc.photo', 0.81)],
    });
    variantReply = () => ({ ok: false, code: 'no-master', reason: 'No doc.photo has been added to your vault yet.' });

    const result = await fillTab(7);

    expect(applied().writes.map((w) => w.ref)).toEqual(['f1']);
    expect(result.ok && result.data.documents).toEqual([
      expect.objectContaining({
        ref: 'f2',
        attached: false,
        code: 'no-master',
        reason: 'No doc.photo has been added to your vault yet.',
      }),
    ]);
  });

  it('reports a page that refused the file, rather than claiming it went in', async () => {
    nextHarvest = page({ fields: [PHOTO], matches: [match('f2', 'doc.photo', 0.81)] });
    tabReply = {
      ok: true,
      data: {
        records: [
          { ref: 'f2', key: 'doc.photo', ok: false, fillFailed: true, reason: 'the file input did not accept the attachment', attempts: 2 },
        ],
        aborted: false,
        blocked: 0,
      },
    };

    const result = await fillTab(7);

    expect(result.ok && result.data.documents[0]).toMatchObject({
      attached: false,
      code: 'page-refused',
      reason: 'The page did not take it: the file input did not accept the attachment.',
    });
  });

  it('never lets a refill from the page carry a document', async () => {
    nextHarvest = page({
      fields: [NAME, PHOTO],
      matches: [match('f1', 'identity.full_name'), match('f2', 'doc.photo', 0.81)],
    });
    await fillTab(7);
    sent.length = 0;

    expect(authorisedRun(7)?.refs.has('f2')).toBe(false);
    const refill = await refillTab(7, ['f2']);
    expect(refill.ok && refill.data.attempted).toBe(0);
    expect(sent).toEqual([]);
  });

  it('drops a document onto a drag-and-drop area that has no file box', async () => {
    const constraint: DocConstraint = { mime: ['image/jpeg'], minBytes: 10 * 1024, maxBytes: 20 * 1024 };
    nextHarvest = page({
      fields: [],
      matches: [],
      uploadSlots: [
        {
          ref: 'u0',
          kind: 'drop',
          label: 'Upload Signature',
          requirementText: 'JPEG, 10 KB to 20 KB',
          selectors: ['#zone'],
          required: true,
          frameId: 0,
          key: 'doc.signature',
          confidence: 0.81,
          constraint,
        },
      ],
    });

    const result = await fillTab(7);

    expect(applied().writes).toEqual([
      { ref: 'u0', key: 'doc.signature', value: expect.objectContaining({ filename: 'signature.jpg' }) },
    ]);
    expect(fitted[0]?.constraint).toMatchObject(constraint);
    expect(result.ok && result.data.documents[0]?.route).toBe('drop');
  });

  it('leaves an upload window to the user — it does not exist until they open it', async () => {
    nextHarvest = page({
      fields: [],
      matches: [],
      uploadSlots: [
        {
          ref: 'u0',
          kind: 'window',
          label: 'Upload your PAN card copy',
          requirementText: 'Max 10 MB.',
          selectors: ['#add'],
          required: true,
          frameId: 0,
          key: 'doc.pan_card',
          confidence: 0.84,
          constraint: { mime: [], maxBytes: 10 * 1024 * 1024 },
        },
      ],
    });

    const result = await fillTab(7);

    expect(fitted).toEqual([]);
    expect(sent).toEqual([]);
    expect(result.ok && result.data.documents).toEqual([]);
  });

  it('does not attach again what the user already uploaded in this run', async () => {
    nextHarvest = page({ fields: [PHOTO], matches: [match('f2', 'doc.photo', 0.81)] });
    noteUploaded(7, 'doc.photo');

    const result = await fillTab(7);

    expect(fitted).toEqual([]);
    expect(result.ok && result.data.documents[0]).toMatchObject({ attached: false, code: 'already-uploaded' });
  });

  it('forgets earlier uploads when the run ends', async () => {
    noteUploaded(7, 'doc.photo');
    endRun(7);
    nextHarvest = page({ fields: [PHOTO], matches: [match('f2', 'doc.photo', 0.81)] });

    await fillTab(7);
    expect(fitted).toHaveLength(1);
  });

  it('uses a constraint the user taught for this box over the page’s words', async () => {
    const taught: DocConstraint = { mime: ['image/png'], maxBytes: 30 * 1024 };
    nextHarvest = page({
      fields: [PHOTO],
      matches: [match('f2', 'doc.photo', 0.81)],
      documentRules: [{ key: 'doc.photo', selectors: ['#fuPhoto'], constraint: taught }],
    });

    await fillTab(7);
    expect(fitted[0]?.constraint).toEqual(taught);
  });

  it('reports a document too big to carry rather than sending an oversized message', async () => {
    nextHarvest = page({ fields: [PHOTO], matches: [match('f2', 'doc.photo', 0.81)] });
    variantReply = () => ({
      ok: true,
      bytes: new Uint8Array(MAX_ATTACH_BYTES_PER_FILL + 1),
      mime: 'application/pdf',
      width: 0,
      height: 0,
      warnings: [],
      fromCache: false,
      passedThrough: true,
    });

    const result = await fillTab(7);

    expect(sent).toEqual([]);
    expect(result.ok && result.data.documents[0]).toMatchObject({ attached: false, code: 'over-budget' });
  });

  it('ignores a document key on something that is not a file box', async () => {
    // The traits veto prevents this; the worker does not rely on it alone.
    const text = field({ ref: 'f4', labelText: 'Photograph reference' });
    nextHarvest = page({ fields: [text], matches: [match('f4', 'doc.photo', 0.81)] });

    const result = await fillTab(7);

    expect(fitted).toEqual([]);
    expect(result.ok && result.data.documents).toEqual([]);
  });
});

describe('the run authorisation that contains a refill', () => {
  it('expires, so a tab left open all afternoon cannot refill itself', () => {
    authoriseRun(7, [{ ref: 'f1', key: 'identity.full_name', value: 'Ravi Kumar' }], NOW);

    expect(authorisedRun(7, NOW + RUN_AUTHORISATION_MS - 1)).not.toBeNull();
    expect(authorisedRun(7, NOW + RUN_AUTHORISATION_MS + 1)).toBeNull();
  });

  it('ends when the run does', () => {
    authoriseRun(7, [{ ref: 'f1', key: 'identity.full_name', value: 'x' }], NOW);
    endRun(7);
    expect(authorisedRun(7, NOW)).toBeNull();
  });

  it('is per tab', () => {
    authoriseRun(7, [{ ref: 'f1', key: 'identity.full_name', value: 'x' }], NOW);
    expect(authorisedRun(9, NOW)).toBeNull();
  });
});

describe('refillTab — a request that comes from inside the page', () => {
  it('refuses outright when no run is in progress', async () => {
    const result = await refillTab(7, ['f1']);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('NO_ACTIVE_RUN');
    expect(sent).toEqual([]);
  });

  it('refuses when the vault is locked', async () => {
    authoriseRun(7, [{ ref: 'f1', key: 'identity.full_name', value: 'x' }]);
    session.unlocked = false;

    const result = await refillTab(7, ['f1']);
    expect(result.ok === false && result.code).toBe('VAULT_LOCKED');
  });

  it('re-sends the values for fields the user already approved', async () => {
    authoriseRun(7, [
      { ref: 'f1', key: 'identity.full_name', value: 'Ravi Kumar' },
      { ref: 'f2', key: 'contact.email', value: 'ravi@example.com' },
    ]);

    const result = await refillTab(7, ['f1', 'f2']);

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).toContain('Ravi Kumar');
  });

  it('ignores refs that were never part of the run', async () => {
    // The containment that matters: a compromised content script asking for a
    // field the user never agreed to fill gets nothing, not a value.
    authoriseRun(7, [{ ref: 'f1', key: 'identity.full_name', value: 'Ravi Kumar' }]);

    const result = await refillTab(7, ['f1', 'f-aadhaar', 'f-bank']);

    expect(result.ok).toBe(true);
    const payload = JSON.stringify(sent);
    expect(payload).toContain('Ravi Kumar');
    expect(payload).not.toContain('234567890123');
    expect(payload).not.toContain('00112233445566');
  });

  it('sends nothing at all when no requested ref is in the plan', async () => {
    authoriseRun(7, [{ ref: 'f1', key: 'identity.full_name', value: 'x' }]);

    const result = await refillTab(7, ['f-aadhaar']);

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.data.attempted).toBe(0);
    expect(sent).toEqual([]);
  });

  it('applies the re-auth gate again — time has passed since the gesture', async () => {
    authoriseRun(7, [{ ref: 'f1', key: 'id.aadhaar', value: '234567890123' }]);
    session.authenticatedAt = Date.now() - REAUTH_IDLE_MS - 1;

    const result = await refillTab(7, ['f1']);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('REAUTH_REQUIRED');
    expect(sent).toEqual([]);
  });

  it('lets an ordinary field through under the same idle clock', async () => {
    authoriseRun(7, [{ ref: 'f1', key: 'identity.full_name', value: 'Ravi Kumar' }]);
    session.authenticatedAt = Date.now() - REAUTH_IDLE_MS - 1;

    const result = await refillTab(7, ['f1']);
    expect(result.ok).toBe(true);
  });

  it('reports a page that did not answer, rather than claiming success', async () => {
    authoriseRun(7, [{ ref: 'f1', key: 'identity.full_name', value: 'x' }]);
    tabReply = undefined;

    const result = await refillTab(7, ['f1']);
    expect(result.ok).toBe(false);
  });
});

describe('upload questions nobody could name (§ test portal)', () => {
  /*
   * A test portal had five required uploads; the extension named three and
   * the panel said "Attached 3 of 3 documents". The other two were never
   * tried, and nothing on screen said they existed.
   */
  const box = (ref: string, labelText: string, frameId = 0) =>
    ({ ref, tag: 'file', labelText, nearbyText: '', frameId }) as never;

  it('lists every file box that no document was matched to', () => {
    const unnamed = unrecognisedUploadsIn(
      {
        fields: [box('f1', 'Upload Recent Photograph'), box('f2', 'Upload Class X Academic Record')],
        uploadSlots: [],
      },
      [{ ref: 'f1' }],
    );
    expect(unnamed).toEqual([{ ref: 'f2', label: 'Upload Class X Academic Record' }]);
  });

  it('still lists a box with no words, rather than saying nothing about it', () => {
    const unnamed = unrecognisedUploadsIn({ fields: [box('f3', '')], uploadSlots: [] }, []);
    expect(unnamed[0]?.label).toBe('An upload box with no label');
  });

  it('counts a drop area nobody could name, and leaves one inside another frame alone', () => {
    const unnamed = unrecognisedUploadsIn(
      {
        fields: [box('f4', 'Upload a file', 3)],
        uploadSlots: [
          { ref: 'u0', kind: 'drop', label: 'Drop supporting files here', key: null } as never,
        ],
      },
      [],
    );
    expect(unnamed).toEqual([{ ref: 'u0', label: 'Drop supporting files here' }]);
  });
});

describe('a run ending hands the page back (§ the guard must not outlive the fill)', () => {
  /*
   * The per-origin document_start script used to stay registered for the rest
   * of the browser session after one fill, and locked the submit buttons of
   * every later page on that host. The worker releases it when the run ends,
   * and it can only do that if every way of ending says so.
   */
  const ended: number[] = [];
  beforeEach(() => {
    ended.length = 0;
    __resetRunsForTests();
    onRunEnded((tabId) => ended.push(tabId));
  });

  it('says so when a run ends on purpose', () => {
    authoriseRun(7, []);
    endRun(7);
    expect(ended).toEqual([7]);
  });

  it('says so when a run simply runs out of time', () => {
    authoriseRun(8, [], 0);
    expect(authorisedRun(8, RUN_AUTHORISATION_MS + 1)).toBeNull();
    expect(ended).toEqual([8]);
  });

  it('says nothing for a tab that had no run, so closing any tab is not an event', () => {
    endRun(9);
    expect(ended).toEqual([]);
  });

  it('lists only the runs still live', () => {
    authoriseRun(10, [], 0);
    authoriseRun(11, [], RUN_AUTHORISATION_MS);
    expect(liveRunTabs(RUN_AUTHORISATION_MS + 1)).toEqual([11]);
  });
});
