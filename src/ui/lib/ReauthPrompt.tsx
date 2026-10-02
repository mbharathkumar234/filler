/**
 * The re-auth gate's other half (§ Phase 6).
 *
 * The worker refuses to put a high-sensitivity value into a page — an Aadhaar
 * number, a signature, a PAN card — once three minutes have passed since the
 * passphrase was last entered, and says `REAUTH_REQUIRED`. Until this existed
 * the panel could only show that sentence: there was nowhere to type the
 * passphrase, and the one way through was to lock the vault and unlock it again.
 *
 * `vault:reauth` re-derives the key exactly as an unlock does, so a wrong
 * passphrase fails for the same reason it always would. The passphrase leaves
 * component state as soon as it has been sent, like the vault gate's.
 */

import { useState, type FormEvent } from 'react';
import { errorMessage, send } from './client';

export function ReauthPrompt({
  message,
  onConfirmed,
  onCancel,
}: {
  /** The worker's own sentence — "Enter your passphrase to fill signature." */
  message: string;
  /** Called once the passphrase checks out, to retry what was refused. */
  onConfirmed: () => void;
  onCancel: () => void;
}) {
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const ok = await send({ type: 'vault:reauth', passphrase });
      if (!ok) {
        setError('That passphrase is not the one that opens your vault.');
        return;
      }
      onConfirmed();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPassphrase('');
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(event) => void onSubmit(event)}
      className="mt-2 rounded border border-amber-300 bg-amber-50 p-2"
    >
      <p className="text-xs font-medium text-amber-900">{message}</p>
      <p className="mt-0.5 text-[11px] text-amber-800">
        It has been a few minutes since you entered it, and this is sensitive.
      </p>
      <label className="mt-1.5 block">
        <span className="sr-only">Passphrase</span>
        <input
          type="password"
          autoComplete="current-password"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          disabled={busy}
          autoFocus
          aria-label="Passphrase"
          className="w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-slate-500 focus:outline-none"
        />
      </label>
      {error && (
        <p role="alert" className="mt-1 text-[11px] text-red-700">
          {error}
        </p>
      )}
      <div className="mt-1.5 flex gap-2">
        <button
          type="submit"
          disabled={busy || passphrase.length === 0}
          className="rounded bg-slate-900 px-2 py-1 text-xs text-white disabled:bg-slate-300"
        >
          {busy ? 'Checking…' : 'Confirm and continue'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
