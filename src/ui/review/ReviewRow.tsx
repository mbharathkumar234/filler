/**
 * One field on the review screen (§ Phase 7).
 *
 * The layout is an argument about what the user is doing here. They are not
 * auditing our matcher; they are checking their own data against a form they
 * can see. So:
 *
 *  - **The value is the largest thing in the row.** It is what they compare
 *    against what they know. Our key, our confidence and our rationale are
 *    supporting evidence in small print, available and not in the way.
 *  - **The portal's label sits directly above it**, because that is the phrase
 *    they will look for on the page.
 *  - **A flag is a sentence, not a colour.** "Dropdown matched approximately —
 *    check it is the right option" tells someone what to do. An amber border
 *    tells them something is different.
 *
 * A flagged row carries its own checkbox, and the submit control stays locked
 * until every one is ticked. That is the difference between a review screen
 * and a rubber stamp: the user cannot approve past the rows we were unsure
 * about without looking at each one.
 */

import { useState } from 'react';
import { FLAG_TEXT, maskValue, worstFlag, type ReviewRow as Row } from '@/runtime/review';
import { labelFor } from '@/ui/lib/field-groups';
import { isFieldKey } from '@/matching/taxonomy';

const FLAG_STYLE: Record<string, string> = {
  'fill-failed': 'border-red-300 bg-red-50',
  'required-empty': 'border-red-300 bg-red-50',
  'fuzzy-select': 'border-amber-300 bg-amber-50',
  truncated: 'border-amber-300 bg-amber-50',
  'llm-matched': 'border-amber-300 bg-amber-50',
  'low-confidence': 'border-amber-300 bg-amber-50',
  'skipped-low-confidence': 'border-slate-300 bg-slate-50',
};

export function ReviewRow({
  row,
  checked,
  onCheck,
  onHighlight,
  onEdit,
  busy,
}: {
  row: Row;
  checked: boolean;
  onCheck: (ref: string, checked: boolean) => void;
  onHighlight: (ref: string) => void;
  onEdit: (ref: string, value: string, saveToVault: boolean) => Promise<void>;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.value);
  const [saveToVault, setSaveToVault] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const worst = worstFlag(row);
  const sensitive = row.sensitivity === 'high';
  const shown = sensitive && !revealed ? maskValue(row.value) : row.value;

  return (
    <li className={`rounded border p-2 ${worst ? FLAG_STYLE[worst] : 'border-slate-200'}`}>
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={() => onHighlight(row.ref)}
          className="flex-1 text-left"
          title="Show me this field on the page"
        >
          <span className="text-xs font-semibold text-slate-900">{row.portalLabel}</span>
          {row.required && <span className="ml-1 text-xs text-red-600">*</span>}
        </button>
        {worst && (
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => onCheck(row.ref, event.target.checked)}
            aria-label={`I have checked ${row.portalLabel}`}
            className="mt-0.5 shrink-0"
          />
        )}
      </div>

      {editing ? (
        <div className="mt-1.5">
          {row.options && row.options.length > 0 ? (
            <select
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="w-full rounded border border-slate-300 px-1.5 py-1 text-sm"
            >
              {row.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.text}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={row.maxLength}
              autoFocus
              className="w-full rounded border border-slate-300 px-1.5 py-1 font-mono text-sm"
            />
          )}

          {row.key !== null && isFieldKey(row.key) && (
            <label className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-600">
              <input
                type="checkbox"
                checked={saveToVault}
                onChange={(event) => setSaveToVault(event.target.checked)}
              />
              Also save this to my vault as “{labelFor(row.key)}”
            </label>
          )}

          <div className="mt-1.5 flex gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void onEdit(row.ref, draft, saveToVault).then(() => setEditing(false));
              }}
              className="rounded bg-slate-900 px-2 py-0.5 text-xs text-white disabled:bg-slate-300"
            >
              Update the page
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(row.value);
                setEditing(false);
              }}
              className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-700"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-1 flex items-baseline gap-2">
          <span
            className={`flex-1 break-all font-mono text-sm ${
              row.value.trim() === '' ? 'text-slate-400 italic' : 'text-slate-900'
            }`}
          >
            {row.value.trim() === '' ? 'empty' : shown}
          </span>
          {sensitive && row.value.trim() !== '' && (
            <button
              type="button"
              onClick={() => setRevealed((was) => !was)}
              className="shrink-0 text-[11px] text-slate-500 underline"
            >
              {revealed ? 'Hide' : 'Reveal'}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setDraft(row.value);
              setEditing(true);
            }}
            className="shrink-0 text-[11px] text-slate-500 underline"
          >
            Edit
          </button>
        </div>
      )}

      {row.flags.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {row.flags.map((flag) => (
            <li key={flag} className="text-[11px] text-slate-700">
              {FLAG_TEXT[flag]}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-1 text-[10px] text-slate-400">
        {row.key ?? 'not mapped'}
        {row.confidence > 0 && ` · ${Math.round(row.confidence * 100)}% confident`}
        {row.source && ` · ${row.source}`}
        {row.rationale && ` · ${row.rationale}`}
      </p>
    </li>
  );
}
