// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DocumentsPanel } from './DocumentsPanel';
import { DOCUMENT_GROUPS, DOCUMENT_KEYS, labelFor } from '@/ui/lib/field-groups';
import type * as Client from '@/ui/lib/client';
import type { DocConstraint } from '@/shared/types';

/** Derive the row's wording rather than restating it — one source of truth. */
const PHOTO_INDEX = DOCUMENT_KEYS.indexOf('doc.photo');
const PHOTO_LABEL = labelFor('doc.photo');
const SAVE_PHOTO = `Save ${PHOTO_LABEL} to vault`;
const DISCARD_PHOTO = `Discard the ${PHOTO_LABEL} you chose`;

/**
 * The one invariant worth a test here: **choosing a file is not saving it.**
 *
 * Before the Save button, picking a file wrote it to the vault immediately.
 * The failure mode that change introduces if it is ever undone is silent — the
 * panel looks identical either way — so the assertion is on the bus, not on
 * the pixels: no `doc:put` until the button is pressed.
 */

const sent: { type: string; key?: string }[] = [];

/** What `doc:list` answers with. Empty unless a test saves something first. */
let listing: unknown[] = [];

/** How long a save takes: at once, unless a test holds it open. */
let putDone: Promise<unknown> = Promise.resolve(null);

/** A portal copy, as `doc:derive` answers: the stored picture, already fitting. */
const DERIVED: Record<string, unknown> = {
  bytes: [0xff, 0xd8, 0xff],
  mime: 'image/jpeg',
  width: 1600,
  height: 1000,
  warnings: [],
  fromCache: false,
  passedThrough: true,
};

/** What each save answers, in turn, when a test scripts it; then `putDone`. */
let putAnswers: unknown[] = [];

/** A clean scan, as `doc:scan` answers: flattened, a little smaller than the photo. */
const SCANNED = {
  bytes: [0xff, 0xd8, 0xff, 0xd9],
  mime: 'image/jpeg',
  width: 1352,
  height: 862,
  flattened: true,
  turned: false,
};

vi.mock('@/ui/lib/client', async () => {
  const actual = await vi.importActual<typeof Client>('@/ui/lib/client');
  return {
    ...actual,
    send: (request: { type: string; key?: string }) => {
      sent.push(request);
      if (request.type === 'doc:list') return Promise.resolve(listing);
      if (request.type === 'doc:preflight') return Promise.resolve({ warnings: [] });
      if (request.type === 'doc:put') return putAnswers.length > 0 ? Promise.resolve(putAnswers.shift()) : putDone;
      if (request.type === 'doc:derive') return Promise.resolve(DERIVED);
      if (request.type === 'doc:scan') return Promise.resolve(SCANNED);
      // A reading that is still going: the panel shows "Reading…" until told.
      if (request.type === 'doc:extract') return new Promise(() => {});
      return Promise.resolve(null);
    },
  };
});

/** A photo comfortably past the intake floor, so no blocker distracts the test. */
function photo(name = 'passport.jpg') {
  return new File([new Uint8Array(120_000)], name, { type: 'image/jpeg' });
}

