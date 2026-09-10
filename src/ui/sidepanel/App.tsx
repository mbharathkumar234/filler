/**
 * Side panel root.
 *
 * The order of the sections is the order of the work: scan and fill, then
 * review, then the vault you are filling from, then the record of what has
 * been done. The review screen appears only once there is something filled to
 * review — an empty approval control sitting on screen all the time would
 * train people to look past the most important thing here.
 */

import { useCallback, useEffect, useState } from 'react';
import type { VaultStatus } from '@/vault/session';
import { errorMessage, send } from '@/ui/lib/client';
import { VaultGate } from '@/ui/vault-editor/VaultGate';
import { VaultEditor } from '@/ui/vault-editor/VaultEditor';
import { ReviewScreen } from '@/ui/review/ReviewScreen';
import { AuditPanel } from '@/ui/review/AuditPanel';
import { LlmPanel } from '@/ui/review/LlmPanel';
import { Disclosure, hasSeenDisclosure } from '@/ui/onboarding/Disclosure';
import { GettingStarted } from '@/ui/onboarding/GettingStarted';
import { LanguagePicker } from '@/ui/lib/LanguagePicker';
import { useVaultKeepalive } from '@/ui/lib/use-vault-keepalive';
import { FieldsPanel } from './FieldsPanel';

export function App() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewTabId, setReviewTabId] = useState<number | null>(null);
  /** null while we are still asking; § Phase 10 disclosure gate. */
  const [disclosed, setDisclosed] = useState<boolean | null>(null);

  /**
   * The checklist's buttons point at the vault editor further down the panel
   * rather than opening a separate screen. Scrolling to the thing being talked
   * about keeps one panel; a modal would hide the checklist that sent you.
   */
  const focusVaultEditor = useCallback(() => {
    const target = document.getElementById('vault-editor');
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target?.querySelector<HTMLElement>('input, select, button')?.focus();
  }, []);

  const refresh = useCallback(async () => {
    try {
      setStatus(await send({ type: 'vault:status' }));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    void hasSeenDisclosure().then(setDisclosed);
  }, [refresh]);

  /*
   * Hold the key in the service worker while the user is working. Without
   * this the worker is suspended after ~30s of no bus traffic and the vault
   * locks mid-edit, long before its idle deadline. See the hook for why the
   * fix is a heartbeat and not a longer deadline.
   */
  useVaultKeepalive(status?.unlocked === true);

  // Re-check when the panel regains focus: the vault may have auto-locked while
  // it sat in the background.
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  if (error) {
    return (
      <main className="min-h-screen bg-white p-4 text-slate-900">
        <p role="alert" className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-700">
          {error}
        </p>
        <button
          type="button"
          onClick={() => void refresh()}
          className="mt-2 rounded border border-slate-300 px-2 py-1 text-xs"
        >
          Try again
        </button>
      </main>
    );
  }

  if (!status) {
    return <main className="min-h-screen bg-white p-4 text-sm text-slate-500">Loading…</main>;
  }

  return (
    <main className="min-h-screen bg-white font-sans text-slate-900">
      <LanguagePicker />
      {status.unlocked ? (
        <>
          <GettingStarted onOpenVault={focusVaultEditor} />
          <FieldsPanel onFilled={setReviewTabId} />
          {reviewTabId !== null && (
            <ReviewScreen tabId={reviewTabId} onDone={() => setReviewTabId(null)} />
          )}
          <VaultEditor onLocked={() => void refresh()} />
          <LlmPanel />
          <AuditPanel />
        </>
      ) : disclosed === false && !status.exists ? (
        /*
         * § Phase 10: the disclosure comes before the vault exists, not after.
         * Explaining what the software will and will not do *after* someone has
         * committed their details to it is an explanation nobody reads.
         */
        <Disclosure onAccept={() => setDisclosed(true)} />
      ) : (
        <>
          <VaultGate exists={status.exists} onUnlocked={() => void refresh()} />
          <footer className="border-t border-slate-100 p-4 text-xs text-slate-500">
            <p>This extension never submits a form without your explicit approval.</p>
            <p className="mt-1">Your data stays on this device.</p>
          </footer>
        </>
      )}
    </main>
  );
}
