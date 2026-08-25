/**
 * One editable profile field.
 *
 * High-sensitivity values are masked until revealed (§6.3), validated on blur,
 * and saved on blur rather than on every keystroke — a keystroke-level save
 * would mean encrypting and writing a partial Aadhaar number a dozen times.
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
  const inputId = useId();

  const sensitivity = sensitivityOf(fieldKey);
  const isHigh = sensitivity === 'high';

  // Adopt an external change (a reload, or an import) unless mid-edit.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  async function commit() {
    if (draft === value) return;

    const result = validateField(fieldKey, draft);
    if (!result.valid) {
      setError(result.message ?? 'That value does not look right.');
      return;
    }

    setError(null);
    try {
      await onSave(fieldKey, draft);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    }
  }

  return (
    <div className="py-1.5">
      <label htmlFor={inputId} className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-slate-700">
          {labelFor(fieldKey)}
          {isHigh && (
            <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
              sensitive
            </span>
          )}
        </span>
        {saved && <span className="text-[10px] text-emerald-600">saved</span>}
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
            aria-label={revealed ? 'Hide value' : 'Reveal value'}
            className="shrink-0 rounded border border-slate-300 px-2 text-xs text-slate-600 hover:bg-slate-50"
          >
            {revealed ? 'Hide' : 'Show'}
          </button>
        )}
      </div>

      {error && (
        <p id={`${inputId}-error`} role="alert" className="mt-0.5 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
