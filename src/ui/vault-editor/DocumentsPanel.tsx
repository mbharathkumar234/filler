/**
 * Document upload and preview (§ Phase 2).
 *
 * Two things this screen must get right:
 *
 *  1. **Quality is checked at intake, not at fill time.** The "too small"
 *     warning appears when the user adds the photo — while they still have the
 *     original to hand — rather than mid-application.
 *  2. **The preview is the proof.** It shows the derived variant's real byte
 *     size and dimensions against what the portal asked for, so the user can
 *     see compliance rather than take our word for it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FieldKey } from '@/matching/taxonomy';
import type { DocumentSummary } from '@/vault/document-store';
import { describeConstraint, parseConstraint } from '@/documents/constraints';
import { assessMaster, roleFor } from '@/documents/intake';
import { errorMessage, isLockedError, send } from '@/ui/lib/client';
import { DOCUMENT_KEYS, labelFor } from '@/ui/lib/field-groups';

interface Props {
  onLocked: () => void;
}

/** A constraint most Indian portals use, offered as a one-click preview. */
const SAMPLE_CONSTRAINT = 'JPEG, 20 KB to 50 KB, 3.5 cm × 4.5 cm';

interface Preview {
  url: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  warnings: string[];
  fromCache: boolean;
}

export function DocumentsPanel({ onLocked }: Props) {
  const [masters, setMasters] = useState<DocumentSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<FieldKey | null>(null);
  const [constraintText, setConstraintText] = useState(SAMPLE_CONSTRAINT);
  const [previews, setPreviews] = useState<Map<FieldKey, Preview | { failed: string }>>(new Map());

  // Revoke object URLs on unmount so previews do not leak memory.
  const urls = useRef<string[]>([]);
  useEffect(
    () => () => {
      for (const url of urls.current) URL.revokeObjectURL(url);
    },
    [],
  );

  const refresh = useCallback(async () => {
    try {
      setMasters(await send({ type: 'doc:list' }));
      setError(null);
    } catch (err) {
      if (isLockedError(err)) return onLocked();
      setError(errorMessage(err));
    }
  }, [onLocked]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function upload(key: FieldKey, file: File) {
    setBusyKey(key);
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Measure here: the worker has no DOM image decoder for dimensions.
      const bitmap = await createImageBitmap(file).catch(() => null);

      await send({
        type: 'doc:put',
        key,
        label: labelFor(key),
        mime: file.type || 'application/octet-stream',
        width: bitmap?.width ?? 0,
        height: bitmap?.height ?? 0,
        bytes: Array.from(bytes),
      });
      bitmap?.close();
      await refresh();
      await checkQuality(key);
    } catch (err) {
      if (isLockedError(err)) return onLocked();
      setError(errorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  /** The intake quality gate. */
  async function checkQuality(key: FieldKey) {
    const { constraint } = parseConstraint(constraintText);
    try {
      const result = await send({ type: 'doc:preflight', key, constraint });
      if (result.warnings.length > 0) {
        setError(result.warnings.join(' '));
      }
    } catch {
      // Preflight is advisory; never block an upload on it.
    }
  }

  async function preview(key: FieldKey) {
    setBusyKey(key);
    setError(null);
    try {
      const { constraint } = parseConstraint(constraintText);
      const result = await send({ type: 'doc:derive', key, constraint });

      if ('failed' in result) {
        setPreviews((prev) => new Map(prev).set(key, { failed: result.reason }));
        return;
      }

      const blob = new Blob([Uint8Array.from(result.bytes)], { type: result.mime });
      const url = URL.createObjectURL(blob);
      urls.current.push(url);

      setPreviews((prev) =>
        new Map(prev).set(key, {
          url,
          mime: result.mime,
          bytes: result.bytes.length,
          width: result.width,
          height: result.height,
          warnings: result.warnings,
          fromCache: result.fromCache,
        }),
      );
    } catch (err) {
      if (isLockedError(err)) return onLocked();
      setError(errorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function remove(id: string) {
    try {
      await send({ type: 'doc:delete', id });
      await refresh();
    } catch (err) {
      if (isLockedError(err)) return onLocked();
      setError(errorMessage(err));
    }
  }

  const byKey = new Map(masters.map((m) => [m.key, m]));
  const { constraint } = parseConstraint(constraintText);

  return (
    <section className="border-t border-slate-200 p-4">
      <h2 className="text-sm font-semibold text-slate-900">Documents</h2>
      <p className="mt-1 text-xs text-slate-500">
        Add one good-quality copy of each. Portal-sized versions are generated when needed —
        nothing is uploaded anywhere.
      </p>

      <label className="mt-3 block">
        <span className="text-xs font-medium text-slate-700">Portal requirement (paste it)</span>
        <textarea
          value={constraintText}
          onChange={(e) => setConstraintText(e.target.value)}
          rows={2}
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs focus:border-slate-500 focus:outline-none"
        />
        <span className="mt-0.5 block text-xs text-slate-500">
          Read as: {describeConstraint(constraint)}
        </span>
      </label>

      {error && (
        <p
          role="alert"
          className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900"
        >
          {error}
        </p>
      )}

      <ul className="mt-3 space-y-3">
        {DOCUMENT_KEYS.map((key) => {
          const master = byKey.get(key);
          const shown = previews.get(key);
          const busy = busyKey === key;
          // Read off the stored metadata rather than remembering what upload
          // found. Same answer, and it also covers documents added before this
          // check existed — which is most of them, for an existing user.
          const findings = master ? assessMaster(master.meta, roleFor(key)) : [];

          return (
            <li key={key} className="rounded border border-slate-200 p-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-medium text-slate-800">{labelFor(key)}</span>
                {master ? (
                  <span className="text-[10px] text-slate-500">
                    {master.meta.width}×{master.meta.height} ·{' '}
                    {Math.round(master.meta.bytes / 1024)} KB
                  </span>
                ) : (
                  <span className="text-[10px] text-slate-400">not added</span>
                )}
              </div>

              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <label className="cursor-pointer rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-50">
                  {master ? 'Replace' : 'Add'}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,application/pdf"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void upload(key, file);
                      e.target.value = '';
                    }}
                  />
                </label>

                {master && (
                  <>
                    <button
                      type="button"
                      onClick={() => void preview(key)}
                      disabled={busy}
                      className="rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      {busy ? 'Working…' : 'Preview for this portal'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(master.id)}
                      className="rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50"
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>

              {findings.length > 0 && (
                <ul className="mt-1.5 space-y-1">
                  {findings.map((finding) => (
                    <li
                      key={finding.message}
                      role={finding.severity === 'blocker' ? 'alert' : 'status'}
                      className={
                        finding.severity === 'blocker'
                          ? 'rounded border border-red-300 bg-red-50 p-1.5 text-[11px] text-red-800'
                          : 'rounded border border-amber-300 bg-amber-50 p-1.5 text-[11px] text-amber-900'
                      }
                    >
                      <span className="font-medium">{finding.message}</span>{' '}
                      <span className="opacity-90">{finding.remedy}</span>
                    </li>
                  ))}
                </ul>
              )}

              {shown && 'failed' in shown && (
                <p className="mt-1.5 rounded border border-red-300 bg-red-50 p-1.5 text-[11px] text-red-700">
                  {shown.failed}
                </p>
              )}

              {shown && !('failed' in shown) && (
                <div className="mt-1.5 flex items-start gap-2">
                  {shown.mime.startsWith('image/') && (
                    <img
                      src={shown.url}
                      alt={`Derived ${labelFor(key)} preview`}
                      className="h-16 w-auto rounded border border-slate-200"
                    />
                  )}
                  <div className="text-[11px] text-slate-600">
                    <p>
                      {Math.round(shown.bytes / 1024)} KB · {shown.width}×{shown.height} px
                      {shown.fromCache && <span className="text-slate-400"> · cached</span>}
                    </p>
                    <p className="text-slate-500">Required: {describeConstraint(constraint)}</p>
                    {shown.warnings.map((w) => (
                      <p key={w} className="mt-0.5 text-amber-700">
                        {w}
                      </p>
                    ))}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
