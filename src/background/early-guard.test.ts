import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  grantedOrigins,
  hasPermission,
  originPattern,
  register,
  requestPermission,
  revokePermission,
  statusFor,
  syncFor,
  unregister,
  unregisterAll,
} from './early-guard';

/**
 * The early guard (§ COMPLETION_PLAN Phase B).
 *
 * The behaviour under test is mostly about **not** doing things: not
 * registering without permission, not offering to protect a page that cannot
 * be scripted, not leaving a registration behind when the permission goes.
 *
 * A standing content script the user did not authorise, or one they cannot
 * see and withdraw, would be a worse outcome than the hole this closes.
 */

const granted = new Set<string>();
const registered = new Map<string, { id: string; matches: string[]; runAt: string }>();
let requestAnswer = true;
let registerThrows = false;

(globalThis as unknown as { chrome: unknown }).chrome = {
  permissions: {
    contains: ({ origins }: { origins: string[] }) =>
      Promise.resolve(origins.every((o) => granted.has(o))),
    request: ({ origins }: { origins: string[] }) => {
      if (requestAnswer) for (const o of origins) granted.add(o);
      return Promise.resolve(requestAnswer);
    },
    remove: ({ origins }: { origins: string[] }) => {
      for (const o of origins) granted.delete(o);
      return Promise.resolve(true);
    },
    getAll: () => Promise.resolve({ origins: [...granted] }),
  },
  scripting: {
    registerContentScripts: (scripts: Array<{ id: string; matches: string[]; runAt: string }>) => {
      if (registerThrows) return Promise.reject(new Error('no host permission'));
      for (const s of scripts) registered.set(s.id, s);
      return Promise.resolve();
    },
    unregisterContentScripts: ({ ids }: { ids?: string[] } = {}) => {
      for (const id of ids ?? [...registered.keys()]) registered.delete(id);
      return Promise.resolve();
    },
    getRegisteredContentScripts: ({ ids }: { ids?: string[] } = {}) =>
      Promise.resolve(
        ids ? [...registered.values()].filter((s) => ids.includes(s.id)) : [...registered.values()],
      ),
  },
};

const PORTAL = 'https://portal.example.gov.in/apply?id=SC2024';
const PATTERN = 'https://portal.example.gov.in/*';

beforeEach(() => {
  granted.clear();
  registered.clear();
  requestAnswer = true;
  registerThrows = false;
});

describe('which pages can be protected at all', () => {
  it.each([
    ['https://portal.example.gov.in/apply?id=1', 'https://portal.example.gov.in/*'],
    ['http://localhost:4173/form.html', 'http://localhost/*'],
  ])('reduces %s to an origin pattern', (url, expected) => {
    expect(originPattern(url)).toBe(expected);
  });

  it('drops the path and query, so a grant is for the site, not one form', () => {
    // A per-URL grant would ask the user again on every step of a wizard.
    expect(originPattern(PORTAL)).toBe(PATTERN);
    expect(originPattern(PORTAL)).not.toContain('SC2024');
  });

  it.each([
    'chrome://extensions',
    'chrome-extension://abc/panel.html',
    'file:///C:/form.html',
    'about:blank',
    'not a url',
  ])('refuses %s, which cannot be scripted anyway', (url) => {
    expect(originPattern(url)).toBeNull();
  });

  it('reports an unscriptable page as neither granted nor registered', async () => {
    expect(await statusFor('chrome://extensions')).toEqual({
      origin: '',
      granted: false,
      registered: false,
    });
  });
});

describe('nothing is registered without permission', () => {
  it('refuses to register an origin the user has not granted', async () => {
    expect(await register(PATTERN)).toBe(false);
    expect(registered.size).toBe(0);
  });

  it('registers once the user grants it', async () => {
    await requestPermission(PATTERN);
    expect(await register(PATTERN)).toBe(true);
    expect(registered.size).toBe(1);
  });

  it('registers at document_start, which is the entire point', async () => {
    await requestPermission(PATTERN);
    await register(PATTERN);

    const script = [...registered.values()][0]!;
    expect(script.runAt).toBe('document_start');
    expect(script.matches).toEqual([PATTERN]);
  });

  it('registers for that origin and no other', async () => {
    await requestPermission(PATTERN);
    await register(PATTERN);

    const script = [...registered.values()][0]!;
    expect(script.matches).not.toContain('<all_urls>');
    expect(script.matches).not.toContain('*://*/*');
  });

  it('does not register twice for the same origin', async () => {
    await requestPermission(PATTERN);
    await register(PATTERN);
    await register(PATTERN);

    expect(registered.size).toBe(1);
  });

  it('reports failure rather than throwing when Chrome refuses', async () => {
    await requestPermission(PATTERN);
    registerThrows = true;

    expect(await register(PATTERN)).toBe(false);
  });
});

