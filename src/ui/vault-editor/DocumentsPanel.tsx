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
 *  3. **Choosing a file is not saving it.** A pick is staged, measured and
 *     assessed; an explicit **Save to vault** writes it. This matches the
 *     profile fields, which grew the same button for the same reason, and it
 *     moves the quality gate to where rule 1 always claimed it was — the
 *     warning about a too-small photo now arrives while the user still has the
 *     original open, rather than about a copy already in the vault.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FieldKey } from '@/matching/taxonomy';
import type { DocumentSummary } from '@/vault/document-store';
import type { DocumentMeta } from '@/shared/types';
import { describeConstraint, mimeFromFilename, parseConstraint } from '@/documents/constraints';
import { assessMaster, roleFor } from '@/documents/intake';
import { measureShape } from '@/documents/raster';
import { shapeFromBox, type ShapeReading } from '@/documents/trim';
import { ExtractedDetails } from './ExtractedDetails';
import { errorMessage, isLockedError, send } from '@/ui/lib/client';
import { labelFor } from '@/ui/lib/field-groups';
import { documentGroupsFor } from '@/ui/lib/vault-shape';
import type { AcademicPath } from '@/matching/pathway';

interface Props {
  onLocked: () => void;
  /**
   * The user's academic path, which decides which folders are offered. Null
   * means the questions were skipped, and the whole catalogue is shown.
   */
  path: AcademicPath | null;
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
  /** The saved copy already met the requirement, so it would go in unchanged. */
  passedThrough: boolean;
}

/**
 * A file the user has chosen but has not yet committed.
 *
 * Only the `File` handle is kept, never its bytes. A handle is a lazy pointer
 * at the disk, so staging a 10 MB scan costs nothing until Save reads it — and
 * document bytes never sit in panel memory waiting for a click.
 */
interface Pending {
  file: File;
  meta: DocumentMeta;
  /**
   * Where the ink sits, measured before anything is stored. Null when it could
   * not be measured (a PDF, a blank page) — callers fall back to the canvas.
   */
  shape: ShapeReading | null;
}

