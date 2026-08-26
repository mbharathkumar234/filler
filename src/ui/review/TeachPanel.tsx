/**
 * Teach mode, from the panel (§ Phase 9).
 *
 * Two doors in, exactly as the plan specifies: a form with fields we could not
 * place (`NEEDS_TEACHING`), and a profile whose selectors have stopped working
 * (`DRIFTED`). Both land here.
 *
 * ## The shape of the interaction
 *
 * Point, then name. The user clicks a field on the page, and *then* chooses
 * what it is from a searchable list — rather than choosing a key first and
 * hunting for its box. Pointing is the easy half and it is what the user is
 * already looking at; picking from a sixty-item taxonomy is the hard half, and
 * it is much easier once the answer is "the thing I just clicked".
 *
 * ## What a repair is allowed to cost
 *
 * The plan budgets "~2 minutes of user clicking". So: no confirmation dialogs,
 * no wizard, no save-per-field. Pick, name, pick, name, save once. The list is
 * filtered as you type and the first match is one Enter away.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ProfileHealth } from '@/matching/teach';
import type { ProfileVersionSummary, TeachSession } from '@/background/teach-service';
import { FIELD_KEYS, sensitivityOf, type FieldKey } from '@/matching/taxonomy';
import { labelFor } from '@/ui/lib/field-groups';
import { errorMessage, send } from '@/ui/lib/client';
import { isEnvelope } from '@/shared/messages';

interface PickedField {
  ref: string | null;
  selectors: string[];
  label: string;
  tag: string;
  refused?: string;
}

export function TeachPanel({
  tabId,
  fingerprint,
  health,
  unmappedCount,
  onTaught,
}: {
  tabId: number;
  fingerprint: string;
  health?: ProfileHealth | null;
  unmappedCount?: number;
  onTaught?: () => void;
}) {
  const [session, setSession] = useState<TeachSession | null>(null);
  const [picked, setPicked] = useState<PickedField | null>(null);
  const [query, setQuery] = useState('');
  const [versions, setVersions] = useState<ProfileVersionSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const teaching = session !== null;

  /**
   * The picker's report arrives as a broadcast from the content script.
   *
   * It carries selectors and a label — never a value. There is no reason for
   * this panel to learn what is in the box the user is pointing at.
   */
  useEffect(() => {
    if (!teaching) return;

    const listener = (message: unknown) => {
      if (!isEnvelope(message)) return;
      const payload = message.payload;
      if (payload.type !== 'teach:picked') return;
      setPicked({
        ref: payload.ref,
        selectors: payload.selectors,
        label: payload.label,
        tag: payload.tag,
        ...(payload.refused === undefined ? {} : { refused: payload.refused }),
      });
      setQuery('');
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [teaching]);

  const loadVersions = useCallback(async () => {
    try {
      setVersions(await send({ type: 'profile:versions', fingerprint }));
    } catch {
      // No history yet is not an error worth a banner.
    }
  }, [fingerprint]);

  useEffect(() => {
    void loadVersions();
  }, [loadVersions]);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setSession(await send({ type: 'teach:start', tabId }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [tabId]);

  const cancel = useCallback(async () => {
    await send({ type: 'teach:cancel', tabId }).catch(() => {});
    setSession(null);
    setPicked(null);
  }, [tabId]);

  const assign = useCallback(
    async (key: FieldKey) => {
      if (!picked) return;
      setBusy(true);
      setError(null);
      try {
        setSession(
          await send({
            type: 'teach:assign',
            tabId,
            key,
            ref: picked.ref,
            selectors: picked.selectors,
            label: picked.label,
          }),
        );
        setPicked(null);
        setQuery('');
        // Straight back to pointing: the loop is pick, name, pick, name.
        await send({ type: 'teach:start', tabId }).catch(() => {});
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [picked, tabId],
  );

  const forget = useCallback(
    async (key: FieldKey) => {
      try {
        setSession(await send({ type: 'teach:forget', tabId, key }));
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [tabId],
  );

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await send({ type: 'teach:save', tabId });
      await send({ type: 'teach:stop', tabId }).catch(() => {});
      setSession(null);
      setPicked(null);
      setNotice(
        `Saved as version ${saved.version} — ${saved.fields} field${saved.fields === 1 ? '' : 's'} recorded. This form will fill itself next time.`,
      );
      await loadVersions();
      onTaught?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [loadVersions, onTaught, tabId]);

  const rollback = useCallback(async () => {
    setBusy(true);
    try {
      const restored = await send({ type: 'profile:rollback', fingerprint });
      setNotice(
        restored
          ? `Rolled back to version ${restored.version}.`
          : 'There was no earlier version to return to.',
      );
      await loadVersions();
      onTaught?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [fingerprint, loadVersions, onTaught]);

  const matches = useMemo(() => filterKeys(query), [query]);
  const needsRepair = health?.stale === true;

  return (
    <section className="border-t border-slate-200 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">Teach this form</h2>
        {!teaching && (
          <button
            type="button"
            onClick={() => void start()}
            disabled={busy}
            className="rounded bg-violet-700 px-2 py-1 text-xs text-white disabled:bg-slate-300"
          >
            {needsRepair ? 'Repair this form' : 'Point at a field'}
          </button>
        )}
      </div>

      {needsRepair && !teaching && (
        <p className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          Only {health!.resolved} of {health!.total} saved fields still match this page
          ({Math.round(health!.rate * 100)}%). The portal has probably changed. Rather than fill
          half a form, AutoFill has stopped — repair it by pointing at the moved fields.
          {health!.broken.length > 0 && (
            <span className="mt-1 block text-amber-800">
              Lost: {health!.broken.map((key) => labelFor(key)).join(', ')}
            </span>
          )}
        </p>
      )}

      {!teaching && !needsRepair && (
        <p className="mt-1 text-xs text-slate-500">
          {unmappedCount
            ? `${unmappedCount} field${unmappedCount === 1 ? '' : 's'} on this page could not be identified. Teaching them takes a moment and lasts.`
            : 'If AutoFill got a field wrong, point at it and say what it is. It will remember.'}
        </p>
      )}

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

      {teaching && (
        <div className="mt-2 rounded border border-violet-300 bg-violet-50 p-2">
          {picked === null ? (
            <p className="text-xs text-violet-900">
              Click a field on the page. Press <kbd>Esc</kbd> there to stop.
            </p>
          ) : picked.refused ? (
            <>
              <p className="text-xs text-red-700">{picked.refused}</p>
              <button
                type="button"
                onClick={() => void start()}
                className="mt-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs"
              >
                Pick another
              </button>
            </>
          ) : (
            <>
              <p className="text-xs text-violet-900">
                You picked <strong>{picked.label}</strong>. What is it?
              </p>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && matches[0]) void assign(matches[0]);
                }}
                placeholder="Search: father, pincode, ifsc…"
                autoFocus
                className="mt-1 w-full rounded border border-violet-300 px-1.5 py-1 text-sm"
              />
              <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto">
                {matches.slice(0, 40).map((key) => (
                  <li key={key}>
                    <button
                      type="button"
                      onClick={() => void assign(key)}
                      className="w-full rounded px-1.5 py-1 text-left text-xs hover:bg-violet-100"
                    >
                      <span className="font-medium text-slate-900">{labelFor(key)}</span>
                      <span className="ml-1 font-mono text-[10px] text-slate-500">{key}</span>
                      {sensitivityOf(key) === 'high' && (
                        <span className="ml-1 text-[10px] text-amber-700">sensitive</span>
                      )}
                    </button>
                  </li>
                ))}
                {matches.length === 0 && (
                  <li className="px-1.5 py-1 text-xs text-slate-500">
                    Nothing matches “{query}”. AutoFill only knows a fixed list of fields.
                  </li>
                )}
              </ul>
            </>
          )}

          {session.picks.length > 0 && (
            <ul className="mt-2 space-y-0.5 border-t border-violet-200 pt-2">
              {session.picks.map((pick) => (
                <li key={pick.key} className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="text-slate-800">
                    {pick.label} → <span className="font-mono">{pick.key}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => void forget(pick.key)}
                    className="shrink-0 text-[11px] text-slate-500 underline"
                  >
                    remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-2 flex gap-1.5">
            <button
              type="button"
              disabled={busy || session.picks.length === 0}
              onClick={() => void save()}
              className="rounded bg-violet-700 px-2 py-1 text-xs text-white disabled:bg-slate-300"
            >
              Save {session.picks.length} mapping{session.picks.length === 1 ? '' : 's'}
            </button>
            <button
              type="button"
              onClick={() => void cancel()}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void send({ type: 'profile:export' }).then((text) => {
              void navigator.clipboard?.writeText(text);
              setNotice('Copied every learned profile to the clipboard as JSON.');
            });
          }}
          className="rounded border border-slate-300 px-2 py-0.5 text-[11px] text-slate-700"
        >
          Copy my profiles
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void navigator.clipboard
              ?.readText()
              .then((text) => send({ type: 'profile:import', text }))
              .then((result) => {
                setNotice(
                  `Imported ${result.imported} profile${result.imported === 1 ? '' : 's'}.` +
                    (result.rejected.length > 0 ? ` Skipped: ${result.rejected.join('; ')}` : ''),
                );
                return loadVersions();
              })
              .catch((err: unknown) => setError(errorMessage(err)));
          }}
          className="rounded border border-slate-300 px-2 py-0.5 text-[11px] text-slate-700"
        >
          Paste profiles from clipboard
        </button>
      </div>
      <p className="mt-1 text-[10px] text-slate-500">
        Profiles describe <em>where</em> fields are on a page — never what you typed into them. A
        profile from someone else is treated as a suggestion: it is filled and flagged for your
        review, never filled silently.
      </p>

      {versions.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Saved versions
          </p>
          <ul className="mt-1 space-y-0.5">
            {versions.map((version) => (
              <li key={version.version} className="text-xs text-slate-600">
                v{version.version} · {version.fields} field{version.fields === 1 ? '' : 's'}
                {version.taught > 0 && ` (${version.taught} taught)`} ·{' '}
                {new Date(version.lastVerifiedAt).toLocaleDateString()}
              </li>
            ))}
          </ul>
          {versions.length > 1 && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void rollback()}
              className="mt-1 rounded border border-slate-300 px-2 py-0.5 text-[11px] text-slate-700"
            >
              Undo the last teach
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Search the taxonomy the way a person would.
 *
 * Matches the human label, the key itself, and the key's last segment — so
 * "father", "family.father", and "father_name" all find the same thing. Ranked
 * so a prefix match beats a substring one, because a user typing "pan" means
 * PAN and not "company name".
 */
export function filterKeys(query: string): FieldKey[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === '') return [...FIELD_KEYS];

  const scored: Array<{ key: FieldKey; score: number }> = [];

  for (const key of FIELD_KEYS) {
    const label = labelFor(key).toLowerCase();
    const leaf = (key.split('.').pop() ?? '').toLowerCase();
    const haystack = `${label} ${key.toLowerCase()}`;

    if (label.startsWith(trimmed) || leaf.startsWith(trimmed)) scored.push({ key, score: 0 });
    else if (haystack.includes(trimmed)) scored.push({ key, score: 1 });
  }

  return scored.sort((a, b) => a.score - b.score).map((entry) => entry.key);
}
