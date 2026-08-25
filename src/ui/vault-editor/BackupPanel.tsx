/**
 * Encrypted backup export / import (§ Phase 1).
 *
 * Export warns before it produces the file; import warns before it replaces the
 * vault. Both warnings come from `backup-format.ts`, which has no runtime
 * dependencies — the panel must not pull the vault implementation into its bundle.
 */

import { useRef, useState } from 'react';
import {
  BACKUP_EXTENSION,
  EXPORT_WARNING,
  IMPORT_WARNING,
  type ImportResult,
} from '@/vault/backup-format';
import { errorMessage, send } from '@/ui/lib/client';

interface Props {
  onImported: () => void;
}

export function BackupPanel({ onImported }: Props) {
  const [mode, setMode] = useState<'idle' | 'export' | 'import'>('idle');
  const [passphrase, setPassphrase] = useState('');
  const [pendingFile, setPendingFile] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function doExport() {
    setBusy(true);
    setError(null);
    try {
      const text = await send({ type: 'vault:export' });
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const stamp = new Date().toISOString().slice(0, 10);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `autofill-${stamp}${BACKUP_EXTENSION}`;
      anchor.click();
      URL.revokeObjectURL(url);
      setStatus('Backup saved. Store it offline.');
      setMode('idle');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function doImport() {
    if (!pendingFile) return;
    setBusy(true);
    setError(null);
    try {
      const result = (await send({
        type: 'vault:import',
        text: pendingFile,
        passphrase,
      })) as ImportResult | null;

      if (result === null) {
        setError('That passphrase did not open the backup file.');
        return;
      }

      const skipped = result.skippedKeys.length;
      setStatus(
        `Restored ${result.imported} field${result.imported === 1 ? '' : 's'}` +
          (skipped > 0 ? `; skipped ${skipped} unknown key${skipped === 1 ? '' : 's'}.` : '.') +
          ' Unlock again with the backup’s passphrase.',
      );
      setMode('idle');
      setPendingFile(null);
      onImported();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPassphrase('');
      setBusy(false);
    }
  }

  return (
    <section className="border-t border-slate-200 p-4">
      <h2 className="text-sm font-semibold text-slate-900">Backup</h2>

      {status && (
        <p className="mt-2 rounded border border-emerald-300 bg-emerald-50 p-2 text-xs text-emerald-800">
          {status}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-700">
          {error}
        </p>
      )}

      {mode === 'idle' && (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => {
              setMode('export');
              setStatus(null);
              setError(null);
            }}
            className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
          >
            Export…
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('import');
              setStatus(null);
              setError(null);
            }}
            className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
          >
            Import…
          </button>
        </div>
      )}

      {mode === 'export' && (
        <div className="mt-2 space-y-2">
          <ul className="space-y-1 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
            {EXPORT_WARNING.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void doExport()}
              disabled={busy}
              className="rounded bg-slate-900 px-2 py-1 text-xs text-white disabled:bg-slate-300"
            >
              {busy ? 'Working…' : 'I understand — export'}
            </button>
            <button
              type="button"
              onClick={() => setMode('idle')}
              className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === 'import' && (
        <div className="mt-2 space-y-2">
          <ul className="space-y-1 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
            {IMPORT_WARNING.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>

          <input
            ref={fileInput}
            type="file"
            accept={BACKUP_EXTENSION + ',application/json'}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              setPendingFile(file ? await file.text() : null);
            }}
            className="block w-full text-xs text-slate-600 file:mr-2 file:rounded file:border file:border-slate-300 file:bg-white file:px-2 file:py-1 file:text-xs"
          />

          <label className="block">
            <span className="text-xs font-medium text-slate-700">Backup passphrase</span>
            <input
              type="password"
              autoComplete="off"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-slate-500 focus:outline-none"
            />
          </label>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void doImport()}
              disabled={busy || !pendingFile || passphrase.length === 0}
              className="rounded bg-slate-900 px-2 py-1 text-xs text-white disabled:bg-slate-300"
            >
              {busy ? 'Working…' : 'Replace my vault'}
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('idle');
                setPendingFile(null);
                setPassphrase('');
              }}
              className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