export function DocumentsPanel({ onLocked, path }: Props) {
  /** Set by the control at the foot: the path offers, it never forbids. */
  const [showAll, setShowAll] = useState(false);
  const [masters, setMasters] = useState<DocumentSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<FieldKey | null>(null);
  const [pending, setPending] = useState<Map<FieldKey, Pending>>(new Map());
  const [constraintText, setConstraintText] = useState(SAMPLE_CONSTRAINT);
  const [previews, setPreviews] = useState<Map<FieldKey, Preview | { failed: string }>>(new Map());
  /** Which stored document, if any, is currently being read for details. */
  const [reading, setReading] = useState<{ id: string; label: string } | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

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

  /**
   * Take the pick, measure it, and hold it. Nothing is written here.
   *
   * Measuring in the panel is not new — the worker has no DOM image decoder —
   * but measuring *before* the write is what lets `assessMaster` speak up
   * while the file is still only a choice.
   */
  async function stage(key: FieldKey, file: File) {
    setBusyKey(key);
    setError(null);
    try {
      const bitmap = await createImageBitmap(file).catch(() => null);
      /*
       * Windows reports no MIME type at all for `.heic` unless an OS codec is
       * registered, so `file.type` arrives empty and the file becomes an
       * anonymous blob we can only shrug at. The extension is then the only
       * remaining evidence of what it is, and naming the format is the
       * difference between a remedy and a dead end.
       */
      const mime =
        file.type || mimeFromFilename(file.name) || 'application/octet-stream';
      const meta: DocumentMeta = {
        key,
        mime,
        bytes: file.size,
        width: bitmap?.width ?? 0,
        height: bitmap?.height ?? 0,
        capturedAt: new Date().toISOString(),
      };
      bitmap?.close();

      /*
       * Measure the ink now, so the advice on screen is about the signature
       * rather than about the rectangle it was photographed in. Reading the
       * file twice is cheap next to being wrong about whether there is
       * anything to crop.
       */
      const bytes = new Uint8Array(await file.arrayBuffer());
      const shape = await measureShape(bytes, meta.mime).catch(() => null);
      if (shape) meta.content = shape.content;

      setPending((prev) => new Map(prev).set(key, { file, meta, shape }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  /** Write a staged file to the vault. The only path that stores a document. */
  async function save(key: FieldKey) {
    const staged = pending.get(key);
    if (!staged) return;

    setBusyKey(key);
    setError(null);
    try {
      // Read the bytes now, at the moment of the deliberate action, so they
      // exist for one message rather than for as long as the panel is open.
      const bytes = new Uint8Array(await staged.file.arrayBuffer());
      await send({
        type: 'doc:put',
        key,
        label: labelFor(key),
        mime: staged.meta.mime,
        width: staged.meta.width,
        height: staged.meta.height,
        bytes: Array.from(bytes),
      });
      discard(key);
      await refresh();
      await checkQuality(key);
    } catch (err) {
      if (isLockedError(err)) return onLocked();
      setError(errorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  /** Drop a staged pick. The vault is untouched either way. */
  function discard(key: FieldKey) {
    setPending((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
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

      const blob = new Blob([Uint8Array.from(result.bytes)], {
        type: result.mime,
      });
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
          passedThrough: result.passedThrough === true,
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
  // A slot holding a document is shown whatever the path says.
  const groups = documentGroupsFor(showAll ? null : path, new Set(byKey.keys()));
  const { constraint } = parseConstraint(constraintText);

  return (
    <section className="border-t border-slate-200 p-4">
      <h2 className="text-sm font-semibold text-slate-900">Documents</h2>
      <p className="mt-1 text-xs text-slate-500">
        Add one good-quality copy of each. When a form asks for one, “Fill this form” makes a copy
        the size and format that form accepts, on this device, and puts it in the form’s upload box.
        It reaches a site only when that form is sent.
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

      {savedNotice !== null && (
        <p
          role="status"
          className="mt-2 rounded border border-emerald-300 bg-emerald-50 p-2 text-xs text-emerald-900"
        >
          {savedNotice}{' '}
          <button
            type="button"
            onClick={() => setSavedNotice(null)}
            className="underline"
          >
            Dismiss
          </button>
        </p>
      )}

      {groups.map((group) => {
        const added = group.keys.filter((key) => byKey.has(key)).length;
        return (
          /*
           * One folder per section, and the optional ones start closed.
           *
           * Forty-odd slots in one list is a list nobody reads to the end of.
           * `details` keeps every slot in the page — findable by the browser
           * search and by a screen reader — while showing the handful a person
           * is working through.
           */
          <details
            key={group.id}
            open={group.optional !== true}
            className="mt-3 rounded border border-slate-200"
          >
            <summary className="cursor-pointer px-2 py-1.5 text-xs font-semibold text-slate-800">
              {group.title}{' '}
              <span className="font-normal text-slate-500">
                — {added} of {group.keys.length} added
              </span>
            </summary>
            {group.hint !== undefined && (
              <p className="px-2 pb-1 text-[11px] text-slate-500">{group.hint}</p>
            )}
            <ul className="space-y-3 p-2">
              {group.keys.map((key) => {
                const master = byKey.get(key);
                const staged = pending.get(key);
                const shown = previews.get(key);
                const busy = busyKey === key;
                /*
                 * Assess the staged pick when there is one, and the stored document
                 * otherwise. Reading off metadata rather than remembering what the
                 * upload found means the same answer either way, and it also covers
                 * documents added before this check existed — which is most of them,
                 * for an existing user.
                 */
                const assessed = staged?.meta ?? master?.meta;
                /*
                 * A staged file carries its fresh reading; a stored one carries the
                 * box measured at upload, which `shapeFromBox` turns back into the
                 * same answer. Documents stored before any of this have neither, and
                 * are judged by the canvas exactly as they always were.
                 */
                const shape =
                  staged?.shape ??
                  (master?.meta.content
                    ? shapeFromBox(master.meta.content, {
                        width: master.meta.width,
                        height: master.meta.height,
                      })
                    : null);
                const findings = assessed ? assessMaster(assessed, roleFor(key), shape) : [];

                return (
                  <li key={key} className="rounded border border-slate-200 p-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-medium text-slate-800">{labelFor(key)}</span>
                      {staged ? (
                        <span className="text-[10px] font-medium text-amber-700">
                          {staged.meta.width}×{staged.meta.height} ·{' '}
                          {Math.round(staged.meta.bytes / 1024)} KB · not saved
                        </span>
                      ) : master ? (
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
                        {staged ? 'Choose another' : master ? 'Replace' : 'Add'}
                        <input
                          type="file"
                          accept="image/jpeg,image/png,application/pdf"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) void stage(key, file);
                            e.target.value = '';
                          }}
                        />
                      </label>

                      {staged && (
                        <>
                          <button
                            type="button"
                            onClick={() => void save(key)}
                            disabled={busy}
                            // One panel, twelve documents, twelve buttons reading
                            // "Save"; the document name is what tells them apart.
                            aria-label={`Save ${labelFor(key)} to vault`}
                            className="rounded border border-slate-800 bg-slate-800 px-2 py-1 text-[11px] text-white hover:bg-slate-700 disabled:opacity-50"
                          >
                            {busy ? 'Saving…' : 'Save to vault'}
                          </button>
                          <button
                            type="button"
                            onClick={() => discard(key)}
                            disabled={busy}
                            aria-label={`Discard the ${labelFor(key)} you chose`}
                            className="rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                          >
                            Discard
                          </button>
                        </>
                      )}

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
                          {/*
                           * Only for a document with printing on it. A face
                           * photograph, a signature and a thumb impression carry
                           * no details to read, and offering to read one is an
                           * offer to spend five seconds recognising nothing.
                           */}
                          {roleFor(key) === 'document' && (
                            <button
                              type="button"
                              onClick={() =>
                                setReading((was) =>
                                  was?.id === master.id
                                    ? null
                                    : { id: master.id, label: labelFor(key) },
                                )
                              }
                              className="rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-50"
                            >
                              Read details from this
                            </button>
                          )}
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

                    {staged && (
                      <p className="mt-1.5 text-[11px] text-slate-600">
                        Ready to save: <span className="font-medium">{staged.file.name}</span>
                        {master && (
                          <span className="text-slate-500">
                            {' '}
                            — this will replace the stored copy.
                          </span>
                        )}
                      </p>
                    )}

                    {reading?.id === master?.id && reading !== null && (
                      <ExtractedDetails
                        documentId={reading.id}
                        documentLabel={reading.label}
                        onLocked={onLocked}
                        onClose={() => setReading(null)}
                        onSaved={(count) => {
                          setReading(null);
                          setSavedNotice(
                            count === 0
                              ? 'Nothing was saved.'
                              : `Saved ${count} detail${count === 1 ? '' : 's'} to your vault.`,
                          );
                        }}
                      />
                    )}

                    {findings.length > 0 && (
                      <ul className="mt-1.5 space-y-1">
                        {findings.map((finding) => (
                          <li
                            key={finding.message}
                            role={finding.severity === 'blocker' ? 'alert' : 'status'}
                            className={
                              finding.severity === 'blocker'
                                ? 'rounded border border-red-300 bg-red-50 p-1.5 text-[11px] text-red-800'
                                : finding.severity === 'warning'
                                  ? 'rounded border border-amber-300 bg-amber-50 p-1.5 text-[11px] text-amber-900'
                                  : // A note is not a complaint. Styled to be read once and forgotten.
                                    'rounded border border-slate-200 bg-slate-50 p-1.5 text-[11px] text-slate-600'
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
                            {shown.passedThrough && (
                              <span className="text-slate-400">
                                {' '}
                                · already fits, used unchanged
                              </span>
                            )}
                          </p>
                          <p className="text-slate-500">
                            Required: {describeConstraint(constraint)}
                          </p>
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
          </details>
        );
      })}

      {path !== null && (
        <button
          type="button"
          onClick={() => setShowAll((was) => !was)}
          className="mt-3 text-xs text-slate-500 underline hover:text-slate-700"
        >
          {showAll ? 'Show only my documents' : 'Show every document slot'}
        </button>
      )}
    </section>
  );
}
