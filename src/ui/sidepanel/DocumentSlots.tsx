/**
 * Upload questions with no file box of their own (§ document attachment).
 *
 * Two kinds, and they get different help:
 *
 *  - a **drop area** is filled by "Fill this form" like any file box, so it is
 *    only listed here;
 *  - an **upload window** (Google Forms' "Add file") does not exist until the
 *    user opens it. So the steps are the user's, then ours, then the user's:
 *    click the form's Add file, press "Put … in the upload window", press the
 *    window's own Upload. The extension never presses anything in it.
 *
 * When the window will not take the file, the last resort is a copy the user
 * chooses themselves — offered only then, because it leaves a copy on disk.
 */

import { useEffect, useRef, useState } from 'react';
import type { MatchedSlot } from '@/background/harvest-service';
import type { WindowPlacement } from '@/background/upload-window-service';
import { describeConstraint } from '@/documents/constraints';
import { fileNameFor } from '@/documents/field-constraint';
import { DOCUMENT_GROUPS, labelFor } from '@/ui/lib/field-groups';
import type { FieldKey } from '@/matching/taxonomy';
import { ReauthPrompt } from '@/ui/lib/ReauthPrompt';
import { UploadAllHold } from '@/ui/review/UploadAllHold';
import { RequestFailed, errorMessage, send } from '@/ui/lib/client';

interface SlotState {
  busy?: boolean;
  result?: WindowPlacement;
  /** The last mode tried, so the second try can be the other one. */
  tried?: 'box' | 'drop';
  error?: string | undefined;
  reauth?: string | undefined;
  /** A prepared copy for the user to choose themselves: the last resort. */
  copy?: { url: string; name: string };
}