describe('the user can take it back', () => {
  it('unregisters the script when the permission is revoked', async () => {
    await requestPermission(PATTERN);
    await register(PATTERN);
    expect(registered.size).toBe(1);

    await revokePermission(PATTERN);

    expect(registered.size).toBe(0);
    expect(await hasPermission(PATTERN)).toBe(false);
  });

  it('lists what has been granted, so it can be withdrawn', async () => {
    // A permission the user cannot see is a permission they cannot withdraw.
    await requestPermission(PATTERN);
    await requestPermission('https://another.example/*');

    expect(await grantedOrigins()).toEqual([
      'https://another.example/*',
      'https://portal.example.gov.in/*',
    ]);
  });

  it('drops every early guard on request', async () => {
    await requestPermission(PATTERN);
    await register(PATTERN);

    await unregisterAll();
    expect(registered.size).toBe(0);
  });

  it('leaves scripts it did not register alone', async () => {
    registered.set('someone-elses-script', {
      id: 'someone-elses-script',
      matches: ['https://x/*'],
      runAt: 'document_idle',
    });

    await unregisterAll();

    expect(registered.has('someone-elses-script')).toBe(true);
  });
});

describe('syncing at the start of a run', () => {
  it('registers when the origin is granted', async () => {
    await requestPermission(PATTERN);

    expect(await syncFor(PORTAL)).toEqual({
      origin: PATTERN,
      granted: true,
      registered: true,
    });
  });

  it('does nothing when it is not granted — the run degrades, not breaks', async () => {
    expect(await syncFor(PORTAL)).toEqual({
      origin: PATTERN,
      granted: false,
      registered: false,
    });
    expect(registered.size).toBe(0);
  });

  it('tears down a stale registration whose permission has gone', async () => {
    // The user revoked from Chrome's own settings rather than our panel. The
    // next run must notice and stop running a script we are no longer allowed.
    await requestPermission(PATTERN);
    await register(PATTERN);
    granted.delete(PATTERN);

    await syncFor(PORTAL);

    expect(registered.size).toBe(0);
  });

  it('does nothing for a page that cannot be scripted', async () => {
    await syncFor('chrome://extensions');
    expect(registered.size).toBe(0);
  });
});

describe('a refused permission prompt', () => {
  it('leaves the extension working, just without the early guard', async () => {
    requestAnswer = false;

    expect(await requestPermission(PATTERN)).toBe(false);
    expect(await syncFor(PORTAL)).toMatchObject({ granted: false, registered: false });
  });
});

describe('the permission API being unavailable', () => {
  it('is treated as "not granted" rather than crashing the worker', async () => {
    const original = (globalThis as { chrome?: unknown }).chrome;
    (globalThis as { chrome?: unknown }).chrome = {};

    expect(await hasPermission(PATTERN)).toBe(false);
    expect(await requestPermission(PATTERN)).toBe(false);
    expect(await grantedOrigins()).toEqual([]);
    await expect(unregister(PATTERN)).resolves.toBeUndefined();

    (globalThis as { chrome?: unknown }).chrome = original;
  });
});

describe('what the panel is told', () => {
  it('reports granted-but-unregistered distinctly from both', async () => {
    // Two different states with two different fixes: "grant it" versus "we
    // could not register it". Collapsing them would make the second silent.
    await requestPermission(PATTERN);

    expect(await statusFor(PORTAL)).toEqual({
      origin: PATTERN,
      granted: true,
      registered: false,
    });

    await register(PATTERN);
    expect(await statusFor(PORTAL)).toMatchObject({ granted: true, registered: true });
  });
});

describe('the mount that runs before <body> exists', () => {
  it('waits for DOMContentLoaded rather than throwing', async () => {
    // At document_start there is no body. The guard must still block; only the
    // visible notice can wait. This is asserted here because a throw in the
    // toast path would take the guard down with it.
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<!doctype html><html><head></head></html>', {
      url: 'https://portal.example.gov.in/',
    });

    const doc = dom.window.document as unknown as Document;
    // Simulate document_start: head parsed, body not yet.
    doc.body?.remove();

    const { mountOverlay, __overlayText } = await import('@/content/overlay');
    vi.stubGlobal('document', doc);

    expect(() => mountOverlay(doc)).not.toThrow();
    void __overlayText;

    vi.unstubAllGlobals();
  });
});
