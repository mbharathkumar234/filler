// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { VaultEditor } from './VaultEditor';
import type { AcademicPath } from '@/matching/pathway';
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
