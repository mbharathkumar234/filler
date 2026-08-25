/**
 * Model settings (§ Phase 8).
 *
 * Three things a user needs to be able to answer here, and the panel is
 * organised around them rather than around the settings themselves:
 *
 *  - *What is sent?* Stated at the top, before the key field. Someone deciding
 *    whether to paste an API key into an extension that reads government forms
 *    deserves that sentence first, not in a help page.
 *  - *What is it costing me?* The meter. Counts, not a bill, but enough to
 *    notice a runaway before the invoice does.
 *  - *How do I stop?* Clearing the key is one button, and the extension keeps
 *    working — every deterministic rule still applies.
 *
 * The key goes in and never comes back: there is no message that reads it, so
 * this component cannot display one, and a screenshot of this panel cannot leak
 * one.
 */

import { useCallback, useEffect, useState } from 'react';
import type { LlmStatus } from '@/background/llm-service';
import { errorMessage, send } from '@/ui/lib/client';

export function LlmPanel() {
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [draftKey, setDraftKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await send({ type: 'llm:status' }));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const saveKey = useCallback(async () => {
    setBusy(true);
    try {
      await send({ type: 'llm:set-key', apiKey: draftKey });
      // Held no longer than the request that used it.
      setDraftKey('');
      setNotice('Key saved. It is encrypted with your vault passphrase.');
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [draftKey, load]);

  const clearKey = useCallback(async () => {
    setBusy(true);
    try {
      await send({ type: 'llm:set-key', apiKey: null });
      setNotice('Key removed. The built-in rules still work on every page.');
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [load]);

  return (
    <section className="border-t border-slate-200 p-4">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        className="text-sm font-semibold text-slate-900"
      >
        {open ? '▾' : '▸'} Model help for unknown fields
      </button>

      {open && (
        <>
          <div className="mt-2 rounded border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700">
            <p className="font-medium">What is sent</p>
            <p className="mt-0.5">
              Only the shape of a form: field labels, names, types and the options in a dropdown —
              with anything that looks like a value stripped out first, and checked against your own
              details before it leaves.
            </p>
            <p className="mt-1 font-medium">What is never sent</p>
            <p className="mt-0.5">
              Your saved details, your documents, and the address of the page you are on. Only the
              fields the built-in rules could not identify are ever asked about, and each form is
              asked about once.
            </p>
          </div>

          {error && (
            <p role="alert" className="mt-2 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-700">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="mt-2 rounded border border-emerald-300 bg-emerald-50 p-2 text-xs text-emerald-900">
              {notice}
            </p>
          )}

          {status && !status.unlocked && (
            <p className="mt-2 text-xs text-amber-800">
              Unlock your vault to change these settings — the key is stored encrypted.
            </p>
          )}

          {status?.unlocked && (
            <>
              <p className="mt-2 text-xs text-slate-700">
                {status.hasKey ? 'An API key is saved.' : 'No API key saved — rules only.'}
              </p>

              <label className="mt-2 block text-xs text-slate-600">
                Anthropic API key
                <input
                  type="password"
                  value={draftKey}
                  onChange={(event) => setDraftKey(event.target.value)}
                  placeholder="sk-ant-…"
                  autoComplete="off"
                  className="mt-1 w-full rounded border border-slate-300 px-1.5 py-1 font-mono text-xs"
                />
              </label>

              <div className="mt-1.5 flex gap-1.5">
                <button
                  type="button"
                  disabled={busy || draftKey.trim() === ''}
                  onClick={() => void saveKey()}
                  className="rounded bg-slate-900 px-2 py-1 text-xs text-white disabled:bg-slate-300"
                >
                  Save key
                </button>
                {status.hasKey && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void clearKey()}
                    className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700"
                  >
                    Remove key
                  </button>
                )}
              </div>

              <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
                <div>
                  <dt className="text-slate-500">Calls</dt>
                  <dd className="font-medium text-slate-900">{status.usage.calls}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Tokens in</dt>
                  <dd className="font-medium text-slate-900">
                    {status.usage.inputTokens.toLocaleString()}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Tokens out</dt>
                  <dd className="font-medium text-slate-900">
                    {status.usage.outputTokens.toLocaleString()}
                  </dd>
                </div>
              </dl>

              {status.estimatedCost !== null && (
                <p className="mt-1 text-[11px] text-slate-500">
                  Estimated spend: ${status.estimatedCost.toFixed(4)} (prices change; treat as a
                  guide, not a bill)
                </p>
              )}

              <p className="mt-2 text-xs text-slate-600">
                {status.learnedCount} form{status.learnedCount === 1 ? '' : 's'} learned. A learned
                form is never sent again.
              </p>

              <div className="mt-1.5 flex gap-1.5">
                <button
                  type="button"
                  onClick={() => void send({ type: 'llm:reset-usage' }).then(load)}
                  className="rounded border border-slate-300 px-2 py-0.5 text-[11px] text-slate-700"
                >
                  Reset meter
                </button>
                <button
                  type="button"
                  onClick={() => void send({ type: 'llm:forget-learned' }).then(load)}
                  className="rounded border border-slate-300 px-2 py-0.5 text-[11px] text-slate-700"
                >
                  Forget learned forms
                </button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
