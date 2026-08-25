/**
 * Vault creation and unlock (§ Phase 1).
 *
 * The passphrase lives in component state only until submit, and is cleared
 * immediately afterwards. It is never written to storage, never logged, and
 * never included in an error message.
 */

import { useMemo, useState, type FormEvent } from 'react';
import { estimateStrength, type StrengthLabel } from '@/vault/passphrase';
import { errorMessage, send } from '@/ui/lib/client';

interface Props {
  exists: boolean;
  onUnlocked: () => void;
}

const METER_WIDTH: Record<StrengthLabel, string> = {
  unusable: 'w-[10%]',
  weak: 'w-[30%]',
  fair: 'w-[55%]',
  strong: 'w-[80%]',
  excellent: 'w-full',
};

const METER_COLOUR: Record<StrengthLabel, string> = {
  unusable: 'bg-red-500',
  weak: 'bg-red-500',
  fair: 'bg-amber-500',
  strong: 'bg-emerald-500',
  excellent: 'bg-emerald-600',
};

export function VaultGate({ exists, onUnlocked }: Props) {
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const strength = useMemo(() => estimateStrength(passphrase), [passphrase]);
  const mismatch = !exists && confirm !== '' && confirm !== passphrase;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (exists) {
        const unlocked = await send({ type: 'vault:unlock', passphrase });
        if (!unlocked) {
          setError('That passphrase did not unlock the vault.');
          return;
        }
      } else {
        if (passphrase !== confirm) {
          setError('The two passphrases do not match.');
          return;
        }
        await send({ type: 'vault:create', passphrase });
      }
      onUnlocked();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      // Drop the passphrase from component state as soon as it has been used.
      setPassphrase('');
      setConfirm('');
      setBusy(false);
    }
  }

  const canSubmit = exists
    ? passphrase.length > 0 && !busy
    : strength.acceptable && passphrase === confirm && confirm.length > 0 && !busy;

  return (
    <form onSubmit={onSubmit} className="space-y-4 p-4">
      <header>
        <h1 className="text-lg font-semibold text-slate-900">
          {exists ? 'Unlock your vault' : 'Create your vault'}
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          {exists
            ? 'Your details are encrypted on this device. Nothing is sent anywhere.'
            : 'Choose a passphrase. It encrypts everything you store, and it cannot be recovered.'}
        </p>
      </header>

      <label className="block">
        <span className="text-sm font-medium text-slate-700">Passphrase</span>
        <input
          type="password"
          autoComplete={exists ? 'current-password' : 'new-password'}
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          disabled={busy}
          autoFocus
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
        />
      </label>

      {!exists && (
        <>
          <div aria-live="polite">
            <div className="h-1.5 w-full overflow-hidden rounded bg-slate-200">
              <div
                className={`h-full transition-all ${METER_WIDTH[strength.label]} ${METER_COLOUR[strength.label]}`}
              />
            </div>
            <p className="mt-1 text-xs text-slate-600">
              <span className="font-medium capitalize">{strength.label}</span>
              {passphrase.length > 0 && <> · about {strength.bits} bits</>}
            </p>
            <ul className="mt-1 space-y-0.5 text-xs text-slate-500">
              {strength.feedback.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>

          <label className="block">
            <span className="text-sm font-medium text-slate-700">Confirm passphrase</span>
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={busy}
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
            />
            {mismatch && <span className="mt-1 block text-xs text-red-600">Does not match.</span>}
          </label>

          <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
            <strong>There is no recovery.</strong> If you forget this passphrase, everything in
            the vault is permanently unreadable — we cannot reset it for you.
          </p>
        </>
      )}

      {error && (
        <p role="alert" className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-700">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={!canSubmit}
        className="w-full rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        {busy ? 'Working…' : exists ? 'Unlock' : 'Create vault'}
      </button>
    </form>
  );
}
