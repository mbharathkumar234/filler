import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WindowProbe, WindowResult } from '@/content/upload-window';
import type { MatchedSlot, TabHarvest } from './harvest-service';
import type { VariantOutcome } from './document-service';
import { REAUTH_IDLE_MS } from '@/runtime/reauth';

/**
 * "Put … in the upload window" — the worker's half.
 *
 * What is tested here is what the worker decides: which frame is the window,
 * what refuses before a document is decrypted, and what is reported. Whether a
 * real window takes the file is `tests/e2e/documents.spec.ts`.
 */

const session = { unlocked: true, authenticatedAt: Date.now() as number | null };
vi.mock('@/vault/session', () => ({
  isUnlocked: () => session.unlocked,
  lastAuthenticatedAt: () => session.authenticatedAt,
  VaultLockedError: class VaultLockedError extends Error {
    constructor() {
      super('The vault is locked.');
    }
  },
}));

let scanned: TabHarvest | null = null;
vi.mock('./harvest-service', () => ({ lastHarvest: () => scanned }));

const fitted: string[] = [];
/** A document whose fitting fails outright, as a decryption error would. */
let brokenKey: string | null = null;
let variant: VariantOutcome = {
  ok: true,
  bytes: new Uint8Array([1, 2, 3]),
  mime: 'image/jpeg',
  width: 276,
  height: 354,
  warnings: [],
  fromCache: false,
  passedThrough: false,
};
vi.mock('./document-service', () => ({
  variantFor: async (key: string) => {
    fitted.push(key);
    if (key === brokenKey) throw new Error('The document could not be read.');
    return variant;
  },
}));

const audited: unknown[] = [];
vi.mock('@/runtime/audit', () => ({
  appendAudit: async (entry: unknown) => {
    audited.push(entry);
    return {};
  },
}));

/** What each frame answers to the probe, and what the chosen one does with the file. */
let frames: { frameId: number; result: WindowProbe }[] = [];
let placement: WindowResult = { placed: true, route: 'file-box' };
const injections: { target: unknown; args?: unknown[]; func: { name: string } }[] = [];

/**
 * The page, as the batch sees it. Each injected function is answered by name,
 * so a scripted page can open a window on "Add file" and close it once the
 * file is in, which is what Google Forms does.
 */
let page: {
  /** `null` is Chrome's answer for a frame that could not run the probe. */
  probe: () => { frameId: number; result: WindowProbe | null }[];
  open: () => string;
  place: () => WindowResult;
  press: () => boolean;
  shows: (label: string, name: string) => boolean;
} = {
  probe: () => frames,
  open: () => 'by caption',
  place: () => placement,
  press: () => false,
  shows: () => false,
};

(globalThis as unknown as { chrome: unknown }).chrome = {
  scripting: {
    executeScript: async (injection: {
      target: { frameIds?: number[] };
      args?: unknown[];
      func: { name: string };
    }) => {
      injections.push(injection);
      const frameId = injection.target.frameIds?.[0] ?? 0;
      switch (injection.func.name) {
        case 'probeUploadWindow':
          return page.probe();
        case 'openUploadWindowWithApproval':
          return [{ frameId, result: page.open() }];
        case 'pressUploadInWindowWithApproval':
          return [{ frameId, result: page.press() }];
        case 'questionShowsFile':
          return [{ frameId, result: page.shows(...(injection.args as [string, string])) }];
        default:
          return [{ frameId, result: page.place() }];
      }
    },
  },
};

const { chooseWindowFrame, putInUploadWindow, uploadAllToWindows } = await import('./upload-window-service');
const { __resetUploadsForTests } = await import('./upload-state');
const { documentOutcomes, __resetReviewForTests } = await import('./review-service');
const { __resetLimitsForTests } = await import('./limits');

function probe(overrides: Partial<WindowProbe>): WindowProbe {
  return {
    top: false,
    fileBoxes: 0,
    dropAreas: 0,
    dialog: false,
    frameOrigins: [],
    origin: 'https://docs.google.com',
    shown: true,
    ...overrides,
  };
}

