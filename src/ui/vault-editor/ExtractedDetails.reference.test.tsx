// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';

import { ExtractedDetails } from './ExtractedDetails';
import { extractFromText } from '@/documents/extract';
import { checkAgainstReference } from '@/documents/reference-check';
import { labelFor } from '@/ui/lib/field-groups';
import type * as Client from '@/ui/lib/client';

/**
 * A passbook whose IFSC was checked against RBI's list (§ reading a document).
 *
 * The list adds what the page did not print, and agrees with what it did. The
 * screen has to keep the two apart from what was read: a MICR code from the
 * list was never on the page, so it is not "read from" anything, and a list
 * that agrees is not a check digit — the user still ticks it.
 */

/* A real public branch code: an IFSC is a branch's address, not anyone's detail. */
const PASSBOOK = 'STATE BANK OF INDIA\nBranch : KOLKATA MAIN\nIFSC : SBIN0000001\nAccount Number : 30123456789';

const extraction = checkAgainstReference(extractFromText(PASSBOOK, { documentKey: 'doc.bank_passbook' }), {
  ifsc: new Map([
    [
      'SBIN0000001',
      {
        ifsc: 'SBIN0000001',
        bank: 'State Bank of India',
        branch: 'KOLKATA MAIN',
        address: 'SAMRIDDHI BHAWAN, 1 STRAND ROAD, KOLKATA 700 001',
        city: 'Kolkata',
        district: 'Kolkata',
        state: 'West Bengal',
        micr: '700002021',
      },
    ],
  ]),
  pins: new Map(),
});

vi.mock('@/ui/lib/client', async () => {
  const actual = await vi.importActual<typeof Client>('@/ui/lib/client');
  return {
    ...actual,
    send: (request: { type: string }) =>
      Promise.resolve(
        request.type === 'doc:extract'
          ? {
              documentType: extraction.documentType,
              candidates: extraction.candidates,
              source: 'pdf-text-layer',
              scripts: extraction.scripts,
              notes: extraction.notes,
              warnings: extraction.warnings,
              text: PASSBOOK,
            }
          : null,
      ),
  };
});

afterEach(cleanup);

async function open() {
  render(
    <ExtractedDetails documentId="doc-1" documentLabel="Bank passbook" onLocked={() => {}} onSaved={() => {}} onClose={() => {}} />,
  );
  await screen.findByText(labelFor('bank.micr'));
}

/** The row a detail is shown in. */
function row(key: Parameters<typeof labelFor>[0]): HTMLElement {
  return screen.getByText(labelFor(key)).closest('li')!;
}

describe('a passbook checked against RBI’s list', () => {
  it('says a value from the list came from the list, not from a line of the page', async () => {
    await open();
    for (const key of ['bank.micr', 'bank.branch_address'] as const) {
      expect(within(row(key)).getByText('From RBI’s list of IFSC codes, for SBIN0000001 — not read off this document.')).toBeTruthy();
      expect(within(row(key)).queryByText(/^Read from/)).toBeNull();
    }
  });

  it('says on the IFSC’s row that the list agrees with the branch printed beside it', async () => {
    await open();
    const ifsc = within(row('bank.ifsc'));
    expect(ifsc.getByText(/^Read from:/)).toBeTruthy();
    expect(
      ifsc.getByText('RBI’s list has SBIN0000001 as State Bank of India’s KOLKATA MAIN branch, in Kolkata — the branch printed beside it.'),
    ).toBeTruthy();
  });

  it('says on a row put right what was read, and what it was put right to', async () => {
    // The same reading, as if its IFSC had been read a character short.
    extraction.candidates = extraction.candidates.map((candidate) =>
      candidate.key === 'bank.ifsc'
        ? { ...candidate, correction: 'Read as SBIN000001, a character short. RBI’s list has one State Bank of India branch it can be: SBIN0000001, its KOLKATA MAIN branch, in Kolkata.' }
        : candidate,
    );
    await open();
    expect(within(row('bank.ifsc')).getByText(/^Read as SBIN000001, a character short\./)).toBeTruthy();
  });

  it('calls none of it a check digit, and ticks none of it', async () => {
    await open();
    expect(screen.queryByText(/Check digit verified/)).toBeNull();
    await waitFor(() => expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(3));
    for (const box of screen.getAllByRole('checkbox')) {
      expect((box as HTMLInputElement).checked).toBe(false);
    }
  });
});
