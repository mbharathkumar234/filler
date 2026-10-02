/**
 * The review screen (§ Phase 7).
 *
 * *"The user's last line of defence. Make it genuinely reviewable, not a
 * rubber stamp."* The plan's acceptance test is a user-testing pass with one
 * deliberately wrong value planted, and three people out of three catching it.
 *
 * Four decisions follow from that, and they are the whole design:
 *
 *  1. **Flagged fields are hoisted to the top**, before the full list. A flag
 *     at row 34 of 40 is decoration.
 *  2. **Every flagged field must be individually ticked** before the approval
 *     control unlocks. This is the single most important thing on the screen:
 *     it makes "I looked at it" an action rather than an assumption, and it is
 *     the difference between a review and a rubber stamp.
 *  3. **Approval is a hold, not a click**, and it expires in ninety seconds.
 *  4. **The submit target is named in the approval line.** The user approves
 *     "Final Submit", not an abstraction — if that word is not what they
 *     expect to press, something is wrong and they can see it.
 *
 * Nothing here can submit. It asks the worker, which holds the only token.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReviewPayload } from '@/background/review-service';
import { needsAttention } from '@/runtime/review';
import type { FieldKey } from '@/matching/taxonomy';
import { isFieldKey } from '@/matching/taxonomy';
import { errorMessage, send } from '@/ui/lib/client';
import { DocumentReview } from './DocumentReview';
import { HoldToConfirm } from './HoldToConfirm';
import { ReviewRow } from './ReviewRow';

type Phase = 'reviewing' | 'armed' | 'submitted';

export function ReviewScreen({ tabId, onDone }: { tabId: number; onDone?: () => void }) {
  const [payload, setPayload] = useState<ReviewPayload | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<Phase>('reviewing');
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setPayload(await send({ type: 'review:build', tabId }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [tabId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The approval clock. Shown because ninety seconds of silence followed by a
  // refusal is a worse experience than a visible countdown.
  useEffect(() => {
    if (expiresAt === null) return;
    const tick = () => {
      const left = Math.max(0, expiresAt - Date.now());
      setRemaining(left);
      if (left === 0) {
        setPhase('reviewing');
        setExpiresAt(null);
        setNotice('Your approval timed out. Check the form and approve again.');
      }
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [expiresAt]);

  const model = payload?.model ?? null;
  const attention = model?.attention ?? [];
  const outstanding = useMemo(
    () => attention.filter((row) => !checked.has(row.ref)),
    [attention, checked],
  );

  const humanStep = payload?.blockers.find((b) => b.type === 'captcha' || b.type === 'otp');
  const canApprove =
    model !== null &&
    payload?.submit !== null &&
    outstanding.length === 0 &&
    humanStep === undefined &&
    !busy;

  const onCheck = useCallback((ref: string, isChecked: boolean) => {
    setChecked((was) => {
      const next = new Set(was);
      if (isChecked) next.add(ref);
      else next.delete(ref);
      return next;
    });
  }, []);

  const onHighlight = useCallback(
    (ref: string) => {
      void send({ type: 'field:highlight', tabId, ref }).catch(() => {
        // The page may have navigated. Not worth an error banner.
      });
    },
    [tabId],
  );

  const onEdit = useCallback(
    async (ref: string, value: string, saveToVault: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const row = model?.rows.find((r) => r.ref === ref);
        const key: FieldKey | undefined =
          saveToVault && row?.key && isFieldKey(row.key) ? row.key : undefined;

        await send({
          type: 'field:edit',
          tabId,
          ref,
          value,
          ...(key === undefined ? {} : { saveKey: key }),
        });

        // An edit invalidates an approval: what the user approved is not what
        // is on the page any more. Making them approve again is the point.
        if (phase === 'armed') {
          await send({ type: 'approval:revoke', tabId });
          setPhase('reviewing');
          setExpiresAt(null);
          setNotice('You changed a value, so the approval was cancelled. Approve again when ready.');
        }
        await load();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [load, model, phase, tabId],
  );

  const grant = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await send({ type: 'approval:grant', tabId });
      setExpiresAt(result.expiresAt);
      setPhase('armed');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [tabId]);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await send({ type: 'approval:submit', tabId });
      if (result.submitted) {
        setPhase('submitted');
        setExpiresAt(null);
        onDone?.();
      } else {
        setPhase('reviewing');
        setExpiresAt(null);
        setNotice(result.why ?? 'Nothing was submitted.');
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [onDone, tabId]);

  const cancel = useCallback(async () => {
    await send({ type: 'approval:revoke', tabId }).catch(() => {});
    setPhase('reviewing');
    setExpiresAt(null);
  }, [tabId]);

  if (error) {
    return (
      <section className="border-t border-slate-200 p-4">
        <p role="alert" className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-700">
          {error}
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-2 rounded border border-slate-300 px-2 py-1 text-xs"
        >
          Try again
        </button>
      </section>
    );
  }

  if (!model) {
    return (
      <section className="border-t border-slate-200 p-4 text-xs text-slate-500">
        {busy ? 'Reading the form…' : 'Nothing to review yet.'}
      </section>
    );
  }

  if (phase === 'submitted') {
    return (
      <section className="border-t border-slate-200 p-4">
        <p className="rounded border border-emerald-300 bg-emerald-50 p-2 text-sm text-emerald-900">
          Submitted. Check the portal&rsquo;s own confirmation page for your reference number.
        </p>
      </section>
    );
  }

  return (
    <section className="border-t border-slate-200 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">Check before you submit</h2>
        <button
          type="button"
          onClick={() => void load()}
          disabled={busy}
          className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-700"
        >
          Re-read page
        </button>
      </div>

      <p className="mt-1 text-xs text-slate-600">
        {model.counts.filled} of {model.counts.total} fields filled
        {model.counts.flagged > 0 && ` · ${model.counts.flagged} need checking`}
        {model.counts.requiredBlank > 0 && ` · ${model.counts.requiredBlank} required still empty`}
      </p>

      {notice && (
        <p role="status" className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          {notice}
        </p>
      )}

      {humanStep && (
        <p className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          {humanStep.reason} You will not be able to approve until it is done.
        </p>
      )}

      {attention.length > 0 && (
        <div className="mt-3">
          <h3 className="text-xs font-semibold text-slate-900">
            {attention.length} field{attention.length === 1 ? '' : 's'} to check
            {outstanding.length > 0 && (
              <span className="ml-1 font-normal text-slate-500">
                ({outstanding.length} not yet ticked)
              </span>
            )}
          </h3>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Tick each one once you have checked it against the page. Submission stays locked until
            you have.
          </p>
          <ul className="mt-1.5 space-y-1.5">
            {attention.map((row) => (
              <ReviewRow
                key={row.ref}
                row={row}
                checked={checked.has(row.ref)}
                onCheck={onCheck}
                onHighlight={onHighlight}
                onEdit={onEdit}
                busy={busy}
              />
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3">
        <h3 className="text-xs font-semibold text-slate-900">Everything filled</h3>
        {model.sections.map((section) => {
          const rows = section.refs
            .map((ref) => model.rows.find((row) => row.ref === ref))
            .filter((row): row is NonNullable<typeof row> => row !== undefined)
            .filter((row) => !needsAttention(row));
          if (rows.length === 0) return null;

          return (
            <div key={section.id} className="mt-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                {section.title}
              </p>
              <ul className="mt-1 space-y-1.5">
                {rows.map((row) => (
                  <ReviewRow
                    key={row.ref}
                    row={row}
                    checked={checked.has(row.ref)}
                    onCheck={onCheck}
                    onHighlight={onHighlight}
                    onEdit={onEdit}
                    busy={busy}
                  />
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      {payload && (
        <DocumentReview tabId={tabId} documents={payload.documents} onChanged={() => void load()} />
      )}

      <div className="mt-4 rounded border border-slate-300 bg-slate-50 p-3">
        {payload?.submit === null || payload?.submit === undefined ? (
          <p className="text-xs text-slate-600">
            No submit button was found on this page, so there is nothing to approve. Submit it
            yourself when you are ready.
          </p>
        ) : phase === 'armed' ? (
          <>
            <p className="text-xs text-slate-800">
              Approved. Press submit within{' '}
              <strong>{Math.ceil(remaining / 1000)}s</strong>, or the approval lapses.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void submit()}
                className="flex-1 rounded bg-emerald-700 px-3 py-2 text-sm font-medium text-white disabled:bg-slate-300"
              >
                Submit “{payload.submit.label}”
              </button>
              <button
                type="button"
                onClick={() => void cancel()}
                className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-700"
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <p id="hold-hint" className="text-xs text-slate-700">
              This will press <strong>“{payload.submit.label}”</strong> on the page, once. Hold the
              button below for a moment to approve — a single click will not do it.
            </p>
            {outstanding.length > 0 && (
              <p className="mt-1 text-xs text-amber-800">
                Tick the {outstanding.length} field{outstanding.length === 1 ? '' : 's'} above
                first.
              </p>
            )}
            <div className="mt-2">
              <HoldToConfirm
                label={`Hold to approve “${payload.submit.label}”`}
                holdingLabel="Keep holding…"
                disabled={!canApprove}
                onConfirm={() => void grant()}
              />
            </div>
          </>
        )}
        <p className="mt-2 text-[11px] text-slate-500">
          Nothing is sent until you approve. Your approval is good for 90 seconds and covers exactly
          one submission.
        </p>
      </div>
    </section>
  );
}
