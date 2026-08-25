/**
 * The audit log, shown to the person it is about (§ Phase 7, P5).
 *
 * A log nobody can read is not accountability, it is storage. This is the
 * screen that makes P5 a promise to the user rather than a note in a design
 * document — what was filled, where, what they approved, and when.
 *
 * The value-logging switch lives here too, next to the thing it affects, off
 * by default, with the trade-off written next to it rather than buried in
 * settings. And so does the delete button: it is the user's record, and being
 * unable to erase your own history is not a privacy feature.
 */

import { useCallback, useEffect, useState } from 'react';
import { describeEntry, type AuditEntry, type AuditSettings } from '@/runtime/audit';
import { errorMessage, send } from '@/ui/lib/client';

export function AuditPanel() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [settings, setSettings] = useState<AuditSettings | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [log, config] = await Promise.all([
        send({ type: 'audit:read', limit: 100 }),
        send({ type: 'audit:settings' }),
      ]);
      setEntries(log);
      setSettings(config);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  return (
    <section className="border-t border-slate-200 p-4">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        className="text-sm font-semibold text-slate-900"
      >
        {open ? '▾' : '▸'} What this extension has done
      </button>

      {open && (
        <>
          <p className="mt-1 text-xs text-slate-500">
            Kept on this device only. Never uploaded anywhere.
          </p>

          {error && (
            <p role="alert" className="mt-2 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-700">
              {error}
            </p>
          )}

          {settings && (
            <label className="mt-2 flex items-start gap-1.5 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={settings.logValues}
                onChange={(event) => {
                  const logValues = event.target.checked;
                  setSettings({ logValues });
                  void send({ type: 'audit:configure', logValues }).then(load);
                }}
                className="mt-0.5"
              />
              <span>
                Also record the values that were filled.
                <span className="block text-[11px] text-slate-500">
                  Off by default. Turning it on makes the log more useful and makes it a second,
                  unencrypted copy of your details on this device.
                </span>
              </span>
            </label>
          )}

          {entries && entries.length === 0 && (
            <p className="mt-2 text-xs text-slate-500">Nothing recorded yet.</p>
          )}

          {entries && entries.length > 0 && (
            <>
              <ul className="mt-2 space-y-1">
                {[...entries].reverse().map((entry) => (
                  <li key={entry.seq} className="rounded border border-slate-200 p-1.5 text-xs">
                    <p className="text-slate-800">{describeEntry(entry)}</p>
                    <p className="mt-0.5 text-[10px] text-slate-400">
                      {new Date(entry.at).toLocaleString()} · {entry.site}
                    </p>
                    {entry.values && (
                      <ul className="mt-0.5 space-y-0.5">
                        {Object.entries(entry.values).map(([key, value]) => (
                          <li key={key} className="font-mono text-[10px] text-slate-500">
                            {key}: {value}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>

              <button
                type="button"
                onClick={() => {
                  void send({ type: 'audit:clear' }).then(load);
                }}
                className="mt-2 rounded border border-slate-300 px-2 py-1 text-xs text-slate-700"
              >
                Delete this log
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}
