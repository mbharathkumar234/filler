/**
 * The approval gesture (§ Phase 7).
 *
 *   "Approval requires a deliberate gesture (type-to-confirm or
 *    hold-to-confirm), not a single stray click."
 *
 * Hold, not type. Typing a phrase reads as ceremony and trains people to type
 * the phrase; holding a button for a second and a half is short enough not to
 * be resented and long enough that it cannot happen by accident — a stray
 * click, a double-click landing on a re-rendered layout, a trackpad twitch.
 *
 * The keyboard path is a real one, not an afterthought: Space or Enter held
 * down does the same thing, and releasing early cancels the same way. A
 * gesture only a mouse can perform would put the product's most important
 * control out of reach of some of its users.
 *
 * Releasing early does not "partially approve". There is no state between
 * nothing and approved.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export const HOLD_MS = 1_500;

export function HoldToConfirm({
  label,
  holdingLabel,
  disabled,
  onConfirm,
}: {
  label: string;
  holdingLabel: string;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [progress, setProgress] = useState(0);
  const frame = useRef<number | null>(null);
  const startedAt = useRef<number | null>(null);
  const fired = useRef(false);

  const stop = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    startedAt.current = null;
    setProgress(0);
  }, []);

  const tick = useCallback(() => {
    if (startedAt.current === null) return;
    const elapsed = Date.now() - startedAt.current;
    const ratio = Math.min(1, elapsed / HOLD_MS);
    setProgress(ratio);

    if (ratio >= 1) {
      if (!fired.current) {
        fired.current = true;
        stop();
        onConfirm();
      }
      return;
    }
    frame.current = requestAnimationFrame(tick);
  }, [onConfirm, stop]);

  const start = useCallback(() => {
    if (disabled || startedAt.current !== null) return;
    fired.current = false;
    startedAt.current = Date.now();
    frame.current = requestAnimationFrame(tick);
  }, [disabled, tick]);

  // A hold interrupted by the window losing focus is not a hold. Without this,
  // switching apps mid-press could complete an approval the user is no longer
  // watching.
  useEffect(() => {
    const cancel = () => stop();
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('blur', cancel);
      stop();
    };
  }, [stop]);

  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onKeyDown={(event) => {
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          if (!event.repeat) start();
        }
      }}
      onKeyUp={(event) => {
        if (event.key === ' ' || event.key === 'Enter') stop();
      }}
      aria-describedby="hold-hint"
      className="relative w-full overflow-hidden rounded bg-emerald-700 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300"
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 bg-emerald-900/40 transition-none"
        style={{ width: `${progress * 100}%` }}
      />
      <span className="relative">{progress > 0 ? holdingLabel : label}</span>
    </button>
  );
}
