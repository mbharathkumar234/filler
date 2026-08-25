/**
 * Live harvested-field list (§ Phase 3 Must Achieve).
 *
 * This is the first screen that shows the user what the extension can see on a
 * page — and, just as importantly, what it *cannot*: cross-origin frames,
 * CAPTCHAs, and fields it failed to label. Phase 3 fills nothing, so this list
 * is the entire visible product for now, and it doubles as the tool for
 * checking the ">=95% labelled" bar by hand.
 */

import { useCallback, useState } from 'react';
import type { TabHarvest } from '@/background/harvest-service';
import type { FieldDescriptor } from '@/shared/types';
import { errorMessage, send } from '@/ui/lib/client';

const SOURCE_LABELS: Record<string, string> = {
  'label-for': 'label',
  'label-wrapping': 'wrapping label',
  'aria-labelledby': 'aria-labelledby',
  'aria-label': 'aria-label',
  'table-cell': 'table cell',
  'sibling-label': 'nearby label',
  'preceding-text': 'preceding text',
  placeholder: 'placeholder',
  title: 'title attribute',
  'name-attribute': 'field name',
  none: 'no label found',
};

export function FieldsPanel() {
  const [harvest, setHarvest] = useState<TabHarvest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  const scan = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        setError('No active tab.');
        return;
      }
      setHarvest(await send({ type: 'harvest:tab', tabId: tab.id }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const shown = harvest?.fields.filter((f) => showHidden || f.visible) ?? [];
  const labelledPercent =
    harvest && harvest.visibleCount > 0
      ? Math.round((harvest.labelledCount / harvest.visibleCount) * 100)
      : null;

  return (
    <section className="border-t border-slate-200 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">Fields on this page</h2>
        <button
          type="button"
          onClick={() => void scan()}
          disabled={busy}
          className="rounded bg-slate-900 px-2 py-1 text-xs text-white disabled:bg-slate-300"
        >
          {busy ? 'Reading…' : 'Scan page'}
        </button>
      </div>

      <p className="mt-1 text-xs text-slate-500">
        Reads the page only when you press Scan. Nothing is filled or submitted.
      </p>

      {error && (
        <p role="alert" className="mt-2 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-700">
          {error}
        </p>
      )}

      {harvest && (
        <>
          <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700">
            <p className="truncate font-medium">{harvest.title || harvest.url}</p>
            <p className="mt-0.5 text-slate-600">
              {harvest.fields.length} field{harvest.fields.length === 1 ? '' : 's'} ·{' '}
              {harvest.visibleCount} visible
              {labelledPercent !== null && (
                <>
                  {' · '}
                  <span className={labelledPercent >= 95 ? 'text-emerald-700' : 'text-amber-700'}>
                    {labelledPercent}% labelled
                  </span>
                </>
              )}
            </p>
            {harvest.frames.length > 1 && (
              <p className="mt-0.5 text-slate-500">
                across {harvest.frames.length} frames
              </p>
            )}
            {harvest.wizard && (
              <p className="mt-0.5 text-slate-500">
                Multi-step form
                {harvest.wizard.step !== null &&
                  ` — step ${harvest.wizard.step}${
                    harvest.wizard.totalSteps ? ` of ${harvest.wizard.totalSteps}` : ''
                  }`}
              </p>
            )}
            <p className="mt-0.5 font-mono text-[10px] text-slate-400">
              {harvest.fingerprint}
            </p>
          </div>

          {harvest.blockers.length > 0 && (
            <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-2">
              <p className="text-xs font-medium text-amber-900">
                {harvest.blockers.length} thing
                {harvest.blockers.length === 1 ? '' : 's'} we cannot handle for you
              </p>
              <ul className="mt-1 space-y-0.5">
                {harvest.blockers.map((blocker, i) => (
                  <li key={`${blocker.selector}-${i}`} className="text-[11px] text-amber-800">
                    {blocker.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <label className="mt-2 flex items-center gap-1.5 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
            />
            Show hidden fields ({harvest.fields.length - harvest.visibleCount})
          </label>

          <ul className="mt-2 space-y-1">
            {shown.map((field) => (
              <FieldRow key={`${field.frameId}-${field.ref}`} field={field} harvest={harvest} />
            ))}
          </ul>

          {shown.length === 0 && (
            <p className="mt-2 text-xs text-slate-500">No fillable fields found on this page.</p>
          )}
        </>
      )}
    </section>
  );
}

function FieldRow({ field, harvest }: { field: FieldDescriptor; harvest: TabHarvest }) {
  const frame = harvest.frames.find((f) => f.frameId === field.frameId);
  const source = frame?.labelSources[field.ref];

  return (
    <li
      className={`rounded border p-1.5 text-xs ${
        field.labelText ? 'border-slate-200' : 'border-amber-300 bg-amber-50'
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-slate-800">
          {field.labelText || <em className="text-amber-800">unlabelled</em>}
        </span>
        <span className="shrink-0 text-[10px] text-slate-400">
          {field.tag}
          {field.type && field.type !== field.tag ? `/${field.type}` : ''}
        </span>
      </div>

      <p className="mt-0.5 text-[10px] text-slate-500">
        {source && <>via {SOURCE_LABELS[source] ?? source}</>}
        {field.required && <span className="ml-1 text-slate-700">· required</span>}
        {!field.visible && <span className="ml-1">· hidden</span>}
        {!field.enabled && <span className="ml-1">· disabled</span>}
        {field.frameId !== 0 && <span className="ml-1">· frame {field.frameId}</span>}
      </p>

      {field.nearbyText && (
        <p className="mt-0.5 truncate text-[10px] text-slate-400">in {field.nearbyText}</p>
      )}

      {field.options && field.options.length > 0 && (
        <p className="mt-0.5 truncate text-[10px] text-slate-400">
          {field.options.length} options: {field.options.slice(0, 4).map((o) => o.text).join(', ')}
          {field.options.length > 4 && '…'}
        </p>
      )}

      <p className="mt-0.5 truncate font-mono text-[10px] text-slate-400">{field.selectors[0]}</p>
    </li>
  );
}
