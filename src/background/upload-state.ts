/**
 * Documents whose Upload button the extension has already pressed, per tab.
 *
 * A postback empties the file box behind a successful upload, so without this
 * a second Fill would attach the same document again and the review would
 * offer to upload it twice. Held in the worker, like the fill records beside
 * it, and cleared with the run.
 *
 * Its own module because both `fill-service.ts` (skip these) and
 * `review-service.ts` (say so) read it, and each already depends on the other's
 * neighbour.
 */

import type { FieldKey } from '@/matching/taxonomy';

const uploaded = new Map<number, Set<FieldKey>>();

export function noteUploaded(tabId: number, key: FieldKey): void {
  const keys = uploaded.get(tabId) ?? new Set<FieldKey>();
  keys.add(key);
  uploaded.set(tabId, keys);
}

export function uploadedKeys(tabId: number): ReadonlySet<FieldKey> {
  return uploaded.get(tabId) ?? new Set();
}

export function forgetUploads(tabId: number): void {
  uploaded.delete(tabId);
}

/** Test seam. */
export function __resetUploadsForTests(): void {
  uploaded.clear();
}
