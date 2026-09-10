// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

import {
  KEEPALIVE_GRACE_MS,
  KEEPALIVE_PING_MS,
  useVaultKeepalive,
} from './use-vault-keepalive';

/**
 * The heartbeat exists because an MV3 service worker is suspended after ~30s
 * of no bus traffic, taking the master key with it. These tests are about the
 * part that is easy to get wrong twice over: pinging too little locks the user
 * out mid-edit, and pinging unconditionally defers the idle lock forever.
 */

const sent: string[] = [];

vi.mock('./client', () => ({
  send: (request: { type: string }) => {
    sent.push(request.type);
    return Promise.resolve(null);
  },
}));

function Harness({ unlocked }: { unlocked: boolean }) {
  useVaultKeepalive(unlocked);
  return null;
}

beforeEach(() => {
  sent.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Advance time without letting the interaction clock think anything happened. */
function idleFor(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('vault keepalive', () => {
  it('sends nothing while the vault is locked', () => {
    render(<Harness unlocked={false} />);
    idleFor(KEEPALIVE_GRACE_MS);
    expect(sent).toEqual([]);
  });

  it('pings inside the grace window so the worker cannot be suspended', () => {
    render(<Harness unlocked />);
    idleFor(KEEPALIVE_PING_MS * 3);

    // Three ticks, none of them more than 30s apart — the property that
    // actually keeps the key in memory.
    expect(sent).toHaveLength(3);
    expect(KEEPALIVE_PING_MS).toBeLessThan(30_000);
  });

  it('keeps the vault usable for the whole five-minute grace window', () => {
    render(<Harness unlocked />);
    idleFor(KEEPALIVE_GRACE_MS - KEEPALIVE_PING_MS);
    expect(sent.length).toBeGreaterThanOrEqual(
      Math.floor((KEEPALIVE_GRACE_MS - KEEPALIVE_PING_MS) / KEEPALIVE_PING_MS),
    );
  });

  it('stops pinging past the grace window, letting the vault lock', () => {
    render(<Harness unlocked />);
    idleFor(KEEPALIVE_GRACE_MS + KEEPALIVE_PING_MS);
    const atDeadline = sent.length;

    idleFor(KEEPALIVE_PING_MS * 5);
    expect(sent).toHaveLength(atDeadline);
  });

  it('defers the idle lock only when the user actually did something', () => {
    render(<Harness unlocked />);

    // First tick inherits the unlock itself, which is a real interaction.
    idleFor(KEEPALIVE_PING_MS);
    expect(sent).toEqual(['vault:touch']);

    // Idle ticks keep the worker alive but must not move `lastActivityAt`,
    // or having the panel open would mean the vault never auto-locks.
    idleFor(KEEPALIVE_PING_MS * 2);
    expect(sent).toEqual(['vault:touch', 'vault:status', 'vault:status']);

    act(() => {
      window.dispatchEvent(new Event('keydown'));
    });
    idleFor(KEEPALIVE_PING_MS);
    expect(sent.at(-1)).toBe('vault:touch');
  });

  it('restarts the grace window when the user comes back', () => {
    render(<Harness unlocked />);
    idleFor(KEEPALIVE_GRACE_MS - KEEPALIVE_PING_MS);

    act(() => {
      window.dispatchEvent(new Event('pointerdown'));
    });

    const before = sent.length;
    idleFor(KEEPALIVE_GRACE_MS - KEEPALIVE_PING_MS);
    expect(sent.length).toBeGreaterThan(before);
  });

  it('stops pinging once the vault locks', () => {
    const view = render(<Harness unlocked />);
    idleFor(KEEPALIVE_PING_MS);
    const whileUnlocked = sent.length;

    view.rerender(<Harness unlocked={false} />);
    idleFor(KEEPALIVE_PING_MS * 4);
    expect(sent).toHaveLength(whileUnlocked);
  });
});
