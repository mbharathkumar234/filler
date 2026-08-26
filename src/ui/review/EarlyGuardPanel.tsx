/**
 * The early-guard control (§ COMPLETION_PLAN Phase B).
 *
 * One toggle per portal, and the sentence next to it has to be honest about
 * what is being traded, because the user is granting this extension standing
 * access to a site.
 *
 * ## Why it is offered at all
 *
 * The submit guard normally arrives when the user clicks the extension's
 * button. That is late enough to matter exactly once: after a fill, an ASP.NET
 * postback returns the page **carrying the values the extension typed**, and a
 * portal that submits during `load` sends them before the guard can exist.
 * `tests/e2e/guard-adversarial.spec.ts` shows a filled Aadhaar reaching the
 * server that way.
 *
 * Closing it needs permission for the site. So the user is asked — for that
 * site, at the moment they are using it, with the reason stated and a way back.
 */

import { useCallback, useEffect, useState } from 'react';
import type { EarlyGuardState } from '@/background/early-guard';
import { errorMessage, send } from '@/ui/lib/client';

export function EarlyGuardPanel({ tabId }: { tabId: number }) {
  const [state, setState] = useState<EarlyGuardState | null>(null);
  const [origins, setOrigins] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [status, granted] = await Promise.all([
        send({ type: 'guard:status', tabId }),
        send({ type: 'guard:origins' }),
      ]);
      setState(status);
      setOrigins(granted);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [tabId]);

  useEffect(() => {
    void load();
  }, [load]);

  const enable = useCallback(async () => {
    setBusy(true);
    try {
      // Chrome requires a user gesture for a permission prompt, which is why
      // this is a click handler and not something the panel does on mount.
      setState(await send({ type: 'guard:enable', tabId }));
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [load, tabId]);

  const disable = useCallback(
    async (origin: string) => {
      setBusy(true);
      try {
        await send({ type: 'guard:disable', origin });
        await load();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  if (!state) return null;

  const scriptable = state.origin !== '';

  return (
    <section className="border-t border-slate-200 p-4">
      <h2 className="text-sm font-semibold text-slate-900">Protect this site as it loads</h2>

      {!scriptable ? (
        <p className="mt-1 text-xs text-slate-500">
          This page is not an ordinary web page, so there is nothing to protect here.
        </p>
      ) : state.granted ? (
        <>
          <p className="mt-1 text-xs text-emerald-800">
            On. The submit guard runs on <span className="font-mono">{state.origin}</span> from the
            moment a page there starts loading
            {state.registered ? '.' : ' — it will register on your next fill.'}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void disable(state.origin)}
            className="mt-2 rounded border border-slate-300 px-2 py-1 text-xs text-slate-700"
          >
            Turn this off
          </button>
        </>
      ) : (
        <>
          <p className="mt-1 text-xs text-slate-700">
            Normally the guard starts when you click AutoFill. That is late enough to matter once:
            if this portal reloads the page with the values already filled in and submits them
            automatically, they would be sent before the guard exists.
          </p>
          <p className="mt-1 text-xs text-slate-700">
            Turning this on lets AutoFill run on{' '}
            <span className="font-mono">{state.origin}</span> from the first moment a page loads —{' '}
            <strong>this site only</strong>, and you can turn it off here at any time.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void enable()}
            className="mt-2 rounded bg-slate-900 px-2 py-1 text-xs text-white disabled:bg-slate-300"
          >
            Protect this site
          </button>
        </>
      )}

      {error && (
        <p role="alert" className="mt-2 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-700">
          {error}
        </p>
      )}

      {origins.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Sites you have turned this on for
          </p>
          <ul className="mt-1 space-y-0.5">
            {origins.map((origin) => (
              <li key={origin} className="flex items-baseline justify-between gap-2 text-xs">
                <span className="truncate font-mono text-slate-700">{origin}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void disable(origin)}
                  className="shrink-0 text-[11px] text-slate-500 underline"
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