beforeEach(() => {
  sent.length = 0;
  listing = [];
  putDone = Promise.resolve(null);
  putAnswers = [];
  // jsdom decodes no images; the panel only wants the dimensions.
  vi.stubGlobal('createImageBitmap', () =>
    Promise.resolve({ width: 900, height: 1200, close() {} }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function pickPhoto(file = photo()) {
  const user = userEvent.setup();
  render(<DocumentsPanel onLocked={() => {}} path={null} />);
  await waitFor(() => expect(sent.some((m) => m.type === 'doc:list')).toBe(true));

  const inputs = document.querySelectorAll<HTMLInputElement>('input[type="file"]');
  await user.upload(inputs[PHOTO_INDEX]!, file);
  return user;
}

describe('staged document upload', () => {
  it('writes nothing to the vault when a file is chosen', async () => {
    await pickPhoto();

    await screen.findByRole('button', { name: SAVE_PHOTO });
    expect(sent.filter((m) => m.type === 'doc:put')).toHaveLength(0);
  });

  it('says the file is not saved yet, and names it', async () => {
    await pickPhoto(photo('my-passport-photo.jpg'));

    expect(await screen.findByText(/not saved/i)).toBeTruthy();
    expect(screen.getByText('my-passport-photo.jpg')).toBeTruthy();
  });

  it('writes it once Save is pressed', async () => {
    const user = await pickPhoto();
    const save = await screen.findByRole('button', { name: SAVE_PHOTO });

    await user.click(save);

    await waitFor(() => {
      const puts = sent.filter((m) => m.type === 'doc:put');
      expect(puts).toHaveLength(1);
      expect(puts[0]!.key).toBe('doc.photo');
    });
  });

  it('discards a staged pick without touching the vault', async () => {
    const user = await pickPhoto();
    const discard = await screen.findByRole('button', { name: DISCARD_PHOTO });

    await user.click(discard);

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: SAVE_PHOTO })).toBeNull(),
    );
    expect(sent.filter((m) => m.type === 'doc:put')).toHaveLength(0);
  });

  it('assesses the staged file, so a blocker is raised before it is stored', async () => {
    vi.stubGlobal('createImageBitmap', () =>
      Promise.resolve({ width: 40, height: 50, close() {} }),
    );

    await pickPhoto();

    expect(await screen.findByText(/too small/i)).toBeTruthy();
    expect(sent.filter((m) => m.type === 'doc:put')).toHaveLength(0);
  });
});

/**
 * Forty-odd slots, in folders.
 *
 * A collapsed folder must still hold its slots in the page: a `details` that
 * rendered nothing until it was opened would hide a document from the
 * browser's own search, and from anyone reading the panel with a screen
 * reader — which is how a slot stops being found at all.
 */
describe('the document folders', () => {
  it('shows every folder, and keeps a closed one’s slots in the page', async () => {
    render(<DocumentsPanel onLocked={() => {}} path={null} />);
    await waitFor(() => expect(screen.getByText(PHOTO_LABEL)).toBeTruthy());

    for (const group of DOCUMENT_GROUPS) {
      expect(screen.getByText(group.title), group.title).toBeTruthy();
    }

    const optional = DOCUMENT_GROUPS.find((group) => group.optional === true)!;
    const hidden = optional.keys[0]!;
    expect(screen.getByText(labelFor(hidden))).toBeTruthy();
  });

  it('counts what is added in each folder, so a gap is visible without opening it', async () => {
    render(<DocumentsPanel onLocked={() => {}} path={null} />);
    const photos = DOCUMENT_GROUPS[0]!;
    await waitFor(() =>
      expect(screen.getByText(`— 0 of ${photos.keys.length} added`)).toBeTruthy(),
    );
  });
});

describe('reading a document', () => {
  /*
   * A face photograph has nothing printed on it. Offering to read one is an
   * offer to spend five seconds recognising nothing and then say so.
   */
  it('offers no reading of a photograph, and offers it for a marks card', async () => {
    const saved = [
      { id: 'a', key: 'doc.photo', meta: { key: 'doc.photo', mime: 'image/jpeg', bytes: 120_000 } },
      {
        id: 'b',
        key: 'doc.marksheet_10',
        meta: { key: 'doc.marksheet_10', mime: 'image/jpeg', bytes: 400_000 },
      },
    ];
    listing = saved;

    render(<DocumentsPanel onLocked={() => {}} path={null} />);
    await waitFor(() => expect(sent.some((m) => m.type === 'doc:list')).toBe(true));

    // Both documents are in the panel — so the single Read button below is
    // the marks card's, not an artefact of one row failing to render.
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Preview for this portal' })).toHaveLength(2),
    );
    expect(screen.getAllByRole('button', { name: 'Read details from this' })).toHaveLength(1);
  });
});

