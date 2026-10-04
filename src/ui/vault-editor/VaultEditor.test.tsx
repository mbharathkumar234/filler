// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { VaultEditor } from './VaultEditor';
import type { AcademicPath } from '@/matching/pathway';
import type { IfscRecord } from '@/reference/ifsc';
import type { PinRecord } from '@/reference/pincode';
import type * as Client from '@/ui/lib/client';

/**
 * The vault, laid out from its owner's own education (§ vault structure).
 *
 * Everybody used to get the same seven qualification blocks and every document
 * folder in the catalogue. Now the blocks are the ones the answers imply — and
 * the two rules that make that safe are tested here as well as in
 * `vault-shape.test.ts`: a block holding a value is never hidden, and there is
 * always a way to see the rest.
 */

const STUDENT: AcademicPath = {
  version: 1,
  state: 'karnataka',
  board10: 'cbse',
  afterTen: 'puc',
  stream: 'pcmb',
  now: 'undergraduate',
  degreeFamily: 'engineering',
  course: 'B.E. / B.Tech',
  branch: 'Computer Science Engineering',
  entrance: ['kcet'],
  category: 'st',
  claims: ['371j', 'income'],
};

/* A real public branch code and a real public PIN: neither is anyone's detail. */
const KOLKATA_MAIN: IfscRecord = {
  ifsc: 'SBIN0000001',
  bank: 'State Bank of India',
  branch: 'KOLKATA MAIN',
  address: 'SAMRIDDHI BHAWAN, 1 STRAND ROAD, KOLKATA 700 001',
  city: 'Kolkata',
  district: 'Kolkata',
  state: 'West Bengal',
  micr: '700002021',
};
const GPO: PinRecord = { pin: '560001', states: ['Karnataka'], districts: ['Bengaluru'], offices: ['Bangalore G.P.O.'] };

let stored: { key: string; value: string }[] = [];
let storedPath: AcademicPath | null = null;
const sent: { type: string; path?: AcademicPath | null; key?: string; value?: string }[] = [];

vi.mock('@/ui/lib/client', async () => {
  const actual = await vi.importActual<typeof Client>('@/ui/lib/client');
  return {
    ...actual,
    send: (request: { type: string; path?: AcademicPath | null; key?: string; value?: string }) => {
      sent.push(request);
      if (request.type === 'vault:list') return Promise.resolve(stored);
      if (request.type === 'vault:completeness') {
        return Promise.resolve({ filled: stored.length, total: 60, ratio: stored.length / 60 });
      }
      if (request.type === 'vault:path') return Promise.resolve(storedPath);
      if (request.type === 'vault:set-path') {
        storedPath = request.path ?? null;
        return Promise.resolve(null);
      }
      // The panels below do their own loading; answer with empty lists rather
      // than null, which they would render straight into.
      if (request.type === 'doc:list') return Promise.resolve([]);
      // RBI's and India Post's lists, as the worker answers from them.
      if (request.type === 'ref:ifsc') {
        return Promise.resolve((request as { code?: string }).code === 'SBIN0000001' ? KOLKATA_MAIN : null);
      }
      if (request.type === 'ref:pincode') {
        return Promise.resolve((request as { pin?: string }).pin === '560001' ? GPO : null);
      }
      if (request.type === 'audit:read') return Promise.resolve([]);
      return Promise.resolve(null);
    },
  };
});

beforeEach(() => {
  stored = [];
  storedPath = null;
  sent.length = 0;
});

afterEach(cleanup);

async function open() {
  render(<VaultEditor onLocked={() => {}} />);
  await waitFor(() => expect(screen.getByText('Bank account')).toBeTruthy());
}

describe('a vault nobody has answered for yet', () => {
  it('asks, before anything else', async () => {
    await open();
    expect(screen.getByText('Your education, once')).toBeTruthy();
  });

  it('stores the answers and lays the vault out from them', async () => {
    const user = userEvent.setup();
    await open();

    await user.click(screen.getByRole('button', { name: 'CBSE' }));
    await user.click(screen.getByRole('button', { name: 'ST' }));
    await user.click(screen.getByRole('button', { name: 'Build my vault' }));

    await waitFor(() => expect(screen.queryByText('Your education, once')).toBeNull());
    const write = sent.find((request) => request.type === 'vault:set-path');
    expect(write?.path).toMatchObject({ board10: 'cbse', category: 'st' });
  });

  it('writes the degree it was told into the block a form fills from', async () => {
    const user = userEvent.setup();
    await open();

    await user.click(screen.getByRole('button', { name: 'Reading for a degree' }));
    await user.selectOptions(screen.getByLabelText('Which degree'), 'B.E. / B.Tech');
    await user.selectOptions(
      screen.getByLabelText('Branch or specialisation'),
      'Computer Science Engineering',
    );
    await user.click(screen.getByRole('button', { name: 'Build my vault' }));

    await waitFor(() =>
      expect(
        sent.some(
          (request) =>
            request.type === 'vault:set' &&
            (request as { key?: string }).key === 'education.undergraduate.course',
        ),
      ).toBe(true),
    );
    const branch = sent.find(
      (request) =>
        request.type === 'vault:set' &&
        (request as { key?: string }).key === 'education.undergraduate.branch',
    );
    expect((branch as { value?: string } | undefined)?.value).toBe('Computer Science Engineering');
  });

  it('never writes over a degree the user typed themselves', async () => {
    const user = userEvent.setup();
    stored = [{ key: 'education.undergraduate.course', value: 'B.Tech (typed by hand)' }];
    await open();

    await user.click(screen.getByRole('button', { name: 'Reading for a degree' }));
    await user.selectOptions(screen.getByLabelText('Which degree'), 'B.E. / B.Tech');
    await user.click(screen.getByRole('button', { name: 'Build my vault' }));

    await waitFor(() => expect(screen.queryByText('Your education, once')).toBeNull());
    expect(
      sent.some(
        (request) =>
          request.type === 'vault:set' &&
          (request as { key?: string }).key === 'education.undergraduate.course',
      ),
    ).toBe(false);
  });

  it('shows everything for somebody who skips the questions', async () => {
    const user = userEvent.setup();
    await open();

    await user.click(screen.getByRole('button', { name: 'Skip — show me everything' }));

    await waitFor(() => expect(screen.getByText(/Showing every field/)).toBeTruthy());
    expect(screen.getByText('Doctorate / PhD')).toBeTruthy();
    expect(sent.find((request) => request.type === 'vault:set-path')?.path).toBeNull();
  });
});

