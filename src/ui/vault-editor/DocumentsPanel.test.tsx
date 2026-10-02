// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DocumentsPanel } from './DocumentsPanel';
import { DOCUMENT_GROUPS, DOCUMENT_KEYS, labelFor } from '@/ui/lib/field-groups';
import type * as Client from '@/ui/lib/client';

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

vi.mock('@/ui/lib/client', async () => {
  const actual = await vi.importActual<typeof Client>('@/ui/lib/client');
  return {
    ...actual,
    send: (request: { type: string; key?: string }) => {
      sent.push(request);
      if (request.type === 'doc:list') return Promise.resolve(listing);
      if (request.type === 'doc:preflight') return Promise.resolve({ warnings: [] });
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