const PHOTO_SLOT: MatchedSlot = {
  ref: 'u0',
  kind: 'window',
  label: 'Upload your recent passport size photo',
  requirementText: 'Upload 1 supported file: image. Max 10 MB.',
  selectors: ['#add-photo'],
  required: true,
  frameId: 0,
  key: 'doc.photo',
  confidence: 0.81,
  constraint: { mime: [], maxBytes: 10 * 1024 * 1024 },
};

function scan(slots: MatchedSlot[]): TabHarvest {
  return {
    tabId: 7,
    url: 'https://docs.google.com/forms/d/x/viewform',
    title: 'Form',
    frames: [{ frameId: 0 } as TabHarvest['frames'][number]],
    fields: [],
    blockers: [],
    wizard: null,
    fingerprint: 'fp-google',
    visibleCount: 0,
    labelledCount: 0,
    matches: [],
    profileUsed: null,
    profileStale: null,
    sameAsPermanent: null,
    llmNotice: null,
    llmUsed: false,
    profileHealth: null,
    uploadSlots: slots,
    uploadButtons: {},
    documentRules: [],
  };
}

beforeEach(() => {
  session.unlocked = true;
  session.authenticatedAt = Date.now();
  scanned = scan([PHOTO_SLOT]);
  fitted.length = 0;
  brokenKey = null;
  audited.length = 0;
  injections.length = 0;
  frames = [
    { frameId: 0, result: probe({ top: true, dialog: true, frameOrigins: ['https://docs.google.com'] }) },
    { frameId: 12, result: probe({ fileBoxes: 1, dropAreas: 1 }) },
  ];
  placement = { placed: true, route: 'file-box' };
  page = {
    probe: () => frames,
    open: () => 'by caption',
    place: () => placement,
    press: () => false,
    shows: () => false,
  };
  variant = {
    ok: true,
    bytes: new Uint8Array([1, 2, 3]),
    mime: 'image/jpeg',
    width: 276,
    height: 354,
    warnings: [],
    fromCache: false,
    passedThrough: false,
  };
  __resetReviewForTests();
  __resetLimitsForTests();
  __resetUploadsForTests();
});

describe('chooseWindowFrame — which frame is the window the user opened', () => {
  it('picks the frame that appeared after the scan and has somewhere to put a file', () => {
    const choice = chooseWindowFrame(
      [
        { frameId: 0, result: probe({ top: true }) },
        { frameId: 3, result: probe({ fileBoxes: 1 }) },
        { frameId: 12, result: probe({ fileBoxes: 1 }) },
      ],
      new Set([0, 3]),
    );
    expect(choice).toEqual({ ok: true, frameId: 12 });
  });

  it('takes the newest of several windows — the one just opened', () => {
    const choice = chooseWindowFrame(
      [
        { frameId: 0, result: probe({ top: true }) },
        { frameId: 12, result: probe({ fileBoxes: 1 }) },
        { frameId: 13, result: probe({ dropAreas: 1 }) },
      ],
      new Set([0]),
    );
    expect(choice).toEqual({ ok: true, frameId: 13 });
  });

  it('never takes a window that is not on screen', () => {
    const choice = chooseWindowFrame(
      [
        { frameId: 0, result: probe({ top: true }) },
        { frameId: 12, result: probe({ fileBoxes: 1, shown: false }) },
      ],
      new Set([0]),
    );
    expect(choice).toEqual({ ok: false, code: 'no-window' });
  });

  it('uses an open dialog in the top document when there is no frame', () => {
    const choice = chooseWindowFrame(
      [{ frameId: 0, result: probe({ top: true, dialog: true, fileBoxes: 1 }) }],
      new Set([0]),
    );
    expect(choice).toEqual({ ok: true, frameId: 0 });
  });

  it('says so when nothing is open yet', () => {
    const choice = chooseWindowFrame([{ frameId: 0, result: probe({ top: true }) }], new Set([0]));
    expect(choice).toEqual({ ok: false, code: 'no-window' });
  });

  it('names a window on another site it could not look into', () => {
    const choice = chooseWindowFrame(
      [
        {
          frameId: 0,
          result: probe({ top: true, origin: 'https://forms.example.org', frameOrigins: ['https://upload.example.net'] }),
        },
      ],
      new Set([0]),
    );
    expect(choice).toEqual({ ok: false, code: 'foreign-window', origin: 'https://upload.example.net' });
  });

  it('ignores a frame Chrome answered null for — another site’s, or one that threw', () => {
    const choice = chooseWindowFrame(
      [
        { frameId: 0, result: probe({ top: true }) },
        { frameId: 9, result: null },
        { frameId: 12, result: probe({ fileBoxes: 1 }) },
      ],
      new Set([0, 9]),
    );
    expect(choice).toEqual({ ok: true, frameId: 12 });
  });

  it('ignores a frame that did not answer', () => {
    const choice = chooseWindowFrame(
      [
        { frameId: 0, result: probe({ top: true }) },
        { frameId: 12, result: undefined },
      ],
      new Set([0]),
    );
    expect(choice.ok).toBe(false);
  });
});