describe('reading a document that is being replaced', () => {
  /*
   * Found by driving the real extension: a new file was saved over a stored
   * marks card and "Read details from this" pressed before the save finished.
   * The reading started on the copy being replaced; the save gave the slot a
   * new document, the reading's panel vanished with the old one, and nothing
   * on the screen said what had happened.
   */
  const CARD = 'doc.marksheet_10' as const;
  const CARD_INDEX = DOCUMENT_KEYS.indexOf(CARD);
  const stored = (id: string) => ({ id, key: CARD, meta: { key: CARD, mime: 'image/jpeg', bytes: 400_000 } });
  const extracts = () => sent.filter((m) => m.type === 'doc:extract').map((m) => (m as { id?: string }).id);

  async function withStoredCard() {
    const user = userEvent.setup();
    listing = [stored('old')];
    render(<DocumentsPanel onLocked={() => {}} path={null} />);
    await screen.findByRole('button', { name: 'Read details from this' });
    return user;
  }

  async function stageReplacement(user: ReturnType<typeof userEvent.setup>) {
    const inputs = document.querySelectorAll<HTMLInputElement>('input[type="file"]');
    await user.upload(inputs[CARD_INDEX]!, photo('new-card.jpg'));
    return screen.findByRole('button', { name: `Save ${labelFor(CARD)} to vault` });
  }

  it('cannot be read while the new copy is still being saved', async () => {
    const user = await withStoredCard();
    let finish!: (value: unknown) => void;
    putDone = new Promise((resolve) => (finish = resolve));

    await user.click(await stageReplacement(user));
    const read = screen.getByRole('button', { name: 'Read details from this' }) as HTMLButtonElement;
    expect(read.disabled).toBe(true);
    await user.click(read);
    expect(extracts()).toEqual([]);

    listing = [stored('new')];
    finish(stored('new'));
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Read details from this' }) as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it('follows its slot when the document is replaced, and reads the new one', async () => {
    const user = await withStoredCard();
    await user.click(screen.getByRole('button', { name: 'Read details from this' }));
    await waitFor(() => expect(extracts()).toEqual(['old']));

    listing = [stored('new')];
    await user.click(await stageReplacement(user));

    // The panel stays open, and what it reads is the document now in the slot.
    await waitFor(() => expect(extracts()).toEqual(['old', 'new']));
    expect(screen.getByRole('heading', { name: `Details found in ${labelFor(CARD)}` })).toBeTruthy();
  });
});

describe('a PDF that opens only with a password', () => {
  /*
   * An e-Aadhaar is downloaded locked. The worker says so when it is saved, and
   * saves nothing; the panel asks for the password and tries again with it.
   * The user types it — the vault could build an e-Aadhaar's password from the
   * name and birth year it holds, and that was offered and turned down.
   */
  const AADHAAR = 'doc.aadhaar_card' as const;
  const AADHAAR_INDEX = DOCUMENT_KEYS.indexOf(AADHAAR);
  const SAVE = `Save ${labelFor(AADHAAR)} to vault`;
  // As the worker answers for a locked PDF it saved: `locked: true` — which is
  // not the "not saved, needs a password" answer, and must not be taken for it.
  const saved = {
    id: 'new',
    key: AADHAAR,
    locked: true,
    meta: { key: AADHAAR, mime: 'application/pdf', bytes: 1726, width: 0, height: 0 },
  };
  const puts = () => sent.filter((m) => m.type === 'doc:put') as Array<{ password?: string }>;

  async function saveLockedPdf() {
    const user = userEvent.setup();
    render(<DocumentsPanel onLocked={() => {}} path={null} />);
    await waitFor(() => expect(sent.some((m) => m.type === 'doc:list')).toBe(true));
    const inputs = document.querySelectorAll<HTMLInputElement>('input[type="file"]');
    await user.upload(inputs[AADHAAR_INDEX]!, new File([new Uint8Array(1726)], 'e-aadhaar.pdf', { type: 'application/pdf' }));
    await user.click(await screen.findByRole('button', { name: SAVE }));
    return user;
  }

  it('asks for the password, and saves nothing until it opens the file', async () => {
    putAnswers = [{ notSaved: 'needs-password' }, saved];
    const user = await saveLockedPdf();

    const field = await screen.findByLabelText('Password for this PDF');
    // Nothing is in the vault yet, and the file waits where it was.
    expect(screen.getByText(/Ready to save/)).toBeTruthy();
    expect(puts()).toEqual([expect.not.objectContaining({ password: expect.anything() })]);

    await user.type(field, 'RAVI1998');
    listing = [saved];
    await user.click(screen.getByRole('button', { name: 'Unlock and save' }));

    await waitFor(() => expect(puts().map((m) => m.password)).toEqual([undefined, 'RAVI1998']));
    await waitFor(() => expect(screen.queryByLabelText('Password for this PDF')).toBeNull());
  });

  it('says when the password did not open it, and asks again', async () => {
    putAnswers = [{ notSaved: 'needs-password' }, { notSaved: 'wrong-password' }];
    const user = await saveLockedPdf();

    await user.type(await screen.findByLabelText('Password for this PDF'), 'ravi1998');
    await user.click(screen.getByRole('button', { name: 'Unlock and save' }));

    expect(await screen.findByText(/did not open it/i)).toBeTruthy();
    // Typed again from nothing, rather than corrected in a box nobody can see into.
    expect((screen.getByLabelText('Password for this PDF') as HTMLInputElement).value).toBe('');
  });

  it('tells an e-Aadhaar’s owner what its password is made of', async () => {
    putAnswers = [{ notSaved: 'needs-password' }];
    await saveLockedPdf();
    expect(await screen.findByText(/first four letters of your name/i)).toBeTruthy();
  });

  it('forgets the file and the password when the user discards it', async () => {
    putAnswers = [{ notSaved: 'needs-password' }];
    const user = await saveLockedPdf();
    await user.type(await screen.findByLabelText('Password for this PDF'), 'RAVI1998');

    await user.click(screen.getByRole('button', { name: `Discard the ${labelFor(AADHAAR)} you chose` }));

    await waitFor(() => expect(screen.queryByLabelText('Password for this PDF')).toBeNull());
    expect(puts()).toHaveLength(1);
  });
});

