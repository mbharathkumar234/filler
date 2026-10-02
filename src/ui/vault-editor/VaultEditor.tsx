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
import { fieldGroupsFor } from '@/ui/lib/vault-shape';
import { describePath, type AcademicPath } from '@/matching/pathway';
import { suggestionsFor } from '@/matching/courses';
import { PathSetup } from '@/ui/onboarding/PathSetup';
import { hasSkippedPath, rememberPathSkipped } from '@/ui/lib/path-skip';
import { FieldRow } from './FieldRow';
import { BackupPanel } from './BackupPanel';
import { DocumentsPanel } from './DocumentsPanel';

interface Props {
  onLocked: () => void;
}

export function VaultEditor({ onLocked }: Props) {
  const [values, setValues] = useState<Map<FieldKey, string>>(new Map());
  const [meter, setMeter] = useState<Completeness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set(['identity']));
  /**
   * The academic path the vault is laid out from.
   *
   * `null` with `pathAsked` false is a vault whose owner has not answered the
   * questions yet — the setup card takes the top of the panel. `null` with
   * `pathAsked` true is somebody who skipped them, and sees everything.
   */
  const [path, setPath] = useState<AcademicPath | null>(null);
  const [pathAsked, setPathAsked] = useState(false);
  const [editingPath, setEditingPath] = useState(false);
  /** The control at the foot: the path offers, it never forbids. */
  const [showAll, setShowAll] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [entries, completeness, stored, skipped] = await Promise.all([
        send({ type: 'vault:list' }),
        send({ type: 'vault:completeness' }),
        send({ type: 'vault:path' }),
        hasSkippedPath(),
      ]);
      setValues(new Map((entries as ProfileEntry[]).map((e) => [e.key, e.value])));
      setMeter(completeness);
      setPath(stored);
      // Asked once. Somebody who declined is not asked again on every open.
      if (stored !== null || skipped) setPathAsked(true);
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

  /** Store the answers, and lay the vault out from them at once. */
  async function savePath(next: AcademicPath | null) {
    try {
      await send({ type: 'vault:set-path', path: next });
      await rememberPathSkipped(next === null);
      if (next !== null) await writeDegree(next);
      setPath(next);
      setPathAsked(true);
      setEditingPath(false);
    } catch (err) {
      if (isLockedError(err)) return onLocked();
      setError(errorMessage(err));
    }
  }

  /*
   * The degree named in the answers, written where a form fills from.
   *
   * The path itself is configuration; `education.<level>.course` is a value a
   * portal asks for. Writing it here means the one place somebody says "B.Tech,
   * Computer Science" is the setup card, rather than there and again in two
   * boxes below. An answer already in those boxes is left alone: what the user
   * typed themselves outranks what a dropdown suggested.
   */
  async function writeDegree(path: AcademicPath): Promise<void> {
    const block = path.now === 'postgraduate' ? 'education.postgraduate.' : 'education.undergraduate.';
    const writes: Array<[FieldKey, string]> = [];
    if (path.course !== null) writes.push([`${block}course` as FieldKey, path.course]);
    if (path.branch !== null) writes.push([`${block}branch` as FieldKey, path.branch]);

    for (const [key, value] of writes) {
      if ((values.get(key) ?? '') !== '') continue;
      await save(key, value);
    }
  }

  async function lock() {
    await send({ type: 'vault:lock' });
    onLocked();
  }

  const percent = useMemo(() => (meter ? Math.round(meter.ratio * 100) : 0), [meter]);

  /*
   * The blocks this person has, from the answers they gave.
   *
   * A block holding a value is always among them, so a path answered wrongly
   * costs a click on "show everything" and never a record.
   */
  const shown = useMemo(
    () => fieldGroupsFor(showAll ? null : path, new Set(values.keys())),
    [path, showAll, values],
  );

  if (loading) {
    return <p className="p-4 text-sm text-slate-500">Opening vault…</p>;
  }

  return (
    <div id="vault-editor" className="pb-8">
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

      {(editingPath || !pathAsked) && (
        <div className="px-4 pt-3">
          <PathSetup
            path={path}
            onSave={(next) => savePath(next)}
            onSkip={() => savePath(null)}
            {...(editingPath ? { onCancel: () => setEditingPath(false) } : {})}
          />
        </div>
      )}

      {pathAsked && !editingPath && (
        <p className="px-4 pt-3 text-xs text-slate-500">
          {path === null ? (
            'Showing every field and document slot.'
          ) : (
            <>
              <span className="text-slate-600">{describePath(path)}</span>{' '}
            </>
          )}
          <button
            type="button"
            onClick={() => setEditingPath(true)}
            className="underline hover:text-slate-700"
          >
            Change
          </button>
        </p>
      )}

      <div className="px-4">
        {shown.map((group) => {
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
                      suggestions={suggestionsFor(key, path)}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}

        {/*
         * The path offers; it never forbids.
         *
         * A block this person did not claim is one press away, and a block
         * holding a value is never in here — it is above, where its owner
         * left it, whatever the answers said.
         */}
        {path !== null && (
          <button
            type="button"
            onClick={() => setShowAll((was) => !was)}
            className="py-3 text-xs text-slate-500 underline hover:text-slate-700"
          >
            {showAll ? 'Show only my qualifications' : 'Show every field, including the rest'}
          </button>
        )}
      </div>

      <DocumentsPanel onLocked={onLocked} path={showAll ? null : path} />
      <BackupPanel onImported={onLocked} />
    </div>
  );
}
