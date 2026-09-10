/**
 * Keep an unlocked vault reachable while the user is actually typing into it.
 *
 * ## The bug this fixes
 *
 * The master key lives only in the service worker's module memory (§ Phase 1 —
 * never persisted, and that is not negotiable). An MV3 service worker is torn
 * down after roughly 30 seconds with no incoming event. So somebody who opens
 * the vault editor and spends a minute typing an address sends nothing across
 * the bus for that minute, the worker is suspended, the key goes with it, and
 * the next save fails with `VAULT_LOCKED` — fourteen minutes short of the
 * fifteen-minute idle lock they were promised.
 *
 * That is a **suspension**, not an auto-lock. The two look identical from the
 * panel and need opposite fixes: raising `IDLE_LOCK_MS` would have changed
 * nothing here, because the deadline was never reached.
 *
 * `vault:touch` has sat on the message bus since Phase 1 for precisely this,
 * and nothing has ever sent it. This is the sender.
 *
 * ## Why the heartbeat sends two different messages
 *
 * A heartbeat that always sent `vault:touch` would defer the idle lock for as
 * long as the panel is open, which turns a fifteen-minute auto-lock into no
 * auto-lock at all. That is a security regression dressed as a bug fix, and it
 * would be invisible — the panel is open most of the time by design.
 *
 * So the ping depends on whether the user has done anything since the last one:
 *
 *   - **interacted** → `vault:touch`. They are at the keyboard; deferring the
 *     auto-lock is exactly what `touch()` is for.
 *   - **idle, inside the grace window** → `vault:status`. Keeps the worker
 *     alive so the key survives, without claiming an activity that did not
 *     happen. `getStatus()` calls `expireIfIdle()` and never `touch()`, so the
 *     fifteen-minute deadline keeps running underneath.
 *   - **idle, past the grace window** → nothing. The worker suspends, the key
 *     goes, the vault is locked. Which is the behaviour we want.
 *
 * The guarantee is therefore: at least `KEEPALIVE_GRACE_MS` of usable unlocked
 * time after you last touched the panel, and never more auto-lock deferral
 * than real activity has earned.
 *
 * Note what this does *not* do: it never moves `authenticatedAt`, so the Phase
 * 6 re-auth gate on high-sensitivity fields is untouched. Staying unlocked and
 * having recently proved who you are remain separate facts.
 */

import { useEffect, useRef } from 'react';
import { send } from './client';

/**
 * Ping interval. Must stay comfortably under Chrome's ~30s service-worker idle
 * timeout; 20s survives one dropped message without losing the key.
 */
export const KEEPALIVE_PING_MS = 20_000;

/**
 * How long after the user's last interaction we keep the worker alive. Past
 * this the pings stop and the vault locks on its own.
 */
export const KEEPALIVE_GRACE_MS = 5 * 60 * 1000;

/**
 * What counts as "the user is still here". Deliberately coarse — scrolling and
 * mouse movement are excluded, because a cat on a trackpad is not consent to
 * keep a vault open.
 */
const INTERACTION_EVENTS = ['keydown', 'pointerdown', 'input', 'focusin'] as const;

export function useVaultKeepalive(unlocked: boolean): void {
  const lastInteractionAt = useRef(Date.now());
  const interactedSinceTick = useRef(true);

  useEffect(() => {
    if (!unlocked) return;

    // Unlocking is itself an interaction; the window starts now, not at
    // whenever this component last happened to mount.
    lastInteractionAt.current = Date.now();
    interactedSinceTick.current = true;

    const noteInteraction = () => {
      lastInteractionAt.current = Date.now();
      interactedSinceTick.current = true;
    };

    for (const type of INTERACTION_EVENTS) {
      window.addEventListener(type, noteInteraction, { passive: true });
    }

    const timer = setInterval(() => {
      if (Date.now() - lastInteractionAt.current >= KEEPALIVE_GRACE_MS) {
        // Stop pinging. Suspension will lock the vault, and that is the intent.
        return;
      }

      const active = interactedSinceTick.current;
      interactedSinceTick.current = false;

      const ping = active ? send({ type: 'vault:touch' }) : send({ type: 'vault:status' });
      void ping.catch(() => {
        /*
         * A failed ping means the vault has already locked or the worker is
         * mid-restart. Neither is worth interrupting the user over — the next
         * real action reports it properly, with somewhere to go from there.
         */
      });
    }, KEEPALIVE_PING_MS);

    return () => {
      clearInterval(timer);
      for (const type of INTERACTION_EVENTS) {
        window.removeEventListener(type, noteInteraction);
      }
    };
  }, [unlocked]);
}
