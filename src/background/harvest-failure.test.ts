import { beforeEach, describe, expect, it, vi } from 'vitest';

import { harvestTab } from './harvest-service';

/**
 * Saying why a page could not be read (§ found in use, on a Google Form).
 *
 * ## The bug
 *
 * `requestHarvest` collapsed three different outcomes into `null`:
 *
 *  - no listener in that frame (ordinary — `about:blank` and ad frames)
 *  - the frame answered, with an error (a defect in our own content script)
 *  - the message failed for some other reason
 *
 * All three then produced "No readable frame responded on this page." So a
 * content script that *did* respond, in detail, to say exactly what went wrong
 * had its explanation thrown away and replaced with a sentence saying it had
 * not responded at all.
 *
 * This is the fourth error handler in this codebase found substituting a guess
 * for a report — after `window is not defined`, "Chrome blocks extensions on
 * it", and the reload advice for a lapsed `activeTab`. The pattern is the
 * lesson: a `catch` that discards the reason is a bug the size of whatever it
 * hides.
 */

const REPORT = {
  url: 'https://docs.google.com/forms/d/e/x/viewform',
  title: 'A form',
  fingerprint: 'fp-1',
  fields: [],
  blockers: [],
  wizard: null,
  labelSources: {},
  visibleCount: 0,
  labelledCount: 0,
  dependentSelects: [],
  submit: null,
  humanSteps: [],
};

let sendMessage: (tabId: number, message: unknown, options: unknown) => Promise<unknown>;

beforeEach(() => {
  vi.stubGlobal('chrome', {
    runtime: { id: 'test-extension-id' },
    scripting: {
      executeScript: async () => [{ frameId: 0, result: null }],
    },
    tabs: {
      get: async () => ({ id: 7, url: undefined }),
      sendMessage: (tabId: number, message: unknown, options: unknown) =>
        sendMessage(tabId, message, options),
    },
  });
});

describe('when a frame answers with an error', () => {
  it('reports what the frame actually said', async () => {
    sendMessage = async () => ({ ok: false, error: 'Cannot read properties of null (reading Q)' });

    const result = await harvestTab(7);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Cannot read properties of null');
  });

  it('does not claim nothing responded, because something did', async () => {
    sendMessage = async () => ({ ok: false, error: 'harvest exploded' });

    const result = await harvestTab(7);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toMatch(/nothing on this page answered|no readable frame/i);
  });

  it('surfaces an unexpected send failure rather than swallowing it', async () => {
    sendMessage = async () => {
      throw new Error('The message port closed before a response was received.');
    };

    const result = await harvestTab(7);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('message port closed');
  });
});

describe('when a frame genuinely has no listener', () => {
  it('says so, and gives the remedy that works for it', async () => {
    // Chrome's wording for "nobody is listening". This one really is ordinary,
    // and reloading really does fix it — the content script wires per document.
    sendMessage = async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    };

    const result = await harvestTab(7);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/reload/i);
  });

  it('treats an undefined response the same way', async () => {
    sendMessage = async () => undefined;

    const result = await harvestTab(7);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/reload/i);
  });
});

describe('a frame that works is still read', () => {
  it('does not fail the whole scan because another frame was silent', async () => {
    // The reason silence is tolerated at all: a page with ad frames would
    // otherwise never scan. The top frame's report is what matters.
    vi.stubGlobal('chrome', {
      runtime: { id: 'test-extension-id' },
      scripting: { executeScript: async () => [{ frameId: 0 }, { frameId: 3 }] },
      tabs: {
        get: async () => ({ id: 7, url: undefined }),
        sendMessage: async (_tabId: number, _message: unknown, options: { frameId: number }) => {
          if (options.frameId === 0) return { ok: true, data: REPORT };
          throw new Error('Could not establish connection. Receiving end does not exist.');
        },
      },
    });

    const result = await harvestTab(7);
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
  });
});
