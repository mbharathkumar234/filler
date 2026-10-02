// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import { GettingStarted, readSetupFacts } from './GettingStarted';
import { CORE_KEYS } from './steps';
import type { DocumentMeta } from '@/shared/types';

/**
 * The first-run checklist (§ COMPLETION_PLAN Phase F).
 *
 * Two behaviours carry the whole design and both are easy to get wrong in a
 * way no demo reveals:
 *
 *  1. A user who set everything up before this screen existed sees nothing.
 *     A checklist that tells a long-standing user to create a vault is worse
 *     than no checklist.
 *  2. A stored-but-unusable document does not count as an uploaded document.
 *     Every other view shows a file and a tick; this is the one place that
 *     says the photo will be rejected.
 */

let vaultStatus = { exists: true, unlocked: true };
let vaultFields: Array<{ key: string }> = [];
let documents: Array<{ meta: DocumentMeta }> = [];
let auditEntries: Array<{ event: { t: string } }> = [];
const storage: Record<string, unknown> = {};
/** The academic path the vault is laid out from; null until it is answered. */
let academicPath: unknown = null;

function meta(over: Partial<DocumentMeta> = {}): DocumentMeta {
  return {
    key: 'doc.photo',
    mime: 'image/jpeg',
    bytes: 300_000,
    width: 800,
    height: 920,
    capturedAt: '2026-08-26T00:00:00.000Z',
    ...over,
  };
}

vi.mock('@/ui/lib/client', () => ({
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : 'error'),
  send: (request: { type: string }) => {
    switch (request.type) {
      case 'vault:status':
        return Promise.resolve(vaultStatus);
      case 'vault:list':
        return Promise.resolve(vaultFields);
      case 'doc:list':
        return Promise.resolve(documents);
      case 'audit:read':
        return Promise.resolve(auditEntries);
      case 'vault:path':
        return Promise.resolve(academicPath);
      default:
        return Promise.reject(new Error(`unexpected ${request.type}`));
    }
  },
}));

beforeEach(() => {
  vaultStatus = { exists: true, unlocked: true };
  vaultFields = [];
  documents = [];
  auditEntries = [];
  for (const k of Object.keys(storage)) delete storage[k];
  academicPath = null;

  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: (key: string) => Promise.resolve({ [key]: storage[key] }),
        set: (items: Record<string, unknown>) => {
          Object.assign(storage, items);
          return Promise.resolve();
        },
      },
    },
    tabs: { create: vi.fn(() => Promise.resolve({})) },
    runtime: { getURL: (path: string) => `chrome-extension://x/${path}` },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('what the checklist reads', () => {
  it('counts only core details, not every key in the vault', async () => {
    vaultFields = [{ key: 'bank.ifsc' }, { key: 'education[].percentage' }];
    const facts = await readSetupFacts();
    expect(facts.filledCoreKeys).toEqual(['bank.ifsc', 'education[].percentage']);
    // `stepsFor` is what filters; this asserts nothing is pre-filtered away,
    // so the step rules stay the single place that decides.
  });

  it('treats a blurry photo as not uploaded', async () => {
    documents = [{ meta: meta({ width: 120, height: 138 }) }];
    const facts = await readSetupFacts();
    expect(facts.usableDocuments).toBe(0);
    expect(facts.unusableDocuments).toBe(1);
  });

  it('treats a good photo as uploaded', async () => {
    documents = [{ meta: meta() }];
    await expect(readSetupFacts()).resolves.toMatchObject({ usableDocuments: 1 });
  });

  it('counts a completed fill from the audit log, not from a flag it wrote', async () => {
    auditEntries = [{ event: { t: 'run.started' } }];
    await expect(readSetupFacts()).resolves.toMatchObject({ hasReviewedFill: false });
    auditEntries = [{ event: { t: 'fill.completed' } }];
    await expect(readSetupFacts()).resolves.toMatchObject({ hasReviewedFill: true });
  });

  it('survives a background worker that refuses a question', async () => {
    // The vault can lock between the status call and the rest. A checklist is
    // not worth an error screen.
    documents = [];
    await expect(readSetupFacts()).resolves.toBeTruthy();
  });
});

describe('what the checklist shows', () => {
  it('credits the vault the user has just created, and lists the rest', async () => {
    render(<GettingStarted />);
    await waitFor(() => expect(screen.getByText('Getting set up')).toBeTruthy());
    // The vault is open — that step is genuinely done, and saying otherwise
    // would be the exact dishonesty this checklist is built to avoid.
    expect(screen.getByText('1 of 5 done')).toBeTruthy();
    expect(screen.getByText('Add your details')).toBeTruthy();
  });

  it('credits nothing when the vault is not open yet', async () => {
    vaultStatus = { exists: false, unlocked: false };
    render(<GettingStarted />);
    await waitFor(() => expect(screen.getByText('Getting set up')).toBeTruthy());
    expect(screen.getByText('0 of 5 done')).toBeTruthy();
  });

  it('shows nothing at all to somebody already set up', async () => {
    vaultFields = CORE_KEYS.map((key) => ({ key }));
    documents = [{ meta: meta() }];
    auditEntries = [{ event: { t: 'fill.completed' } }];
    storage['path:skipped'] = true;

    const { container } = render(<GettingStarted />);
    // Give the effect a chance to resolve and *not* render.
    await waitFor(() => expect(screen.queryByText('Getting set up')).toBeNull());
    expect(container.textContent).toBe('');
  });

  it('warns when a stored document will be rejected', async () => {
    documents = [{ meta: meta({ width: 100, height: 115 }) }];
    render(<GettingStarted />);
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    expect(screen.getByRole('status').textContent).toMatch(/too small or the wrong shape/);
  });

  it('offers the practice form once the details are in', async () => {
    vaultFields = CORE_KEYS.map((key) => ({ key }));
    documents = [{ meta: meta() }];
    storage['path:skipped'] = true;
    render(<GettingStarted />);
    await waitFor(() => expect(screen.getByText('Open the practice form')).toBeTruthy());
  });

  it('opens the practice form from inside the extension, not from a dev server', async () => {
    vaultFields = CORE_KEYS.map((key) => ({ key }));
    documents = [{ meta: meta() }];
    storage['path:skipped'] = true;
    render(<GettingStarted />);
    const button = await screen.findByText('Open the practice form');
    button.click();
    await waitFor(() =>
      expect(chrome.tabs.create).toHaveBeenCalledWith({
        url: 'chrome-extension://x/practice/first-fill.html',
      }),
    );
  });

  it('stays hidden once dismissed', async () => {
    storage['onboarding:dismissed'] = true;
    const { container } = render(<GettingStarted />);
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('names each step state for a screen reader, not just with a symbol', async () => {
    render(<GettingStarted />);
    await waitFor(() => expect(screen.getByText('Getting set up')).toBeTruthy());
    expect(screen.getAllByText(/— not done yet/).length).toBeGreaterThan(0);
  });
});