describe('previewing a document for a portal', () => {
  /*
   * Found on the user's own bank passbook: the preview turned it into a
   * passport photo. The panel previewed every document against one example
   * requirement — a passport photo's, 3.5 x 4.5 cm — so the passbook was cut
   * down the middle to that shape and shown as a 64-pixel thumbnail. Each kind
   * of document is now previewed against an example for its kind, until the
   * portal's own requirement is pasted.
   */
  const stored = (key: string) => ({
    id: key,
    key,
    meta: { key, mime: 'image/jpeg', bytes: 88_000, width: 1600, height: 1000 },
  });
  const derives = () =>
    sent.filter((m) => m.type === 'doc:derive') as unknown as Array<{ key: string; constraint: DocConstraint }>;

  beforeEach(() => {
    // jsdom has no object URLs; the panel only needs one to show.
    Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:preview', configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true });
  });

  async function preview(key: string) {
    const user = userEvent.setup();
    listing = [stored(key)];
    render(<DocumentsPanel onLocked={() => {}} path={null} />);
    await user.click(await screen.findByRole('button', { name: 'Preview for this portal' }));
    await waitFor(() => expect(derives()).toHaveLength(1));
    return user;
  }

  it('previews a bank passbook as a document, not as a passport photo', async () => {
    await preview('doc.bank_passbook');
    const { constraint } = derives()[0]!;
    expect(constraint.dimensionsMm).toBeUndefined();
    expect(constraint.mime).toEqual(expect.arrayContaining(['image/jpeg', 'application/pdf']));
    expect(constraint.maxBytes).toBe(500 * 1024);
  });

  it('previews a photograph against a passport photo', async () => {
    await preview('doc.photo');
    expect(derives()[0]!.constraint.dimensionsMm).toEqual([35, 45]);
  });

  it('says the requirement it used is an example, until the portal’s own is pasted', async () => {
    await preview('doc.bank_passbook');
    expect(await screen.findByText(/an example for this kind of document/i)).toBeTruthy();
  });

  it('uses the requirement pasted for a portal, for every document', async () => {
    const user = userEvent.setup();
    listing = [stored('doc.bank_passbook')];
    render(<DocumentsPanel onLocked={() => {}} path={null} />);
    await user.type(await screen.findByLabelText(/Portal requirement/), 'PDF only, up to 200 KB');
    await user.click(await screen.findByRole('button', { name: 'Preview for this portal' }));

    await waitFor(() => expect(derives()).toHaveLength(1));
    expect(derives()[0]!.constraint).toMatchObject({ mime: ['application/pdf'], maxBytes: 200 * 1024 });
    expect(screen.queryByText(/an example for this kind of document/i)).toBeNull();
  });

  it('says how many pages a PDF copy has, so a page left out would show', async () => {
    Object.assign(DERIVED, { mime: 'application/pdf', pages: 3, passedThrough: false });
    try {
      await preview('doc.marksheet_12');
      expect(await screen.findByText(/3 pages/)).toBeTruthy();
    } finally {
      Object.assign(DERIVED, { mime: 'image/jpeg', passedThrough: true });
      delete DERIVED.pages;
    }
  });

  it('offers the preview at full size, since a thumbnail of a page shows nothing', async () => {
    await preview('doc.bank_passbook');
    const link = await screen.findByRole('link', { name: /full size/i });
    expect(link.getAttribute('href')).toBe('blob:preview');
  });
});