describe('putInUploadWindow', () => {
  it('fits the document to the question and puts it into the new frame, never pressing anything', async () => {
    const result = await putInUploadWindow(7, 'u0');

    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({ placed: true, route: 'file-box', requirement: '≤ 10 MB' }),
    });
    expect(fitted).toEqual(['doc.photo']);

    const place = injections.at(-1)!;
    expect(place.target).toEqual({ tabId: 7, frameIds: [12] });
    expect(place.args).toEqual(['AQID', 'image/jpeg', 'photo.jpg', 'box']);

    // The review learns it went in, and the audit records which document.
    expect(documentOutcomes(7)).toEqual([
      expect.objectContaining({ ref: 'u0', key: 'doc.photo', route: 'window', attached: true }),
    ]);
    expect(JSON.stringify(audited)).toContain('document.placed');
  });

  it('passes the second try through as a drop', async () => {
    await putInUploadWindow(7, 'u0', 'drop');
    expect(injections.at(-1)?.args?.[3]).toBe('drop');
  });

  it('works from the scan, and does not inject the content script into the open window', async () => {
    await putInUploadWindow(7, 'u0');
    // Two injections, both self-contained functions: a probe, then the placement.
    expect(injections).toHaveLength(2);
    expect(JSON.stringify(injections)).not.toContain('content.js');
  });

  it('refuses before decrypting anything when the vault is locked', async () => {
    session.unlocked = false;
    const result = await putInUploadWindow(7, 'u0');
    expect(result.ok === false && result.code).toBe('VAULT_LOCKED');
    expect(fitted).toEqual([]);
  });

  it('asks for the passphrase again before a high-sensitivity document', async () => {
    scanned = scan([{ ...PHOTO_SLOT, key: 'doc.aadhaar_card', label: 'Upload your Aadhaar card copy' }]);
    session.authenticatedAt = Date.now() - REAUTH_IDLE_MS - 1;

    const result = await putInUploadWindow(7, 'u0');

    expect(result.ok === false && result.code).toBe('REAUTH_REQUIRED');
    expect(fitted).toEqual([]);
    expect(injections).toEqual([]);
  });

  it('asks for a scan first when it has none to work from', async () => {
    scanned = null;
    const result = await putInUploadWindow(7, 'u0');
    expect(result.ok === false && result.code).toBe('NO_SCAN');
  });

  it('refuses a question it cannot place until the user says which document', async () => {
    scanned = scan([{ ...PHOTO_SLOT, key: null }]);
    const result = await putInUploadWindow(7, 'u0');
    expect(result.ok && result.data).toMatchObject({ placed: false, code: 'unknown-slot' });
    expect(fitted).toEqual([]);
  });

  it('uses the document the user picked for a question it could not place', async () => {
    scanned = scan([{ ...PHOTO_SLOT, key: null }]);
    const result = await putInUploadWindow(7, 'u0', 'box', 'doc.pan_card');
    expect(result.ok && result.data.placed).toBe(true);
    expect(fitted).toEqual(['doc.pan_card']);
  });

  it('never lets a pick override what the matcher read', async () => {
    await putInUploadWindow(7, 'u0', 'box', 'doc.aadhaar_card');
    expect(fitted).toEqual(['doc.photo']);
  });

  it('never takes a pick that is not a document', async () => {
    scanned = scan([{ ...PHOTO_SLOT, key: null }]);
    const result = await putInUploadWindow(7, 'u0', 'box', 'id.aadhaar');
    expect(result.ok && result.data.code).toBe('unknown-slot');
    expect(fitted).toEqual([]);
  });

  it('tells the user to open the window first when none is open', async () => {
    frames = [{ frameId: 0, result: probe({ top: true }) }];

    const result = await putInUploadWindow(7, 'u0');

    expect(result.ok && result.data).toMatchObject({ placed: false, code: 'no-window' });
    expect(result.ok && result.data.why).toMatch(/Add file/);
  });

  it('offers the per-site permission for a window on another site', async () => {
    frames = [
      {
        frameId: 0,
        result: probe({ top: true, origin: 'https://forms.example.org', frameOrigins: ['https://upload.example.net'] }),
      },
    ];

    const result = await putInUploadWindow(7, 'u0');

    expect(result.ok && result.data).toMatchObject({
      placed: false,
      code: 'foreign-window',
      origin: 'https://upload.example.net/*',
    });
  });

  it('reports a window that would not take the file, in its own words', async () => {
    placement = { placed: false, why: 'The upload window did not take the file.' };

    const result = await putInUploadWindow(7, 'u0');

    expect(result.ok && result.data).toMatchObject({
      placed: false,
      why: 'The upload window did not take the file.',
    });
    expect(documentOutcomes(7)[0]).toMatchObject({ attached: false, code: 'window-refused' });
    expect(JSON.stringify(audited)).not.toContain('document.placed');
  });

  it('passes on the pipeline’s sentence when the document cannot be made', async () => {
    variant = { ok: false, code: 'no-master', reason: 'No doc.photo has been added to your vault yet.' };

    const result = await putInUploadWindow(7, 'u0');

    expect(result.ok && result.data).toMatchObject({
      placed: false,
      code: 'no-master',
      why: 'No doc.photo has been added to your vault yet.',
    });
    expect(injections).toEqual([]);
  });
});

