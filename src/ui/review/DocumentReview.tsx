/**
 * The review's document section (§ Phase 7 Must, § document attachment).
 *
 * Each document the form asks for, the requirement beside what went in, and —
 * where the portal has its own Upload button beside the box — a hold to have
 * the extension press it. That button posts the whole form on most portals,
 * which is why it takes the same deliberate gesture as the final submit, and
 * why the worker, not this screen, decides which element it is.
 */

import { useState } from 'react';
import type { ReviewDocument } from '@/background/review-service';
import { shortMime } from '@/documents/constraints';
import { labelFor } from '@/ui/lib/field-groups';
import { errorMessage, send } from '@/ui/lib/client';
import { HoldToConfirm } from './HoldToConfirm';
import { UploadAllHold } from './UploadAllHold';

function describeFile(variant: NonNullable<ReviewDocument['variant']>): string {
  const size = `${shortMime(variant.mime)} · ${Math.round(variant.bytes / 1024)} KB`;
  // A PDF has no pixel size to report.
  return variant.width > 0 ? `${size} · ${variant.width}×${variant.height}` : size;
}

export function DocumentReview({
  tabId,
  documents,
  onChanged,
}: {
  tabId: number;
  documents: readonly ReviewDocument[];
  /** Re-read the page — after an upload it may have posted back. */
  onChanged: () => void;
}) {
  const [busyRef, setBusyRef] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, { text: string; ok: boolean }>>({});

  if (documents.length === 0) return null;

  async function upload(doc: ReviewDocument) {
    setBusyRef(doc.ref);
    try {
      const result = await send({ type: 'approval:upload', tabId, ref: doc.ref });
      setNotes((was) => ({
        ...was,
        [doc.ref]: result.pressed
          ? {
              ok: true,
              text: result.reloading
                ? 'Upload pressed. The page is reloading — press “Re-read page” when it is back.'
                : 'Upload pressed. Check the page shows the document as uploaded.',
            }
          : { ok: false, text: result.why ?? 'Nothing was pressed.' },
      }));
      if (result.pressed && !result.reloading) onChanged();
    } catch (err) {
      setNotes((was) => ({ ...was, [doc.ref]: { ok: false, text: errorMessage(err) } }));
    } finally {
      setBusyRef(null);
    }
  }

  return (
    <div className="mt-3">
      <h3 className="text-xs font-semibold text-slate-900">Documents this form wants</h3>
      <UploadAllHold
        tabId={tabId}
        count={documents.filter((doc) => doc.route === 'window' && !doc.attached && !doc.uploaded).length}
        onDone={() => onChanged()}
      />
      <ul className="mt-1 space-y-1.5">
        {documents.map((doc) => {
          const note = notes[doc.ref];
          const canUpload =
            doc.route === 'file-box' && doc.uploadButton !== null && doc.attached && !doc.uploaded;
          return (
            <li key={doc.ref} className="rounded border border-slate-200 p-2 text-xs">
              <p className="font-medium text-slate-800">{doc.portalLabel}</p>
              <p className="mt-0.5 text-[11px] text-slate-500">Asks for: {doc.requirement}</p>

              {doc.variant && (
                <p className="mt-0.5 text-[11px] text-slate-700">
                  {doc.attached ? 'In the form: ' : 'Prepared: '}
                  {labelFor(doc.key)}, {describeFile(doc.variant)}
                </p>
              )}
              {doc.uploaded && (
                <p className="mt-0.5 text-[11px] text-emerald-800">Uploaded in this run.</p>
              )}
              {doc.problem && !doc.uploaded && (
                <p className={`mt-0.5 text-[11px] ${doc.attached ? 'text-slate-600' : 'text-amber-800'}`}>
                  {doc.problem}
                </p>
              )}

              {canUpload && (
                <div className="mt-1.5">
                  <HoldToConfirm
                    label={`Hold to upload ${labelFor(doc.key)}`}
                    holdingLabel="Keep holding…"
                    disabled={busyRef !== null}
                    onConfirm={() => void upload(doc)}
                  />
                  <p className="mt-1 text-[10px] text-slate-500">
                    Presses the page’s own “{doc.uploadButton}” button once. On most portals that
                    sends the form, with this document, to the portal — nothing else in the form is
                    submitted as final.
                  </p>
                </div>
              )}

              {note && (
                <p
                  role={note.ok ? 'status' : 'alert'}
                  className={`mt-1 text-[11px] ${note.ok ? 'text-emerald-800' : 'text-amber-800'}`}
                >
                  {note.text}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
