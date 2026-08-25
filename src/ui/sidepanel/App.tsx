/**
 * Side panel root.
 *
 * Phase 1 scope: the vault gate and the vault editor. Harvested fields arrive
 * in Phase 3, the review screen in Phase 7.
 */

import { useCallback, useEffect, useState } from 'react';
import type { VaultStatus } from '@/vault/session';
import { errorMessage, send } from '@/ui/lib/client';
import { VaultGate } from '@/ui/vault-editor/VaultGate';
import { VaultEditor } from '@/ui/vault-editor/VaultEditor';
import { FieldsPanel } from './FieldsPanel';

export function App() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

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
  }, [refresh]);

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
      {status.unlocked ? (
        <>
          <FieldsPanel />
          <VaultEditor onLocked={() => void refresh()} />
        </>
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