describe('uploadAllToWindows — one hold, every upload window', () => {
  /** A clock that moves only when the batch waits, so the test takes no time. */
  function fakeClock() {
    let t = 1_000_000;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  }
  const TOKEN = { value: 'tok', expiresAt: Number.MAX_SAFE_INTEGER };
  const tokens = () => TOKEN;

  const AADHAAR_SLOT: MatchedSlot = {
    ...PHOTO_SLOT,
    ref: 'u1',
    label: 'Upload your Aadhaar card copy',
    selectors: ['#add-aadhaar'],
    key: 'doc.aadhaar_card',
  };

  /**
   * A Google-Forms-like page. "Add file" opens a fresh window frame; a file put
   * in it uploads, the window closes, and the form lists the file under its
   * question. `onForm` is what the form shows — the batch's only proof.
   */
  function googleLikePage(
    options: {
      staleHidden?: boolean;
      neverCloses?: boolean;
      neverOpens?: boolean;
      /** Takes the file, closes at once, and answers as if it had not. */
      closesBeforeAnswering?: boolean;
      /** Closes, but the upload never reaches the form. */
      loses?: boolean;
      /** Uploads only after its own Upload is pressed. */
      needsPress?: boolean;
      /** Hides its one window between uploads and shows the same one again, as Google does. */
      reuses?: boolean;
      onForm?: Set<string>;
    } = {},
  ) {
    const onForm = options.onForm ?? new Set<string>();
    let nextFrame = 20;
    let open: number | null = null;
    let hidden: number | null = null;
    let forLabel = '';
    let closesAfter = 0;
    const log: string[] = [];
    const arrive = () => {
      if (!options.loses) onForm.add(forLabel);
    };
    page = {
      probe: () => {
        if (open !== null && closesAfter > 0) {
          closesAfter -= 1;
          if (closesAfter === 0) {
            arrive();
            if (options.reuses) hidden = open;
            open = null;
          }
        }
        const list = [{ frameId: 0, result: probe({ top: true }) }];
        if (options.staleHidden) list.push({ frameId: 11, result: probe({ fileBoxes: 1, shown: false }) });
        if (hidden !== null) list.push({ frameId: hidden, result: probe({ fileBoxes: 1, shown: false }) });
        if (open !== null) list.push({ frameId: open, result: probe({ fileBoxes: 1, dropAreas: 1 }) });
        return list;
      },
      open: () => {
        if (options.neverOpens) return 'by caption';
        if (options.reuses && hidden !== null) {
          open = hidden;
          hidden = null;
          log.push(`open ${open}`);
          return 'by caption';
        }
        open = nextFrame;
        nextFrame += 1;
        log.push(`open ${open}`);
        return 'by caption';
      },
      place: () => {
        log.push(`place ${open}`);
        if (options.closesBeforeAnswering) {
          arrive();
          open = null;
          return { placed: false, why: 'No place for a file was found in the upload window.' };
        }
        if (!options.neverCloses && !options.needsPress) closesAfter = 2;
        return { placed: true, route: 'file-box' };
      },
      press: () => {
        log.push('press');
        if (options.needsPress) closesAfter = 1;
        return true;
      },
      shows: (label: string) => onForm.has(label),
    };
    // Which question the open window belongs to: the one whose Add file was pressed last.
    const open0 = page.open;
    page.open = () => {
      const label = work.shift() ?? '';
      forLabel = label;
      return open0();
    };
    const work: string[] = [];
    return { log, onForm, expect: (labels: string[]) => work.push(...labels) };
  }

  it('does each document in turn, and counts one done only when the form shows it', async () => {
    scanned = scan([PHOTO_SLOT, AADHAAR_SLOT]);
    const form = googleLikePage();
    form.expect([PHOTO_SLOT.label, AADHAAR_SLOT.label]);

    const result = await uploadAllToWindows(7, {}, tokens, fakeClock());

    expect(result.ok && result.data.items.map((i) => [i.ref, i.uploaded])).toEqual([
      ['u0', true],
      ['u1', true],
    ]);
    expect(form.log).toEqual(['open 20', 'place 20', 'open 21', 'place 21']);
    expect([...form.onForm]).toEqual([PHOTO_SLOT.label, AADHAAR_SLOT.label]);
    // Each Add file press names its own question and carries the token.
    const opens = injections.filter((i) => i.func.name === 'openUploadWindowWithApproval');
    expect(opens.map((i) => i.args)).toEqual([
      [PHOTO_SLOT.label, ['#add-photo'], TOKEN],
      [AADHAAR_SLOT.label, ['#add-aadhaar'], TOKEN],
    ]);
  });

  it('asks the form by the question’s caption and the file’s name', async () => {
    const form = googleLikePage();
    form.expect([PHOTO_SLOT.label]);
    await uploadAllToWindows(7, {}, tokens, fakeClock());
    const asks = injections.filter((i) => i.func.name === 'questionShowsFile');
    expect(asks[0]?.args).toEqual([PHOTO_SLOT.label, 'photo.jpg']);
  });

  it('leaves a document that is already on the form, and opens nothing for it', async () => {
    const form = googleLikePage({ onForm: new Set([PHOTO_SLOT.label]) });

    const result = await uploadAllToWindows(7, {}, tokens, fakeClock());

    expect(form.log).toEqual([]);
    expect(result.ok && result.data.items[0]).toMatchObject({ uploaded: true, why: 'Already on the form.' });
  });

  it('uploads again a file the user removed — the form is the truth, not memory', async () => {
    scanned = scan([PHOTO_SLOT]);
    const onForm = new Set<string>();
    const first = googleLikePage({ onForm });
    first.expect([PHOTO_SLOT.label]);
    await uploadAllToWindows(7, {}, tokens, fakeClock());

    onForm.clear(); // The user pressed its ✕.
    const second = googleLikePage({ onForm });
    second.expect([PHOTO_SLOT.label]);
    const again = await uploadAllToWindows(7, {}, tokens, fakeClock());

    expect(second.log).toEqual(['open 20', 'place 20']);
    expect(again.ok && again.data.items[0]?.uploaded).toBe(true);
  });

  it('counts a window that took the file and closed before answering, once the form shows it', async () => {
    scanned = scan([PHOTO_SLOT, AADHAAR_SLOT]);
    const form = googleLikePage({ closesBeforeAnswering: true });
    form.expect([PHOTO_SLOT.label, AADHAAR_SLOT.label]);

    const result = await uploadAllToWindows(7, {}, tokens, fakeClock());

    expect(result.ok && result.data.items.map((i) => i.uploaded)).toEqual([true, true]);
    expect(form.log.filter((entry) => entry.startsWith('open'))).toHaveLength(2);
  });

  it('never reports a window that closed without uploading as a success', async () => {
    const form = googleLikePage({ loses: true });
    form.expect([PHOTO_SLOT.label]);

    const result = await uploadAllToWindows(7, {}, tokens, fakeClock());

    expect(result.ok && result.data.items[0]).toMatchObject({
      uploaded: false,
      why: expect.stringMatching(/does not show the file/),
    });
  });

  it('never mistakes a hidden window left behind by the last upload for the new one', async () => {
    const form = googleLikePage({ staleHidden: true });
    form.expect([PHOTO_SLOT.label]);
    const result = await uploadAllToWindows(7, {}, tokens, fakeClock());
    expect(result.ok && result.data.items[0]?.uploaded).toBe(true);
    expect(form.log).toEqual(['open 20', 'place 20']);
  });

  it('presses the window’s own Upload when it waits for one, once', async () => {
    const form = googleLikePage({ needsPress: true });
    form.expect([PHOTO_SLOT.label]);
    const result = await uploadAllToWindows(7, {}, tokens, fakeClock());
    expect(form.log.filter((entry) => entry === 'press')).toHaveLength(1);
    expect(result.ok && result.data.items[0]?.uploaded).toBe(true);
  });

  it('stops at a window that never finishes, and opens nothing over it', async () => {
    scanned = scan([PHOTO_SLOT, AADHAAR_SLOT]);
    const form = googleLikePage({ neverCloses: true });
    form.expect([PHOTO_SLOT.label, AADHAAR_SLOT.label]);

    const result = await uploadAllToWindows(7, {}, tokens, fakeClock());

    expect(result.ok && result.data.items).toEqual([
      expect.objectContaining({ ref: 'u0', uploaded: false, why: expect.stringMatching(/still open/) }),
      expect.objectContaining({ ref: 'u1', uploaded: false, why: expect.stringMatching(/Not started/) }),
    ]);
    expect(form.log.filter((entry) => entry.startsWith('open'))).toHaveLength(1);
  });

  it('says so when a window never opens, and goes on to the next', async () => {
    scanned = scan([PHOTO_SLOT, AADHAAR_SLOT]);
    googleLikePage({ neverOpens: true });
    const result = await uploadAllToWindows(7, {}, tokens, fakeClock());
    expect(result.ok && result.data.items.map((i) => i.why)).toEqual([
      expect.stringMatching(/did not open/),
      expect.stringMatching(/did not open/),
    ]);
  });

  it('asks for the passphrase before decrypting any document', async () => {
    scanned = scan([PHOTO_SLOT, AADHAAR_SLOT]);
    session.authenticatedAt = Date.now() - REAUTH_IDLE_MS - 1;
    googleLikePage();

    const result = await uploadAllToWindows(7, {}, tokens, fakeClock());

    expect(result.ok === false && result.code).toBe('REAUTH_REQUIRED');
    expect(fitted).toEqual([]);
    expect(injections).toEqual([]);
  });

  it('presses nothing once the approval has lapsed', async () => {
    const form = googleLikePage();
    form.expect([PHOTO_SLOT.label]);
    const result = await uploadAllToWindows(7, {}, () => null, fakeClock());
    expect(result.ok && result.data.items[0]?.uploaded).toBe(false);
    expect(form.log).toEqual([]);
  });

  it('skips a question nobody has named, and uses the user’s pick for one they have', async () => {
    scanned = scan([{ ...PHOTO_SLOT, key: null }, { ...AADHAAR_SLOT, key: null }]);
    const form = googleLikePage();
    form.expect([AADHAAR_SLOT.label]);

    const result = await uploadAllToWindows(7, { u1: 'doc.pan_card' }, tokens, fakeClock());

    expect(result.ok && result.data.items.map((i) => [i.ref, i.uploaded])).toEqual([
      ['u0', false],
      ['u1', true],
    ]);
    expect(fitted).toEqual(['doc.pan_card']);
  });

  it('presses nothing for a question whose Add file has gone', async () => {
    googleLikePage();
    page.open = () => '';
    const result = await uploadAllToWindows(7, {}, tokens, fakeClock());
    expect(result.ok && result.data.items[0]?.why).toMatch(/not on the page/);
  });

  it('uploads every document when the site hides its one window and shows it again', async () => {
    // What Google does, and why every hold used to manage exactly one.
    scanned = scan([PHOTO_SLOT, AADHAAR_SLOT]);
    const form = googleLikePage({ reuses: true });
    form.expect([PHOTO_SLOT.label, AADHAAR_SLOT.label]);

    const result = await uploadAllToWindows(7, {}, tokens, fakeClock());

    expect(result.ok && result.data.items.map((i) => i.uploaded)).toEqual([true, true]);
    expect(form.log).toEqual(['open 20', 'place 20', 'open 20', 'place 20']);
  });

  it('gives up soon after a window closes with nothing on the form, not two minutes later', async () => {
    const clock = fakeClock();
    const form = googleLikePage({ loses: true });
    form.expect([PHOTO_SLOT.label]);
    const began = clock.now();

    await uploadAllToWindows(7, {}, tokens, clock);

    expect(clock.now() - began).toBeLessThan(40_000);
  });

  it('says step by step what happened to a document that did not go', async () => {
    const form = googleLikePage({ loses: true });
    form.expect([PHOTO_SLOT.label]);

    const result = await uploadAllToWindows(7, {}, tokens, fakeClock());
    const trace = (result.ok && result.data.items[0]?.trace) || [];

    expect(trace.join(' | ')).toMatch(
      /pressed Add file.*window 20 opened.*file put in.*window closed.*the form does not show the file/,
    );
  });
});

