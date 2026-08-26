/**
 * Suggesting details read from a document (§ document extraction).
 *
 * ## The design problem
 *
 * This screen exists to save typing, and the fastest version of it — read the
 * card, save everything, done — is the one that quietly puts a misread Aadhaar
 * number into forty applications. So the whole screen is arranged around making
 * the user look, without making them look at things they have no reason to
 * doubt:
 *
 *  - **Nothing is saved until Save is pressed**, and only ticked rows are saved.
 *  - **Only a checksum pre-ticks a row.** A Verhoeff-verified Aadhaar number is
 *    the one value here that is provably not a misread, so it is the one value
 *    that starts ticked. Everything else the user ticks after reading it.
 *  - **Every row shows the line it came from**, so checking means comparing two
 *    strings on one screen rather than fetching the card again.
 *  - **Every row is editable.** OCR gets a letter wrong; retyping one character
 *    is much better than abandoning the whole flow.
 *  - **The screen says whether the text was read exactly or guessed.** Those
 *    are different levels of trust and the user is entitled to know which one
 *    they are being offered.
 */

import { useCallback, useEffect, useState } from 'react';

import type { Candidate } from '@/documents/extract';
import type { DocumentExtraction } from '@/background/document-service';
import { labelFor } from '@/ui/lib/field-groups';
import { errorMessage, isLockedError, send } from '@/ui/lib/client';

interface Props {
  documentId: string;
  documentLabel: string;
  onLocked: () => void;
  onSaved: (count: number) => void;
  onClose: () => void;
}

type Draft = { value: string; checked: boolean };

const SOURCE_TEXT: Record<DocumentExtraction['source'], string> = {
  'pdf-text-layer':
    'Read directly from the document, so these characters are exact — but still worth a glance.',
  ocr: 'Recognised from an image. Please compare each value against the card before saving.',
  none: 'Nothing could be read from this document.',
};

export function ExtractedDetails({ documentId, documentLabel, onLocked, onSaved, onClose }: Props) {
  const [result, setResult] = useState<DocumentExtraction | null>(null);
  const [drafts, setDrafts] = useState<Map<string, Draft>>(new Map());
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const extraction = await send({ type: 'doc:extract', id: documentId });
        if (cancelled) return;
        setResult(extraction);
        setDrafts(
          new Map(
            extraction.candidates.map((candidate) => [
              candidate.key,
              { value: candidate.value, checked: candidate.suggestChecked },
            ]),
          ),
        );
      } catch (err) {
        if (cancelled) return;
        if (isLockedError(err)) return onLocked();
        setError(errorMessage(err));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [documentId, onLocked]);

  const update = useCallback((key: string, patch: Partial<Draft>) => {
    setDrafts((was) => {
      const next = new Map(was);
      const current = next.get(key);
      if (current) next.set(key, { ...current, ...patch });
      return next;
    });
  }, []);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    let saved = 0;
    try {
      for (const [key, draft] of drafts) {
        if (!draft.checked || draft.value.trim() === '') continue;
        await send({
          type: 'vault:set',
          key: key as Parameters<typeof labelFor>[0],
          value: draft.value.trim(),
          // Recorded as read-from-a-document rather than typed. See db.ts.
          fromDocument: true,
        });
        saved += 1;
      }
      onSaved(saved);
    } catch (err) {
      if (isLockedError(err)) return onLocked();
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [drafts, onLocked, onSaved]);

  const ticked = [...drafts.values()].filter((d) => d.checked).length;

  return (
    <section aria-labelledby="extract-heading" className="mt-2 rounded border border-slate-300 bg-white p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 id="extract-heading" className="text-sm font-semibold">
          Details found in {documentLabel}
        </h3>
        <button type="button" onClick={onClose} className="text-xs text-slate-500 underline">
          Close
        </button>
      </div>

      {busy && result === null && <p className="mt-2 text-xs text-slate-500">Reading…</p>}

      {error !== null && (
        <p role="alert" className="mt-2 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-700">
          {error}
        </p>
      )}

      {result !== null && (
        <>
          <p className="mt-1 text-[11px] text-slate-600">{SOURCE_TEXT[result.source]}</p>

          {result.warnings.map((warning) => (
            <p
              key={warning}
              role="status"
              className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900"
            >
              {warning}
            </p>
          ))}

          {result.notes.map((note) => (
            <p key={note} className="mt-1 text-[11px] text-slate-500">
              {note}
            </p>
          ))}

          {result.candidates.length === 0 ? (
            <p className="mt-2 text-xs text-slate-600">
              No details could be read from this document. You can still type them in yourself.
            </p>
          ) : (
            <>
              <ul className="mt-3 space-y-3">
                {result.candidates.map((candidate) => (
                  <Row
                    key={candidate.key}
                    candidate={candidate}
                    draft={drafts.get(candidate.key)!}
                    onChange={(patch) => update(candidate.key, patch)}
                  />
                ))}
              </ul>

              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={busy || ticked === 0}
                  className="rounded bg-blue-700 px-3 py-1.5 text-xs font-medium text-white disabled:bg-slate-300"
                >
                  {ticked === 0
                    ? 'Tick what to save'
                    : `Save ${ticked} detail${ticked === 1 ? '' : 's'} to my vault`}
                </button>
              </div>
              <p className="mt-2 text-[11px] text-slate-500">
                Only ticked details are saved. Nothing has been saved yet.
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}

function Row({
  candidate,
  draft,
  onChange,
}: {
  candidate: Candidate;
  draft: Draft;
  onChange: (patch: Partial<Draft>) => void;
}) {
  const inputId = `extract-${candidate.key}`;

  return (
    <li className="flex gap-2">
      <input
        type="checkbox"
        checked={draft.checked}
        onChange={(event) => onChange({ checked: event.target.checked })}
        aria-labelledby={`${inputId}-label`}
        className="mt-1.5"
      />
      <div className="min-w-0 flex-1">
        <label id={`${inputId}-label`} htmlFor={inputId} className="text-xs font-medium text-slate-800">
          {labelFor(candidate.key)}
        </label>

        <input
          id={inputId}
          value={draft.value}
          onChange={(event) => onChange({ value: event.target.value })}
          className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
        />

        <p className="mt-0.5 text-[11px] text-slate-500">
          {candidate.verified ? (
            <span className="text-emerald-700">
              Check digit verified — this number is not a misreading.
            </span>
          ) : (
            <>Read from: “{candidate.evidence}”</>
          )}
        </p>
      </div>
    </li>
  );
}
