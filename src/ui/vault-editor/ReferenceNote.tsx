/**
 * What RBI's or India Post's list says of a code just saved, under its row
 * (`ui/lib/reference-offer.ts`): the branch or the place, and the empty boxes
 * it can fill. Nothing is written until "Fill these in" is pressed.
 */

import { Fragment } from 'react';

import type { FieldKey } from '@/matching/taxonomy';
import { labelFor } from '@/ui/lib/field-groups';
import type { ReferenceOffer } from '@/ui/lib/reference-offer';

interface Props {
  offer: ReferenceOffer;
  onFill: (fills: Array<[FieldKey, string]>) => void;
  onClose: () => void;
}

export function ReferenceNote({ offer, onFill, onClose }: Props) {
  return (
    <div
      role="status"
      className={`mb-2 rounded border p-2 text-xs ${
        offer.found ? 'border-slate-200 bg-slate-50 text-slate-700' : 'border-amber-300 bg-amber-50 text-amber-900'
      }`}
    >
      <p>{offer.message}</p>
      {offer.fills.length > 0 ? (
        <>
          <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
            {offer.fills.map(([key, value]) => (
              <Fragment key={key}>
                <dt className="text-slate-500">{labelFor(key)}</dt>
                <dd className="min-w-0 break-words">{value}</dd>
              </Fragment>
            ))}
          </dl>
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              onClick={() => onFill(offer.fills)}
              className="rounded bg-slate-800 px-2 py-1 text-white hover:bg-slate-700"
            >
              Fill these in
            </button>
            <button type="button" onClick={onClose} className="underline hover:text-slate-900">
              Not now
            </button>
          </div>
        </>
      ) : (
        <button type="button" onClick={onClose} className="mt-1 underline">
          Close
        </button>
      )}
    </div>
  );
}
