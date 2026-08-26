// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { HoldToConfirm, HOLD_MS } from './HoldToConfirm';

/**
 * The approval gesture (§ COMPLETION_PLAN Phase B, row 7-4).
 *
 * The Phase A audit found this component untested, and marked the row red on
 * the plan's own rule that amber on a safety row is red. It deserves that
 * treatment: **the entire P2 promise narrows to this component.** Everything
 * else in the product refuses to submit; this is the one control whose job is
 * to permit it, and nothing was checking that a stray click could not.
 *
 * `requestAnimationFrame` is driven by fake timers so the hold can be advanced
 * deterministically rather than slept through.
 */

function renderHold(onConfirm = vi.fn(), disabled = false) {
  render(
    <HoldToConfirm
      label="Hold to approve"
      holdingLabel="Keep holding…"
      disabled={disabled}
      onConfirm={onConfirm}
    />,
  );
  return { onConfirm, button: screen.getByRole('button') };
}

/**
 * Advance both the clock and the animation frames the component polls on.
 *
 * Wrapped in `act` so React flushes the state updates the frames produce. The
 * behavioural assertions pass without it — they watch `onConfirm` — but the
 * ones that read the rendered label need the DOM to have caught up.
 */
function advance(ms: number): void {
  const step = 16;
  act(() => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      vi.advanceTimersByTime(step);
    }
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom has no rAF loop; drive it off the timer queue so `advance` moves it.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 16) as unknown as number,
  );
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('a single click does not approve', () => {
  it('ignores a plain click entirely', () => {
    // The reason this control exists. A click is what a user does by accident.
    const { onConfirm, button } = renderHold();

    fireEvent.click(button);
    advance(HOLD_MS * 2);

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('ignores a press and immediate release', () => {
    const { onConfirm, button } = renderHold();

    fireEvent.pointerDown(button);
    fireEvent.pointerUp(button);
    advance(HOLD_MS * 2);

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('ignores a double click', () => {
    const { onConfirm, button } = renderHold();

    for (let i = 0; i < 2; i += 1) {
      fireEvent.pointerDown(button);
      fireEvent.pointerUp(button);
    }
    advance(HOLD_MS * 2);

    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('a completed hold approves, once', () => {
  it('fires after the full duration', () => {
    const { onConfirm, button } = renderHold();

    fireEvent.pointerDown(button);
    advance(HOLD_MS + 100);

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('does not fire before the full duration', () => {
    const { onConfirm, button } = renderHold();

    fireEvent.pointerDown(button);
    advance(HOLD_MS - 200);

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('fires exactly once, however long the hold continues', () => {
    // A control that fired per frame after completing would issue a stream of
    // approvals, and the worker would mint a grant for each.
    const { onConfirm, button } = renderHold();

    fireEvent.pointerDown(button);
    advance(HOLD_MS * 4);

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('takes at least a second and a half — long enough not to be an accident', () => {
    expect(HOLD_MS).toBeGreaterThanOrEqual(1_000);
  });
});

describe('releasing early cancels', () => {
  it('does not approve when released part-way', () => {
    const { onConfirm, button } = renderHold();

    fireEvent.pointerDown(button);
    advance(HOLD_MS - 300);
    fireEvent.pointerUp(button);
    advance(HOLD_MS * 2);

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('does not carry progress over into the next attempt', () => {
    // Two nearly-complete holds must not add up to one approval.
    const { onConfirm, button } = renderHold();

    fireEvent.pointerDown(button);
    advance(HOLD_MS - 200);
    fireEvent.pointerUp(button);

    fireEvent.pointerDown(button);
    advance(HOLD_MS - 200);
    fireEvent.pointerUp(button);

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('cancels when the pointer leaves the button', () => {
    const { onConfirm, button } = renderHold();

    fireEvent.pointerDown(button);
    advance(HOLD_MS - 300);
    fireEvent.pointerLeave(button);
    advance(HOLD_MS * 2);

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('cancels when the window loses focus mid-hold', () => {
    // Switching apps with the mouse down must not complete an approval the
    // user is no longer watching.
    const { onConfirm, button } = renderHold();

    fireEvent.pointerDown(button);
    advance(HOLD_MS - 300);
    fireEvent.blur(window);
    advance(HOLD_MS * 2);

    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('the keyboard path is a real one', () => {
  it('approves on a held Space', () => {
    // A gesture only a mouse can perform would put the product's most
    // important control out of reach of some of its users.
    const { onConfirm, button } = renderHold();

    fireEvent.keyDown(button, { key: ' ' });
    advance(HOLD_MS + 100);

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('approves on a held Enter', () => {
    const { onConfirm, button } = renderHold();

    fireEvent.keyDown(button, { key: 'Enter' });
    advance(HOLD_MS + 100);

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('cancels when the key is released early', () => {
    const { onConfirm, button } = renderHold();

    fireEvent.keyDown(button, { key: ' ' });
    advance(HOLD_MS - 300);
    fireEvent.keyUp(button, { key: ' ' });
    advance(HOLD_MS * 2);

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('does not restart on auto-repeat', () => {
    // Holding a key fires keydown repeatedly. Restarting the timer on each
    // would mean the hold never completed for a keyboard user.
    const { onConfirm, button } = renderHold();

    fireEvent.keyDown(button, { key: ' ' });
    advance(500);
    fireEvent.keyDown(button, { key: ' ', repeat: true });
    advance(500);
    fireEvent.keyDown(button, { key: ' ', repeat: true });
    advance(HOLD_MS);

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('ignores other keys', () => {
    const { onConfirm, button } = renderHold();

    fireEvent.keyDown(button, { key: 'a' });
    advance(HOLD_MS * 2);

    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('when it is disabled', () => {
  it('cannot be held to completion', () => {
    // The review screen disables this until every flagged row is ticked. If a
    // hold worked anyway, that gate would be decorative.
    const { onConfirm, button } = renderHold(vi.fn(), true);

    fireEvent.pointerDown(button);
    advance(HOLD_MS * 2);

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('is disabled to assistive technology too, not just visually', () => {
    const { button } = renderHold(vi.fn(), true);
    expect(button.hasAttribute('disabled')).toBe(true);
  });
});

describe('what the user sees', () => {
  it('starts with the label it was given', () => {
    renderHold();
    expect(screen.getByRole('button').textContent).toContain('Hold to approve');
  });

  it('changes wording once the hold begins, so it is clear it is working', () => {
    const { button } = renderHold();

    fireEvent.pointerDown(button);
    advance(300);

    expect(button.textContent).toContain('Keep holding…');
  });

  it('goes back to the resting label after a cancel', () => {
    const { button } = renderHold();

    fireEvent.pointerDown(button);
    advance(300);
    fireEvent.pointerUp(button);

    expect(button.textContent).toContain('Hold to approve');
  });

  it('points at the sentence explaining what will be submitted', () => {
    renderHold();
    expect(screen.getByRole('button').getAttribute('aria-describedby')).toBe('hold-hint');
  });
});