describe('uploadAllToWindows — a real page’s frames', () => {
  function fakeClock() {
    let t = 1_000_000;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  }
  const tokens = () => ({ value: 'tok', expiresAt: Number.MAX_SAFE_INTEGER });
  const AADHAAR_SLOT: MatchedSlot = {
    ...PHOTO_SLOT,
    ref: 'u1',
    label: 'Upload your Aadhaar card copy',
    selectors: ['#add-aadhaar'],
    key: 'doc.aadhaar_card',
  };

  /**
   * Add file opens a fresh frame; the file goes in, the window closes, and the
   * form shows it under `questions`, in the order their windows open.
   */
  function formWithForeignFrames(questions = [PHOTO_SLOT.label, AADHAAR_SLOT.label]) {
    const onForm = new Set<string>();
    const queue = [...questions];
    let open: number | null = null;
    let label = '';
    let closesAfter = 0;
    let next = 20;
    page = {
      probe: () => {
        if (open !== null && closesAfter > 0 && --closesAfter === 0) {
          onForm.add(label);
          open = null;
        }
        return [
          { frameId: 0, result: probe({ top: true }) },
          // What the crash was: Chrome answers null for a frame it could not run in.
          { frameId: 3, result: null },
          ...(open !== null ? [{ frameId: open, result: probe({ fileBoxes: 1 }) }] : []),
        ];
      },
      open: () => {
        label = queue.shift() ?? '';
        open = next++;
        return 'by caption';
      },
      place: () => {
        closesAfter = 2;
        return { placed: true, route: 'file-box' };
      },
      press: () => false,
      shows: (question) => onForm.has(question),
    };
    return onForm;
  }

  it('uploads every document past a frame Chrome answers null for', async () => {
    scanned = scan([PHOTO_SLOT, AADHAAR_SLOT]);
    const onForm = formWithForeignFrames();

    const result = await uploadAllToWindows(7, {}, tokens, fakeClock());

    expect(result.ok && result.data.items.map((i) => [i.ref, i.uploaded])).toEqual([
      ['u0', true],
      ['u1', true],
    ]);
    expect([...onForm]).toEqual([PHOTO_SLOT.label, AADHAAR_SLOT.label]);
  });

  it('lets one document go wrong without stopping the rest', async () => {
    scanned = scan([PHOTO_SLOT, AADHAAR_SLOT]);
    brokenKey = 'doc.photo';
    // The photo never gets as far as a window, so the Aadhaar card's is the first.
    const onForm = formWithForeignFrames([AADHAAR_SLOT.label]);

    const result = await uploadAllToWindows(7, {}, tokens, fakeClock());

    expect(result.ok && result.data.items).toEqual([
      expect.objectContaining({ ref: 'u0', uploaded: false, why: expect.stringMatching(/went wrong/) }),
      expect.objectContaining({ ref: 'u1', uploaded: true }),
    ]);
    expect([...onForm]).toEqual([AADHAAR_SLOT.label]);
  });
});

