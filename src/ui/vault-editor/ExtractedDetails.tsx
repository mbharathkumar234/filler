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
 *  - **And the piece of the card itself**, when the text was recognised from a
 *    picture. The value and the quoted line both came from the same reading: a
 *    "3" misread as an "8" is an "8" in both, and they agree. The picture is the
 *    one thing on this screen the reader did not produce.
 *  - **Every row is editable.** OCR gets a letter wrong; retyping one character
 *    is much better than abandoning the whole flow.
 *  - **The screen says whether the text was read exactly or guessed.** Those
 *    are different levels of trust and the user is entitled to know which one
 *    they are being offered.
 *
 * ## A dozen rows at once
 *
 * An ID card yields two or three values; a marks card yields a dozen — name,
 * parents, board, school, register number, date of birth, subjects, total,
 * percentage, result. As a flat list that is a wall, and a wall is skimmed. So
 * the rows are grouped under the same headings the vault editor uses, in the
 * same order, which turns the list into something recognisable: *this is the
 * Class 10 block, filled in*. Each group has its own tick-all, because thirteen
 * separate clicks is its own way of making somebody stop reading — and every
 * value stays visible beside the line it came from either way.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { DocumentExtraction, ExtractedCandidate } from '@/background/document-service';
import { groupFor, groupOrder, labelFor } from '@/ui/lib/field-groups';
import { errorMessage, isLockedError, send } from '@/ui/lib/client';

interface Props {
  documentId: string;
  documentLabel: string;
  onLocked: () => void;
  onSaved: (count: number) => void;
  onClose: () => void;
}

type Draft = { value: string; checked: boolean };

/**
 * Detail, value, tick. The detail column is kept narrow: in the side panel the
 * row is about 250 pixels, and every pixel the label does not need is one the
 * value can show.
 */