export function DocumentSlots({ tabId, slots }: { tabId: number; slots: readonly MatchedSlot[] }) {
  const [states, setStates] = useState<Record<string, SlotState>>({});
  /** The user's pick for a question the matcher could not place. */
  const [picked, setPicked] = useState<Record<string, FieldKey>>({});
  const urls = useRef<string[]>([]);

  useEffect(
    () => () => {
      for (const url of urls.current) URL.revokeObjectURL(url);
    },
    [],
  );

  // Every upload question is listed, placed or not: one the matcher could
  // not read is shown with a picker, never silently dropped.
  if (slots.length === 0) return null;
  const keyOf = (slot: MatchedSlot): FieldKey | null => slot.key ?? picked[slot.ref] ?? null;

  const update = (ref: string, next: SlotState) =>
    setStates((was) => ({ ...was, [ref]: { ...was[ref], ...next } }));

  async function put(slot: MatchedSlot, mode: 'box' | 'drop') {
    update(slot.ref, { busy: true, error: undefined, reauth: undefined });
    try {
      const result = await send({
        type: 'doc:to-window',
        tabId,
        slotRef: slot.ref,
        ...(mode === 'drop' ? { mode: 'drop' as const } : {}),
        ...(slot.key === null && picked[slot.ref] ? { key: picked[slot.ref] } : {}),
      });
      update(slot.ref, { busy: false, result, tried: mode });
    } catch (err) {
      if (err instanceof RequestFailed && err.code === 'REAUTH_REQUIRED') {
        update(slot.ref, { busy: false, reauth: err.message, tried: mode });
        return;
      }
      update(slot.ref, { busy: false, error: errorMessage(err) });
    }
  }

  async function allow(slot: MatchedSlot, pattern: string) {
    try {
      // Needs the click's gesture, so it runs straight off it.
      const granted = await chrome.permissions.request({ origins: [pattern] });
      if (granted) await put(slot, 'box');
      else update(slot.ref, { error: 'Access was not granted, so the upload window cannot be reached.' });
    } catch (err) {
      update(slot.ref, { error: errorMessage(err) });
    }
  }

  async function prepareCopy(slot: MatchedSlot) {
    const key = keyOf(slot);
    if (key === null) return;
    update(slot.ref, { busy: true, error: undefined });
    try {
      const derived = await send({ type: 'doc:derive', key, constraint: slot.constraint });
      if ('failed' in derived) {
        update(slot.ref, { busy: false, error: derived.reason });
        return;
      }
      const url = URL.createObjectURL(new Blob([Uint8Array.from(derived.bytes)], { type: derived.mime }));
      urls.current.push(url);
      update(slot.ref, { busy: false, copy: { url, name: fileNameFor(key, derived.mime) } });
    } catch (err) {
      update(slot.ref, { busy: false, error: errorMessage(err) });
    }
  }

  return (
    <div className="mt-3 rounded border border-slate-200 p-2">
      <h3 className="text-xs font-semibold text-slate-900">Documents this form wants</h3>
      <UploadAllHold
        tabId={tabId}
        count={slots.filter((slot) => slot.kind === 'window' && keyOf(slot) !== null).length}
        picks={Object.fromEntries(
          slots.filter((slot) => slot.key === null && picked[slot.ref]).map((slot) => [slot.ref, picked[slot.ref]!]),
        )}
      />
      {slots.some((slot) => slot.kind === 'window') && (
        <p className="mt-1.5 text-[10px] text-slate-500">Or one at a time, by hand:</p>
      )}
      <ul className="mt-1.5 space-y-2">
        {slots.map((slot) => {
          const key = keyOf(slot);
          const name = key ? labelFor(key) : 'document';
          const state = states[slot.ref] ?? {};
          const result = state.result;

          return (
            <li key={slot.ref} className="rounded border border-slate-200 p-2 text-xs">
              <p className="font-medium text-slate-800">{slot.label}</p>
              <p className="mt-0.5 text-[11px] text-slate-500">
                {slot.key ? `Your ${name}` : 'Not sure which document'} · asks for{' '}
                {describeConstraint(slot.constraint)}
              </p>

              {slot.key === null && (
                <label className="mt-1 block text-[11px] text-slate-700">
                  Which document is this?{' '}
                  <select
                    value={picked[slot.ref] ?? ''}
                    onChange={(event) =>
                      setPicked((was) => ({ ...was, [slot.ref]: event.target.value as FieldKey }))
                    }
                    className="rounded border border-slate-300 px-1 py-0.5 text-[11px]"
                  >
                    <option value="">Choose…</option>
                    {/* Grouped as the vault is, so a list of forty-odd
                        documents is read the way it was filled. */}
                    {DOCUMENT_GROUPS.map((group) => (
                      <optgroup key={group.id} label={group.title}>
                        {group.keys.map((doc) => (
                          <option key={doc} value={doc}>
                            {labelFor(doc)}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
              )}

              {slot.kind === 'drop' ? (
                <p className="mt-1 text-[11px] text-slate-600">
                  Dropped into the form’s upload area when you press “Fill this form”.
                </p>
              ) : (
                <>
                  <ol className="mt-1 list-decimal pl-4 text-[11px] text-slate-600">
                    <li>Click the form’s own Add file button.</li>
                    <li>Press “Put {name} in the upload window” below.</li>
                    <li>Press Upload in the form’s window yourself.</li>
                  </ol>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => void put(slot, 'box')}
                      disabled={state.busy || key === null}
                      className="rounded bg-blue-700 px-2 py-1 text-[11px] font-medium text-white disabled:bg-slate-300"
                    >
                      {state.busy ? 'Working…' : `Put ${name} in the upload window`}
                    </button>
                    <button
                      type="button"
                      onClick={() => void send({ type: 'field:highlight', tabId, ref: slot.ref }).catch(() => {})}
                      aria-label={`Show me where the form asks for ${name}`}
                      className="rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-700"
                    >
                      Show me
                    </button>
                  </div>
                </>
              )}

              {state.reauth && (
                <ReauthPrompt
                  message={state.reauth}
                  onConfirmed={() => void put(slot, state.tried ?? 'box')}
                  onCancel={() => update(slot.ref, { reauth: undefined })}
                />
              )}

              {result?.placed && (
                <div role="status" className="mt-1.5 rounded border border-emerald-300 bg-emerald-50 p-1.5 text-[11px] text-emerald-900">
                  <p>
                    {name} is in the upload window
                    {result.variant ? ` (${Math.round(result.variant.bytes / 1024)} KB)` : ''}. Press
                    Upload there to finish.
                  </p>
                  {state.tried === 'box' && (
                    <p className="mt-0.5">
                      Not showing in the window?{' '}
                      <button type="button" onClick={() => void put(slot, 'drop')} className="underline">
                        Try dropping it in instead
                      </button>
                    </p>
                  )}
                </div>
              )}

              {result && !result.placed && (
                <div role="alert" className="mt-1.5 rounded border border-amber-300 bg-amber-50 p-1.5 text-[11px] text-amber-900">
                  <p>{result.why ?? 'The file could not be put in the upload window.'}</p>
                  {result.code === 'no-master' && <p className="mt-0.5">Add your {name} under Documents first.</p>}
                  {result.origin && (
                    <button type="button" onClick={() => void allow(slot, result.origin!)} className="mt-1 underline">
                      Allow the upload window’s site, then try again
                    </button>
                  )}
                  {result.code !== 'no-window' && result.code !== 'no-master' && !state.copy && (
                    <p className="mt-1">
                      Last resort:{' '}
                      <button type="button" onClick={() => void prepareCopy(slot)} className="underline">
                        prepare a copy to choose yourself
                      </button>
                    </p>
                  )}
                </div>
              )}

              {state.copy && (
                <p className="mt-1.5 text-[11px] text-slate-700">
                  <a href={state.copy.url} download={state.copy.name} className="font-medium text-blue-700 underline">
                    Save {state.copy.name}
                  </a>{' '}
                  — then choose it in the form’s upload window. A copy stays in your Downloads folder
                  until you delete it.
                </p>
              )}

              {state.error && (
                <p role="alert" className="mt-1.5 text-[11px] text-red-700">
                  {state.error}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