describe('a photo made a clean scan', () => {
  /*
   * PaddleOCR's UVDoc flattens a page photographed curled or on a table; the
   * light is evened out after. The scan is shown, and staged as if the user
   * had chosen it — the stored photo is replaced only by their own Save.
   */
  const CARD = 'doc.marksheet_10' as const;
  const card = { id: 'card-1', key: CARD, meta: { key: CARD, mime: 'image/jpeg', bytes: 400_000, width: 1352, height: 922 } };

  it('offers a clean scan of a photographed document — not of a face photo, nor of a PDF', async () => {
    listing = [
      card,
      { id: 'p', key: 'doc.photo', meta: { key: 'doc.photo', mime: 'image/jpeg', bytes: 120_000 } },
      { id: 'a', key: 'doc.aadhaar_card', meta: { key: 'doc.aadhaar_card', mime: 'application/pdf', bytes: 90_000 } },
    ];
    render(<DocumentsPanel onLocked={() => {}} path={null} />);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Preview for this portal' })).toHaveLength(3),
    );
    expect(screen.getAllByRole('button', { name: 'Make a clean scan' })).toHaveLength(1);
  });

  it('makes the scan when asked, shows it, and saves it only when the user does', async () => {
    const user = userEvent.setup();
    listing = [card];
    render(<DocumentsPanel onLocked={() => {}} path={null} />);
    await user.click(await screen.findByRole('button', { name: 'Make a clean scan' }));

    expect(sent.filter((m) => m.type === 'doc:scan')).toEqual([{ type: 'doc:scan', id: 'card-1' }]);
    expect(await screen.findByRole('img', { name: `The clean scan of the ${labelFor(CARD)}` })).toBeTruthy();
    expect(screen.getByText(/flattened/i)).toBeTruthy();
    expect(screen.getByText('clean-scan.jpg')).toBeTruthy();
    expect(sent.filter((m) => m.type === 'doc:put')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: `Save ${labelFor(CARD)} to vault` }));
    await waitFor(() => {
      const puts = sent.filter((m) => m.type === 'doc:put') as Array<{ key?: string; bytes?: number[]; mime?: string }>;
      expect(puts).toHaveLength(1);
      expect(puts[0]).toMatchObject({ key: CARD, mime: 'image/jpeg', bytes: SCANNED.bytes });
    });
  });

  it('lets the scan go without touching the stored photo', async () => {
    const user = userEvent.setup();
    listing = [card];
    render(<DocumentsPanel onLocked={() => {}} path={null} />);
    await user.click(await screen.findByRole('button', { name: 'Make a clean scan' }));
    await user.click(await screen.findByRole('button', { name: `Discard the ${labelFor(CARD)} you chose` }));
    await waitFor(() => expect(screen.queryByRole('img', { name: /clean scan/ })).toBeNull());
    expect(sent.filter((m) => m.type === 'doc:put')).toHaveLength(0);
  });
});
