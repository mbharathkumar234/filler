/**
 * One hold, every upload window on the form (§ document attachment).
 *
 * On a Google Form a document is attached only by uploading it — into the
 * form owner's Drive — so it takes the same deliberate gesture as a submit.
 * One hold covers the form's documents; the worker then does each in turn:
 * opens its Add file, puts the fitted file in, waits for the window to finish.
 */

import { useState } from 'react';
import type { BatchItem } from '@/background/upload-window-service';
import type { FieldKey } from '@/matching/taxonomy';
import { labelFor } from '@/ui/lib/field-groups';
import { ReauthPrompt } from '@/ui/lib/ReauthPrompt';
import { RequestFailed, errorMessage, send } from '@/ui/lib/client';
import { HoldToConfirm } from './HoldToConfirm';

export function UploadAllHold({
  tabId,
  count,
  picks = {},
  onDone,
}: {
  tabId: number;
  /** How many documents the hold will upload. */
  count: number;
  /** The user's picks for questions the matcher could not place. */
  picks?: Readonly<Record<string, FieldKey>>;
  onDone?: (items: BatchItem[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<BatchItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reauth, setReauth] = useState<string | null>(null);

  if (count === 0) return null;

  async function run() {
    setBusy(true);
    setError(null);
    setReauth(null);
    try {
      const result = await send({
        type: 'approval:upload-all',
        tabId,
        ...(Object.keys(picks).length > 0 ? { picks: { ...picks } } : {}),
      });
      setItems(result.items);
      onDone?.(result.items);
    } catch (err) {
      if (err instanceof RequestFailed && err.code === 'REAUTH_REQUIRED') setReauth(err.message);
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-1.5 rounded border border-blue-200 bg-blue-50 p-2">
      <HoldToConfirm
        label={
          busy
            ? 'Uploading… keep this panel open'
            : `Hold to upload ${count} document${count === 1 ? '' : 's'} to this form`
        }
        holdingLabel="Keep holding…"
        disabled={busy}
        onConfirm={() => void run()}
      />
      <p className="mt-1 text-[10px] text-slate-600">
        One at a time, the extension presses each question’s Add file, puts your document in at the
        size the form asks for, and waits for the form to finish before the next. Each document goes
        to the form’s owner as it uploads.
      </p>

      {reauth && (
        <ReauthPrompt message={reauth} onConfirmed={() => void run()} onCancel={() => setReauth(null)} />
      )}

      {items && (
        <ul className="mt-1.5 space-y-0.5 text-[11px]">
          {items.map((item) => (
            <li
              key={item.ref}
              role={item.uploaded ? 'status' : 'alert'}
              className={item.uploaded ? 'text-emerald-800' : 'text-amber-800'}
            >
              {item.uploaded ? '✓' : '✗'} {item.label}
              {item.uploaded && item.key ? ` — your ${labelFor(item.key)}` : ''}
              {item.why ? ` — ${item.why}` : ''}
              {!item.uploaded && item.trace && item.trace.length > 0 && (
                <ol className="ml-4 mt-0.5 list-none font-mono text-[10px] text-slate-500">
                  {item.trace.map((step, index) => (
                    <li key={index}>{step}</li>
                  ))}
                </ol>
              )}
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p role="alert" className="mt-1 text-[11px] text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
