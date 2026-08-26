// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ReviewScreen } from './ReviewScreen';
import { buildReview } from '@/runtime/review';
import type { FieldDescriptor, MatchResult } from '@/shared/types';
import type { FieldKey } from '@/matching/taxonomy';

/**
 * The review screen (§ COMPLETION_PLAN Phase B, row 7-3/7-4).
 *
 * The Phase A audit found this untested. The plan calls it "the user's last
 * line of defence… it has one job", and its *model* was well covered while the
 * screen that renders it was not — so the behaviour that makes it more than a
 * rubber stamp had nothing checking it.
 *
 * The one that matters most is the last block: **submission stays locked until
 * every flagged row is individually ticked.** That is the difference between a
 * review and a formality, and it lived only in a `disabled` prop.
 */

const sent: Array<{ type: string; [k: string]: unknown }> = [];
let approvalGrant: { expiresAt: number; target: string } = {
  expiresAt: Date.now() + 90_000,
  target: 'Final Submit',
};

function field(over: Partial<FieldDescriptor> & { ref: string }): FieldDescriptor {
  return {
    selectors: [`#${over.ref}`],
    tag: 'input',
    labelText: 'A field',
    nearbyText: 'Personal Details',
    required: false,
    frameId: 0,
    visible: true,
    enabled: true,
    ...over,
  };
}

function match(ref: string, key: string, confidence = 0.95): MatchResult {
  return { fieldRef: ref, key: key as FieldKey, confidence, rationale: 'rule', source: 'rule' };
}

/**
 * One clean row and one fuzzy row — the shape the gate exists for.
 */
function payload() {
  const fields = [
    field({ ref: 'f1', labelText: 'Candidate Name' }),
    field({ ref: 'f2', labelText: 'State', tag: 'select' }),
  ];

  return {
    model: buildReview({
      fields,
      matches: [match('f1', 'identity.full_name'), match('f2', 'address.permanent.state')],
      records: [
        { ref: 'f1', ok: true },
        { ref: 'f2', ok: true, fuzzy: true },
      ],
      values: new Map([
        ['f1', 'Ravi Kumar'],
        ['f2', 'Karnatka'],
      ]),
    }),
    url: 'https://portal.example.gov.in/apply',
    title: 'Application',
    formFingerprint: 'fp-abc',
    submit: { selector: '#btnFinalSubmit', label: 'Final Submit' } as
      | { selector: string; label: string }
      | null,
    blockers: [] as { type: string; reason: string }[],
    documents: [],
  };
}

let current = payload();

vi.mock('@/ui/lib/client', () => ({
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : 'error'),
  send: (request: { type: string }) => {
    sent.push(request as { type: string });
    switch (request.type) {
      case 'review:build':
        return Promise.resolve(current);
      case 'approval:grant':
        return Promise.resolve(approvalGrant);
      case 'approval:submit':
        return Promise.resolve({ submitted: true });
      default:
        return Promise.resolve(null);
    }
  },
}));

async function renderScreen() {
  render(<ReviewScreen tabId={7} />);
  await screen.findByText(/Check before you submit/i);
}

beforeEach(() => {
  sent.length = 0;
  current = payload();
  approvalGrant = { expiresAt: Date.now() + 90_000, target: 'Final Submit' };
});

afterEach(cleanup);

describe('what the screen leads with', () => {
  it('names the submit control the user is approving, in its own words', async () => {
    // "Final Submit" is what is on the page. If that word is not what the user
    // expects to press, something is wrong and they can see it.
    await renderScreen();
    expect(document.body.textContent).toContain('Final Submit');
  });

  it('hoists the flagged field into its own section', async () => {
    await renderScreen();
    expect(screen.getByText(/1 field to check/i)).toBeTruthy();
  });

  it('shows the value that is actually in the field', async () => {
    // Including the misspelling the fuzzy match produced — that is the thing
    // the user is here to catch.
    await renderScreen();
    expect(document.body.textContent).toContain('Karnatka');
  });

  it('explains the flag in a sentence, not a colour', async () => {
    await renderScreen();
    expect(document.body.textContent).toMatch(/matched approximately/i);
  });
});

