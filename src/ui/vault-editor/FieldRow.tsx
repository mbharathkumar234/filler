/**
 * One editable profile field.
 *
 * High-sensitivity values are masked until revealed (§6.3) and validated
 * before they are written.
 *
 * ## Saving
 *
 * Two ways in, on purpose. Blur still saves — tabbing down a form and having
 * each field commit as you leave it is the fast path, and removing it would
 * make filling sixty-nine fields a chore. But blur-only saving is *invisible*:
 * nothing on screen says the value is safe, so the honest reading of a field
 * that looks filled is "I hope that took". The explicit **Save** button is the
 * visible one, and it is the reason the row can report a state at all.
 *
 * The button suppresses `mousedown` so pressing it does not blur the input
 * first. Otherwise the blur handler would do the save and the click would land
 * on an already-disabled button — right outcome, wrong mechanism, and the kind
 * of accident that breaks the moment either half is touched.
 */

import { useEffect, useId, useState } from 'react';
import { sensitivityOf, type FieldKey } from '@/matching/taxonomy';
import { validateField } from '@/vault/validation';
import { inputTypeFor, labelFor } from '@/ui/lib/field-groups';

interface Props {
  fieldKey: FieldKey;
  value: string;
  onSave: (key: FieldKey, value: string) => Promise<void>;
}

export function FieldRow({ fieldKey, value, onSave }: Props) {
  const [draft, setDraft] = useState(value);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const inputId = useId();

  const sensitivity = sensitivityOf(fieldKey);
  const isHigh = sensitivity === 'high';
  const label = labelFor(fieldKey);
  const dirty = draft !== value;

  // Adopt an external change (a reload, or an import) unless mid-edit.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  async function commit() {
    if (draft === value || saving) return;

    const result = validateField(fieldKey, draft);
    if (!result.valid) {
      setError(result.message ?? 'That value does not look right.');
      return;
    }

    setError(null);
    setSaving(true);
    try {
      await onSave(fieldKey, draft);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="py-1.5">
      <label htmlFor={inputId} className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-slate-700">
          {label}
          {isHigh && (
            <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
              sensitive
            </span>
          )}
        </span>
        {saved && <span className="text-[10px] text-emerald-600">saved</span>}
        {!saved && dirty && <span className="text-[10px] text-amber-600">unsaved</span>}
      </label>

      <div className="mt-0.5 flex gap-1">
        <input
          id={inputId}
          type={isHigh && !revealed ? 'password' : inputTypeFor(fieldKey)}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onBlur={() => void commit()}
          aria-invalid={error !== null}
          aria-describedby={error ? `${inputId}-error` : undefined}
          className={`w-full rounded border px-2 py-1 text-sm focus:outline-none ${
            error ? 'border-red-400 focus:border-red-500' : 'border-slate-300 focus:border-slate-500'
          }`}
        />
        {isHigh && (
          <button
            type="button"
            onClick={() => setRevealed((r) => !r)}
            aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`}
            className="shrink-0 rounded border border-slate-300 px-2 text-xs text-slate-600 hover:bg-slate-50"
          >
            {revealed ? 'Hide' : 'Show'}
          </button>
        )}
        <button
          type="button"
          // Keep focus in the input so `onBlur` does not save it out from under us.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void commit()}
          disabled={!dirty || saving}
          // Sixty-nine rows means sixty-nine buttons called "Save"; the field
          // name is the only thing that tells them apart in a screen reader.
          aria-label={`Save ${label} to vault`}
          className={`shrink-0 rounded border px-2 text-xs ${
            dirty && !saving
              ? 'border-slate-800 bg-slate-800 text-white hover:bg-slate-700'
              : 'border-slate-200 bg-slate-50 text-slate-400'
          }`}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {error && (
        <p id={`${inputId}-error`} role="alert" className="mt-0.5 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
