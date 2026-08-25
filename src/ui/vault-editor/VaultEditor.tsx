/**
 * The vault editor (§ Phase 1): enter profile data once, see it persist.
 *
 * Everything here reads and writes through the background worker; the panel
 * never touches IndexedDB or the key directly.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FieldKey } from '@/matching/taxonomy';
import type { ProfileEntry, Completeness } from '@/vault/profile-store';
import { errorMessage, isLockedError, send } from '@/ui/lib/client';
import { DOCUMENT_KEYS, FIELD_GROUPS } from '@/ui/lib/field-groups';
import { FieldRow } from './FieldRow';
import { BackupPanel } from './BackupPanel';

interface Props {
  onLocked: () => void;
}

export function VaultEditor({ onLocked }: Props) {
  const [values, setValues] = useState<Map<FieldKey, string>>(new Map());
  const [meter, setMeter] = useState<Completeness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set(['identity']));

  const refresh = useCallback(async () => {
    try {
      const [entries, completeness] = await Promise.all([
        send({ type: 'vault:list' }),
        send({ type: 'vault:completeness' }),
      ]);
      setValues(new Map((entries as ProfileEntry[]).map((e) => [e.key, e.value])));
      setMeter(completeness);
      setError(null);
    } catch (err) {
      if (isLockedError(err)) {
        onLocked();
        return;
      }
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [onLocked]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(
    async (key: FieldKey, value: string) => {
      try {
        await send({ type: 'vault:set', key, value });
        setValues((prev) => {
          const next = new Map(prev);
          if (value === '') next.delete(key);
          else next.set(key, value);
          return next;
        });
        setMeter(await send({ type: 'vault:completeness' }));
      } catch (err) {
        if (isLockedError(err)) {
          onLocked();
          return;
        }
        throw err;
      }
    },
    [onLocked],
  );

  async function lock() {
    await send({ type: 'vault:lock' });
    onLocked();
  }

  const percent = useMemo(() => (meter ? Math.round(meter.ratio * 100) : 0), [meter]);

  if (loading) {
    return <p className="p-4 text-sm text-slate-500">Opening vault…</p>;
  }

  return (
    <div className="pb-8">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white p-4">
        <div className="flex items-baseline justify-between">
          <h1 className="text-base font-semibold text-slate-900">Your details</h1>
          <button
            type="button"
            onClick={() => void lock()}
            className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
          >
            Lock
          </button>
        </div>

        {meter && (
          <div className="mt-2">
            <div className="h-1.5 w-full overflow-hidden rounded bg-slate-200">
              <div
                className="h-full bg-slate-800 transition-all"
                style={{ width: `${percent}%` }}
                role="progressbar"
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Profile completeness"
              />
            </div>
            <p className="mt-1 text-xs text-slate-600">
              {meter.filled} of {meter.total} fields · {percent}% complete
            </p>
          </div>
        )}
      </header>

      {error && (
        <p role="alert" className="m-4 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-700">
          {error}
        </p>
      )}

      <div className="px-4">
        {FIELD_GROUPS.map((group) => {
          const open = openGroups.has(group.id);
          const filled = group.keys.filter((k) => values.has(k)).length;
          return (
            <section key={group.id} className="border-b border-slate-100 py-2">
              <button
                type="button"
                aria-expanded={open}
                onClick={() =>
                  setOpenGroups((prev) => {
                    const next = new Set(prev);
                    if (next.has(group.id)) next.delete(group.id);
                    else next.add(group.id);
                    return next;
                  })
                }
                className="flex w-full items-baseline justify-between text-left"
              >
                <span className="text-sm font-medium text-slate-800">{group.title}</span>
                <span className="text-xs text-slate-500">
                  {filled}/{group.keys.length}
                  <span aria-hidden className="ml-1.5">
                    {open ? '−' : '+'}
                  </span>
                </span>
              </button>

              {open && (
                <div className="mt-1">
                  {group.hint && <p className="mb-1 text-xs text-slate-500">{group.hint}</p>}
                  {group.keys.map((key) => (
                    <FieldRow
                      key={key}
                      fieldKey={key}
                      value={values.get(key) ?? ''}
                      onSave={save}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}

        <section className="border-b border-slate-100 py-3">
          <h2 className="text-sm font-medium text-slate-800">Documents</h2>
          <p className="mt-1 text-xs text-slate-500">
            Photo, signature, and certificates arrive in Phase 2. {DOCUMENT_KEYS.length} document
            slots are reserved in the taxonomy.
          </p>
        </section>
      </div>

      <BackupPanel onImported={onLocked} />
    </div>
  );
}