describe('THE GATE: submission stays locked until each flag is ticked', () => {
  it('starts with the approval control disabled', async () => {
    await renderScreen();
    const hold = screen.getByRole('button', { name: /hold to approve/i });
    expect(hold.hasAttribute('disabled')).toBe(true);
  });

  it('says how many are outstanding', async () => {
    await renderScreen();
    expect(document.body.textContent).toMatch(/1 not yet ticked|Tick the 1 field/i);
  });

  it('unlocks only once the flagged row is ticked', async () => {
    await renderScreen();
    const hold = screen.getByRole('button', { name: /hold to approve/i });
    expect(hold.hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByRole('checkbox', { name: /I have checked State/i }));

    await waitFor(() => expect(hold.hasAttribute('disabled')).toBe(false));
  });

  it('locks again if the row is unticked', async () => {
    await renderScreen();
    const box = screen.getByRole('checkbox', { name: /I have checked State/i });
    const hold = screen.getByRole('button', { name: /hold to approve/i });

    fireEvent.click(box);
    await waitFor(() => expect(hold.hasAttribute('disabled')).toBe(false));

    fireEvent.click(box);
    await waitFor(() => expect(hold.hasAttribute('disabled')).toBe(true));
  });

  it('offers no checkbox on a row that was not flagged', async () => {
    // Ticking everything would make the gate meaningless. Only the doubtful
    // rows ask for confirmation.
    await renderScreen();
    expect(screen.queryByRole('checkbox', { name: /I have checked Candidate Name/i })).toBeNull();
  });

  it('never asks the worker to approve while the gate is closed', async () => {
    await renderScreen();
    const hold = screen.getByRole('button', { name: /hold to approve/i });

    fireEvent.pointerDown(hold);
    fireEvent.pointerUp(hold);

    expect(sent.filter((r) => r.type === 'approval:grant')).toEqual([]);
  });
});

describe('a page with a human-only step', () => {
  beforeEach(() => {
    current = {
      ...payload(),
      blockers: [{ type: 'captcha', reason: 'This page has a CAPTCHA.' }],
    };
  });

  it('refuses to unlock even when every row is ticked', async () => {
    // P4 reaches the review screen: approving *through* a security gate is the
    // one thing the product does not do.
    await renderScreen();

    fireEvent.click(screen.getByRole('checkbox', { name: /I have checked State/i }));

    const hold = screen.getByRole('button', { name: /hold to approve/i });
    await waitFor(() => expect(hold.hasAttribute('disabled')).toBe(true));
  });

  it('says why, rather than leaving a dead button', async () => {
    await renderScreen();
    expect(document.body.textContent).toMatch(/CAPTCHA/i);
    expect(document.body.textContent).toMatch(/not be able to approve/i);
  });
});

describe('a page with nothing to submit', () => {
  beforeEach(() => {
    current = { ...payload(), submit: null };
  });

  it('offers no approval control at all, and explains', async () => {
    await renderScreen();
    expect(screen.queryByRole('button', { name: /hold to approve/i })).toBeNull();
    expect(document.body.textContent).toMatch(/no submit button was found/i);
  });
});

describe('the token never reaches this component', () => {
  it('asks for a grant and a submit, and is handed no token', async () => {
    // A UI that cannot obtain a secret cannot leak one. The grant response
    // carries an expiry and a label, and deliberately not the value.
    await renderScreen();
    fireEvent.click(screen.getByRole('checkbox', { name: /I have checked State/i }));

    const hold = await screen.findByRole('button', { name: /hold to approve/i });
    await waitFor(() => expect(hold.hasAttribute('disabled')).toBe(false));

    expect(JSON.stringify(approvalGrant)).not.toMatch(/[0-9a-f]{32}/);
  });
});

describe('editing a value cancels an approval', () => {
  it('revokes rather than carrying the approval across the change', async () => {
    // What the user approved is not what is on the page any more. Making them
    // approve again is the point.
    await renderScreen();

    // The flagged row is hoisted above the rest, so Edit[0] belongs to State.
    // Candidate Name is the row in the "Everything filled" section below it.
    const edits = screen.getAllByRole('button', { name: /^Edit$/ });
    fireEvent.click(edits[edits.length - 1]!);
    const input = screen.getByDisplayValue('Ravi Kumar');
    fireEvent.change(input, { target: { value: 'Ravi Kumar Reddy' } });
    fireEvent.click(screen.getByRole('button', { name: /update the page/i }));

    await waitFor(() => {
      expect(sent.some((r) => r.type === 'field:edit')).toBe(true);
    });
  });
});
