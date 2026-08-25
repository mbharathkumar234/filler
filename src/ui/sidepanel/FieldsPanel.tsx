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
import type { FillReport } from '@/background/fill-service';
import type { FieldDescriptor, MatchResult } from '@/shared/types';
import { bandOf, type MatchBand } from '@/matching';
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

export function FieldsPanel({ onFilled }: { onFilled?: (tabId: number) => void }) {
  const [harvest, setHarvest] = useState<TabHarvest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [fill, setFill] = useState<FillReport | null>(null);

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
      setFill(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const runFill = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        setError('No active tab.');
        return;
      }
      setFill(await send({ type: 'fill:tab', tabId: tab.id }));
      // The review screen is the point of the fill, so it opens as soon as
      // there is something to review rather than waiting to be asked for.
      onFilled?.(tab.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [onFilled]);

  const undo = useCallback(async () => {
    setBusy(true);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      await send({ type: 'fill:undo:tab', tabId: tab.id });
      setFill(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const shown = harvest?.fields.filter((f) => showHidden || f.visible) ?? [];
  const matchByRef = new Map((harvest?.matches ?? []).map((m) => [m.fieldRef, m]));
  const mapped = (harvest?.matches ?? []).filter((m) => bandOf(m) !== 'unmapped').length;
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
        Reads the page only when you press Scan. Nothing is ever submitted without your approval.
      </p>

      {harvest && harvest.matches.some((m) => bandOf(m) !== 'unmapped') && (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => void runFill()}
            disabled={busy}
            className="rounded bg-emerald-700 px-2 py-1 text-xs text-white disabled:bg-slate-300"
          >
            {busy ? 'Filling…' : 'Fill this form'}
          </button>
          {fill && (
            <button
              type="button"
              onClick={() => void undo()}
              disabled={busy}
              className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700"
            >
              Undo
            </button>
          )}
        </div>
      )}

      {fill && (
        <div className="mt-2 rounded border border-emerald-300 bg-emerald-50 p-2 text-xs text-emerald-900">
          <p className="font-medium">
            Filled {fill.filled} of {fill.attempted} fields
            {fill.aborted && ' — aborted'}
          </p>
          <p className="mt-0.5 text-emerald-800">
            Nothing has been submitted. Check every value before you approve.
          </p>
          {fill.records.filter((r) => r.truncated).length > 0 && (
            <p className="mt-0.5 text-amber-800">
              {fill.records.filter((r) => r.truncated).length} value(s) were shortened to fit —
              check them.
            </p>
          )}
          {fill.records.filter((r) => r.fuzzy).length > 0 && (
            <p className="mt-0.5 text-amber-800">
              {fill.records.filter((r) => r.fuzzy).length} dropdown(s) were matched approximately.
            </p>
          )}
          {fill.records.filter((r) => r.fillFailed).length > 0 && (
            <p className="mt-0.5 text-red-700">
              {fill.records.filter((r) => r.fillFailed).length} field(s) would not accept a value.
            </p>
          )}
          {fill.skippedLowConfidence.length > 0 && (
            <p className="mt-0.5 text-slate-700">
              {fill.skippedLowConfidence.length} field(s) left blank — not confident enough.
            </p>
          )}
          {fill.blocked > 0 && (
            <p className="mt-0.5 text-red-700">
              Blocked {fill.blocked} submission attempt(s) during the run.
            </p>
          )}
        </div>
      )}

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
            {harvest.matches.length > 0 && (
              <p className="mt-0.5 text-slate-600">
                {mapped} of {harvest.matches.length} mapped
                {harvest.profileUsed && (
                  <span className="text-slate-500">
                    {' '}· profile {harvest.profileUsed.siteId} v{harvest.profileUsed.version}
                  </span>
                )}
              </p>
            )}
            {harvest.profileStale && (
              <p className="mt-0.5 text-amber-700">
                Saved profile {harvest.profileStale.siteId} v{harvest.profileStale.version} is
                stale ({Math.round(harvest.profileStale.resolveRate * 100)}% of its selectors
                resolve) — using rules instead.
              </p>
            )}
            {harvest.sameAsPermanent && (
              <p className="mt-0.5 text-slate-500">
                Found a “same as permanent address” checkbox.
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
              <FieldRow
                key={`${field.frameId}-${field.ref}`}
                field={field}
                harvest={harvest}
                match={matchByRef.get(field.ref)}
              />
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

const BAND_STYLE: Record<MatchBand, string> = {
  'auto-fill': 'border-emerald-300 bg-emerald-50',
  'fill-and-flag': 'border-amber-300 bg-amber-50',
  unmapped: 'border-slate-200',
};

const BAND_LABEL: Record<MatchBand, string> = {
  'auto-fill': 'will fill',
  'fill-and-flag': 'fill & check',
  unmapped: 'not mapped',
};

function FieldRow({
  field,
  harvest,
  match,
}: {
  field: FieldDescriptor;
  harvest: TabHarvest;
  match: MatchResult | undefined;
}) {
  const frame = harvest.frames.find((f) => f.frameId === field.frameId);
  const source = frame?.labelSources[field.ref];
  const band: MatchBand = match ? bandOf(match) : 'unmapped';

  return (
    <li className={`rounded border p-1.5 text-xs ${BAND_STYLE[band]}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-slate-800">
          {field.labelText || <em className="text-amber-800">unlabelled</em>}
        </span>
        <span className="shrink-0 text-[10px] text-slate-400">
          {field.tag}
          {field.type && field.type !== field.tag ? `/${field.type}` : ''}
        </span>
      </div>

      {match && match.key !== 'unknown' && (
        <p className="mt-0.5 text-[11px] text-slate-700">
          → <span className="font-mono">{match.key}</span>
          <span className="ml-1 text-slate-500">
            {BAND_LABEL[band]} · {Math.round(match.confidence * 100)}%
            {match.source === 'profile' && ' · from profile'}
          </span>
        </p>
      )}
      {match && match.key === 'unknown' && (
        <p className="mt-0.5 text-[11px] text-slate-500">→ not mapped</p>
      )}
      {match && (
        <p className="mt-0.5 text-[10px] text-slate-400">{match.rationale}</p>
      )}

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