const ROW_COLUMNS = 'grid-cols-[minmax(5rem,6.5rem)_1fr_auto]';

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

  /** Tick a whole group, or untick it if it is already fully ticked. */
  const tickAll = useCallback((rows: ExtractedCandidate[]) => {
    setDrafts((was) => {
      const next = new Map(was);
      const checked = !rows.every((row) => next.get(row.key)?.checked === true);
      for (const row of rows) {
        const current = next.get(row.key);
        if (current) next.set(row.key, { ...current, checked });
      }
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

          {result.text.trim() !== '' && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] text-slate-600 underline">
                Show the text that was read{confidenceNote(result.engineConfidence)}
              </summary>
              {/*
               * The escape hatch. Recognition on a photograph is never perfect,
               * and a user who can see what was read can copy the one value the
               * rules missed — instead of being told only that nothing was
               * found. It stays on this machine: this is an extension page.
               */}
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-slate-200 bg-slate-50 p-2 text-[11px] text-slate-700">
                {result.text}
              </pre>
            </details>
          )}

          {result.candidates.length === 0 ? (
            <p className="mt-2 text-xs text-slate-600">
              No details could be read from this document. You can still type them in yourself.
            </p>
          ) : (
            <>
              <div className="mt-3 space-y-4">
                {sectionsOf(result.candidates).map((section) => (
                  <div key={section.id}>
                    <div className="flex items-baseline justify-between gap-2 border-b border-slate-200 pb-1">
                      <h4
                        id={`extract-section-${section.id}`}
                        className="text-[11px] font-semibold uppercase tracking-wide text-slate-500"
                      >
                        {section.title}
                      </h4>
                      {section.rows.length > 1 && (
                        <button
                          type="button"
                          onClick={() => tickAll(section.rows)}
                          className="text-[11px] text-blue-700 underline"
                        >
                          {section.rows.every((row) => drafts.get(row.key)?.checked === true)
                            ? `Untick all ${section.rows.length}`
                            : `Tick all ${section.rows.length}`}
                        </button>
                      )}
                    </div>

                    {/*
                     * Detail against value, the way the card itself reads, with
                     * the tick at the end of each pair. A column of labels above
                     * a column of boxes is a form; a document's details are a
                     * table, and checking one against the card in your hand is
                     * reading across a line, not down a page.
                     */}
                    <div
                      aria-hidden="true"
                      className={`mt-2 grid ${ROW_COLUMNS} gap-2 border-b border-slate-100 pb-1 text-[10px] uppercase tracking-wide text-slate-400`}
                    >
                      <span>Detail</span>
                      <span>Value read</span>
                      <span>Save</span>
                    </div>

                    <ul aria-labelledby={`extract-section-${section.id}`} className="divide-y divide-slate-100">
                      {section.rows.map((candidate) => (
                        <Row
                          key={candidate.key}
                          candidate={candidate}
                          draft={drafts.get(candidate.key)!}
                          onChange={(patch) => update(candidate.key, patch)}
                        />
                      ))}
                    </ul>
                  </div>
                ))}
              </div>

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

/**
 * How sure the engine was, in words, and only when it is worth saying.
 *
 * A number out of a hundred means nothing to somebody holding a marks card. "It
 * struggled with this one" tells them what to do about it — take the photo
 * again — which is the only useful thing a low score implies.
 */
function confidenceNote(confidence: number | undefined): string {
  if (confidence === undefined || confidence >= 0.75) return '';
  return confidence < 0.55
    ? ' — the engine struggled with this picture, so expect mistakes'
    : ' — parts of this picture were hard to read';
}

interface Section {
  id: string;
  title: string;
  rows: ExtractedCandidate[];
}

/**
 * The candidates, in the blocks of the vault editor they will be saved into.
 *
 * Group order follows the editor's own; within a group the reader's order is
 * kept, which is most-confident first. A key no block claims is not filed under
 * a heading it does not belong to — it goes last, under its own.
 */
export function sectionsOf(candidates: ExtractedCandidate[]): Section[] {
  const sections = new Map<string, Section>();

  for (const candidate of candidates) {
    const group = groupFor(candidate.key);
    const id = group?.id ?? 'other';
    const section = sections.get(id) ?? { id, title: group?.title ?? 'Other details', rows: [] };
    section.rows.push(candidate);
    sections.set(id, section);
  }

  return [...sections.values()].sort((a, b) => groupOrder(a.id) - groupOrder(b.id));
}

function Row({
  candidate,
  draft,
  onChange,
}: {
  candidate: ExtractedCandidate;
  draft: Draft;
  onChange: (patch: Partial<Draft>) => void;
}) {
  const inputId = `extract-${candidate.key}`;
  const field = useRef<HTMLTextAreaElement>(null);
  /** Whether the picture is shown at its own size rather than fitted to the row. */
  const [fullSize, setFullSize] = useState(false);
  /** Whether fitting it to the row made it smaller than it is. */
  const [shrunk, setShrunk] = useState(false);

  // As tall as the value, so every word of it is on screen to compare with the
  // card. (CSS can do this with `field-sizing`, which the oldest Chrome this
  // supports does not have.)
  useLayoutEffect(() => {
    const box = field.current;
    if (box === null) return;
    box.style.height = 'auto';
    // The scroll height is the text and its padding; the box is sized border
    // to border, so its two borders are added back or the last line is clipped.
    box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`;
  }, [draft.value]);

  return (
    <li className={`grid ${ROW_COLUMNS} items-start gap-x-2 gap-y-1 py-1.5`}>
      <label
        id={`${inputId}-label`}
        htmlFor={inputId}
        className="pt-1.5 text-xs font-medium text-slate-800"
      >
        {labelFor(candidate.key)}
      </label>

      {/*
       * Wraps like a paragraph, saves like the one line it is. The side panel
       * leaves the value about a hundred pixels, and a one-line box showed the
       * start of a name and scrolled the rest out of sight.
       */}
      <textarea
        id={inputId}
        ref={field}
        rows={1}
        value={draft.value}
        onChange={(event) => onChange({ value: event.target.value.replace(/\s*[\r\n]+\s*/g, ' ') })}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.preventDefault();
        }}
        className="min-w-0 w-full resize-none overflow-hidden rounded border border-slate-300 px-2 py-1 text-sm leading-snug"
      />

      {/* At the end of the pair: the last thing you do, after reading across. */}
      <input
        type="checkbox"
        checked={draft.checked}
        onChange={(event) => onChange({ checked: event.target.checked })}
        aria-labelledby={`${inputId}-label`}
        className="mt-2 h-4 w-4"
      />

      {/*
       * Under the pair, across the whole row. In the value's column the picture
       * was squeezed to that column's hundred pixels, and a row of a marks
       * table came out as a sliver nobody could read.
       */}
      <div data-evidence className="col-span-3 min-w-0">
        {candidate.crop !== undefined && (
          <>
            <div className={fullSize ? 'overflow-x-auto' : ''}>
              <img
                src={`data:image/jpeg;base64,${candidate.crop}`}
                alt={`The part of the document ${labelFor(candidate.key)} was read from`}
                onLoad={(event) => {
                  const picture = event.currentTarget;
                  setShrunk(picture.naturalWidth > picture.clientWidth + 1);
                }}
                className={`block h-auto rounded border border-slate-200 bg-slate-50 ${
                  fullSize ? 'max-w-none' : 'max-w-full'
                }`}
              />
            </div>
            {(shrunk || fullSize) && (
              <button
                type="button"
                onClick={() => setFullSize((was) => !was)}
                className="mt-0.5 text-[11px] text-blue-700 underline"
              >
                {fullSize ? 'Fit the picture to the panel' : 'Show the picture at full size'}
              </button>
            )}
          </>
        )}

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