describe('a vault with a path stored', () => {
  beforeEach(() => {
    storedPath = STUDENT;
  });

  it('offers the qualifications this person has, and not the four they never took', async () => {
    await open();

    expect(screen.getByText('Class 10 (CBSE)')).toBeTruthy();
    expect(screen.getByText('PUC (Class 12)')).toBeTruthy();
    expect(screen.getByText('Undergraduate degree')).toBeTruthy();

    for (const absent of ['Diploma / Polytechnic', 'Doctorate / PhD', 'Postgraduate degree']) {
      expect(screen.queryByText(absent), absent).toBeNull();
    }
  });

  it('says back what it understood, and can be corrected', async () => {
    const user = userEvent.setup();
    await open();

    expect(screen.getByText(/CBSE Class 10 → PUC/)).toBeTruthy();
    expect(screen.getByText(/KCET · ST · 371\(J\)/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByText('Your education, once')).toBeTruthy();
  });

  it('shows the rest on request, without changing the answers', async () => {
    const user = userEvent.setup();
    await open();

    await user.click(screen.getByRole('button', { name: /Show every field/ }));

    expect(screen.getByText('Doctorate / PhD')).toBeTruthy();
    expect(sent.some((request) => request.type === 'vault:set-path')).toBe(false);
  });

  it('never hides a block that already holds a value', async () => {
    // The clause that makes a wrong answer cost a click, not a record.
    stored = [{ key: 'education.phd.institution', value: 'IISc' }];
    await open();

    expect(screen.getByText('Doctorate / PhD')).toBeTruthy();
  });
});

describe('an IFSC or PIN, once saved', () => {
  const written = () => sent.filter((request) => request.type === 'vault:set').map((request) => [request.key, request.value]);

  async function saveIn(group: string, label: RegExp, value: string) {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('button', { name: new RegExp(group) }));
    await user.type(screen.getByLabelText(label), value);
    await user.click(screen.getByRole('button', { name: `Save ${label.source.replace('^', '')} to vault` }));
    return user;
  }

  it('is looked up, and fills only the boxes still empty — and only when asked', async () => {
    stored = [{ key: 'bank.bank_name', value: 'SBI' }];
    const user = await saveIn('Bank account', /^IFSC code/, 'sbin0000001');

    await screen.findByText('RBI’s list has SBIN0000001 as State Bank of India’s KOLKATA MAIN branch, in Kolkata.');
    expect(written()).toEqual([['bank.ifsc', 'sbin0000001']]);

    await user.click(screen.getByRole('button', { name: 'Fill these in' }));
    await waitFor(() =>
      expect(written()).toEqual([
        ['bank.ifsc', 'sbin0000001'],
        ['bank.branch', 'KOLKATA MAIN'],
        ['bank.micr', '700002021'],
        ['bank.branch_address', 'SAMRIDDHI BHAWAN, 1 STRAND ROAD, KOLKATA 700 001'],
      ]),
    );
    // The bank name the user typed is theirs.
    expect(written().some(([key]) => key === 'bank.bank_name')).toBe(false);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('writes nothing more when the user says not now', async () => {
    const user = await saveIn('Bank account', /^IFSC code/, 'SBIN0000001');
    await screen.findByText(/^RBI’s list has SBIN0000001/);
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByText(/^RBI’s list has/)).toBeNull();
    expect(written()).toEqual([['bank.ifsc', 'SBIN0000001']]);
  });

  it('says so when the list has no such code, and offers nothing', async () => {
    await saveIn('Bank account', /^IFSC code/, 'SBIN0999999');
    await screen.findByText('SBIN0999999 is not in RBI’s list of IFSC codes. Check it against your passbook or a cheque.');
    expect(screen.queryByRole('button', { name: 'Fill these in' })).toBeNull();
  });

  it('offers a PIN’s district and state', async () => {
    const user = await saveIn('Permanent address', /^PIN code/, '560001');
    await screen.findByText('India Post’s PIN directory has 560001 in Bengaluru, Karnataka.');
    await user.click(screen.getByRole('button', { name: 'Fill these in' }));
    await waitFor(() =>
      expect(written()).toEqual([
        ['address.permanent.pincode', '560001'],
        ['address.permanent.district', 'Bengaluru'],
        ['address.permanent.state', 'Karnataka'],
      ]),
    );
  });
});
