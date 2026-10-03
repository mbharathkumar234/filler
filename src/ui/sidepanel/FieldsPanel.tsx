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
import { RequestFailed, errorMessage, send } from '@/ui/lib/client';
import { originPatternOf } from '@/background/injection-failure';
import { TeachPanel } from '@/ui/review/TeachPanel';
import { EarlyGuardPanel } from '@/ui/review/EarlyGuardPanel';
import { ReauthPrompt } from '@/ui/lib/ReauthPrompt';
import { labelFor } from '@/ui/lib/field-groups';
import { DocumentSlots } from './DocumentSlots';

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
  'question-heading': 'question heading',
  none: 'no label found',
};

/** A document that did not go in, as something the user can act on. */
function remedyFor(doc: FillReport['documents'][number]): string {
  if (doc.code === 'no-master') return `No ${labelFor(doc.key)} saved yet — add it under Documents.`;
  return doc.reason ?? 'It could not be attached.';
}

export function FieldsPanel({ onFilled }: { onFilled?: (tabId: number) => void }) {
  const [harvest, setHarvest] = useState<TabHarvest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [fill, setFill] = useState<FillReport | null>(null);
  /**
   * Set when the scan failed only for want of permission on this site.
   *
   * Kept separate from `error` because it is the one failure with a button
   * attached: the user can fix it here, and a message without the button was
   * the whole problem with the old wording.
   */
  const [needsHost, setNeedsHost] = useState<string | null>(null);
  /** Origin we could be granted permanently, offered after a successful scan. */
  const [offerAlways, setOfferAlways] = useState<string | null>(null);
  /** The worker's re-auth sentence, while the passphrase prompt is up. */
  const [reauth, setReauth] = useState<string | null>(null);

  const scan = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNeedsHost(null);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        setError('No active tab.');
        return;
      }
      const result = await send({ type: 'harvest:tab', tabId: tab.id });
      setHarvest(result);
      setFill(null);

      /*
       * Now — and only now — we know which site this is.
       *
       * Chrome withholds `tab.url` without permission, so the first moment the
       * origin is knowable is after a scan has already succeeded, from the
       * content script's own report. Offering the permanent grant here is what
       * stops the user clicking the toolbar icon after every navigation.
       */
      const pattern = originPatternOf(result.url);
      if (pattern !== null) {
        const held = await chrome.permissions
          .contains({ origins: [pattern] })
          .catch(() => true);
        setOfferAlways(held ? null : pattern);
      }
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof RequestFailed && err.code === 'NEEDS_HOST_PERMISSION' && err.detail) {
        setNeedsHost(err.detail);
      }
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * Ask Chrome for this site, then scan again.
   *
   * `chrome.permissions.request` needs a user gesture, which is why it runs
   * straight off the click rather than anywhere tidier.
   */
  const allowSite = useCallback(async (pattern: string) => {
    try {
      const granted = await chrome.permissions.request({ origins: [pattern] });
      if (!granted) {
        setError('Access was not granted, so this page still cannot be read.');
        return;
      }
      setNeedsHost(null);
      setOfferAlways(null);
      await scan();
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [scan]);

  const runFill = useCallback(async () => {
    setBusy(true);
    setError(null);
    setReauth(null);
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
      // A signature or an Aadhaar card on the form, and the passphrase last
      // entered a while ago: ask for it here, then fill.
      if (err instanceof RequestFailed && err.code === 'REAUTH_REQUIRED') setReauth(err.message);
      else setError(errorMessage(err));
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

      {needsHost !== null && (
        <button
          type="button"
          onClick={() => void allowSite(needsHost)}
          className="mt-2 w-full rounded bg-blue-700 px-3 py-2 text-xs font-medium text-white"
        >
          Allow this site, then scan again
        </button>
      )}

      {offerAlways !== null && (
        <div className="mt-2 rounded border border-slate-300 bg-slate-50 p-2">
          <p className="text-[11px] text-slate-700">
            Chrome only lets this extension read a page until you navigate away. Allow this site
            once and it will keep working here without clicking the toolbar icon each time.
          </p>
          <div className="mt-1.5 flex gap-2">
            <button
              type="button"
              onClick={() => void allowSite(offerAlways)}
              className="rounded bg-blue-700 px-2 py-1 text-[11px] font-medium text-white"
            >
              Always allow this site
            </button>
            <button
              type="button"
              onClick={() => setOfferAlways(null)}
              className="text-[11px] text-slate-500 underline"
            >
              Not now
            </button>
          </div>
        </div>
      )}

      {harvest &&
        (harvest.matches.some((m) => bandOf(m) !== 'unmapped') ||
          harvest.uploadSlots.some((slot) => slot.kind === 'drop' && slot.key !== null)) && (
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
          {(fill.skippedOtherScript?.length ?? 0) > 0 && (
            <p className="mt-0.5 text-slate-700">
              {fill.skippedOtherScript!.length} name field(s) left blank — they ask for the name in a
              language your vault does not hold it in.
            </p>
          )}
          {fill.blocked > 0 && (
            <p className="mt-0.5 text-red-700">
              Blocked {fill.blocked} submission attempt(s) during the run.
            </p>
          )}
          {fill.documents.length + fill.unrecognisedUploads.length > 0 && (
            <div className="mt-1.5 border-t border-emerald-200 pt-1.5">
              {/*
                The denominator is every upload the page has, not the ones the
                extension could name: "3 of 3" on a page with five read as done.
              */}
              <p className="font-medium">
                Attached {fill.documents.filter((d) => d.attached).length} of{' '}
                {fill.documents.length + fill.unrecognisedUploads.length} upload
                {fill.documents.length + fill.unrecognisedUploads.length === 1 ? '' : 's'} on this
                page
              </p>
              <ul className="mt-0.5 space-y-0.5">
                {fill.documents.map((doc) => (
                  <li key={doc.ref} className={doc.attached ? 'text-emerald-800' : 'text-amber-800'}>
                    {doc.attached ? '✓' : '✗'} {doc.portalLabel}
                    {doc.attached && doc.variant
                      ? ` — ${Math.round(doc.variant.bytes / 1024)} KB, fitted to ${doc.requirement}`
                      : doc.attached
                        ? ''
                        : ` — ${remedyFor(doc)}`}
                  </li>
                ))}
                {fill.unrecognisedUploads.map((upload) => (
                  <li key={upload.ref} className="text-amber-800">
                    ? {upload.label} — could not tell which document this asks for. Nothing was
                    attached; use the page's own button to add it.
                  </li>
                ))}
              </ul>
              {fill.documents.some((d) => d.attached && d.uploadButton) && (
                <p className="mt-0.5 text-emerald-800">
                  This form has its own Upload buttons. Approve each upload on the review screen and
                  the extension presses it for you.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {reauth !== null && (
        <ReauthPrompt
          message={reauth}
          onConfirmed={() => {
            setReauth(null);
            void runFill();
          }}
          onCancel={() => setReauth(null)}
        />
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

          <DocumentSlots tabId={harvest.tabId} slots={harvest.uploadSlots} />

          {harvest.llmNotice && (
            <p className="mt-2 rounded border border-slate-200 bg-slate-50 p-2 text-[11px] text-slate-600">
              {harvest.llmNotice}
            </p>
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

          {/*
            § Phase 9. Offered on every scanned page rather than only when
            something is broken: a user who spots a wrong mapping should not
            have to wait for the extension to agree that it is wrong.
          */}
          <div className="-mx-4 mt-3">
            <EarlyGuardPanel tabId={harvest.tabId} />
            <TeachPanel
              tabId={harvest.tabId}
              fingerprint={harvest.fingerprint}
              health={harvest.profileHealth}
              unmappedCount={harvest.matches.filter((m) => m.key === 'unknown').length}
              onTaught={() => void scan()}
            />
          </div>
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
