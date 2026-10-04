/**
 * RBI's list of IFSC codes and India Post's PIN directory, read from the
 * extension's own package (`reference/`, packed by `vite.config.ts` →
 * `referenceData()`).
 *
 * Every lookup is a read of the extension's own files, by `chrome.runtime.getURL`
 * — never a server — so a code the user typed or a document printed is looked
 * up on this device and goes nowhere (`release-gates.test.ts` holds this file to
 * that one fetch). The IFSC list is one
 * zipped file per bank and only the bank asked about is opened; each file is
 * kept once opened, for as long as the worker lives.
 */

import type { ReferenceLookup } from '@/documents/reference-check';
import { ifscRecord, isIfsc, nearCodes, type IfscIndex, type IfscRecord, type IfscShard } from '@/reference/ifsc';
import { pinRecord, type PinRecord, type PinTable } from '@/reference/pincode';
import type { ReferenceRequest, Result } from '@/shared/messages';

/** One of the packaged files, by its path under `reference/`; null when the build has none. */
export type LoadReferenceFile = (path: string) => Promise<Uint8Array | null>;

async function fromPackage(path: string): Promise<Uint8Array | null> {
  const response = await fetch(chrome.runtime.getURL(`reference/${path}`));
  return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
}

/** A zipped JSON file, unzipped by the browser itself. */
async function unzipped<T>(bytes: Uint8Array): Promise<T> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text()) as T;
}

/**
 * A file read once and kept; a failed read is forgotten, so the next lookup
 * tries again rather than inheriting the failure.
 */
function once<T>(read: () => Promise<T>): () => Promise<T> {
  let kept: Promise<T> | null = null;
  return () => {
    kept ??= read().catch((error: unknown) => {
      kept = null;
      throw error;
    });
    return kept;
  };
}

const PIN = /^[1-9][0-9]{5}$/;

export function createReferenceLookup(load: LoadReferenceFile = fromPackage): ReferenceLookup {
  const missing = (what: string) => new Error(`${what} is missing from this build of the extension.`);

  const index = once(async () => {
    const bytes = await load('ifsc/index.json');
    if (bytes === null) throw missing('RBI’s IFSC list');
    return JSON.parse(new TextDecoder().decode(bytes)) as IfscIndex;
  });
  const banks = new Map<string, () => Promise<IfscShard>>();
  const shard = (bank: string) => {
    let read = banks.get(bank);
    if (read === undefined) {
      read = once(async () => {
        const bytes = await load(`ifsc/${bank}.json.gz`);
        if (bytes === null) throw missing(`The IFSC list for bank ${bank}`);
        return unzipped<IfscShard>(bytes);
      });
      banks.set(bank, read);
    }
    return read();
  };
  const pins = once(async () => {
    const bytes = await load('pincode.json.gz');
    if (bytes === null) throw missing('India Post’s PIN directory');
    return unzipped<PinTable>(bytes);
  });

  return {
    async ifsc(code) {
      if (!isIfsc(code)) return null;
      const known = await index();
      const bank = code.slice(0, 4);
      // A bank the list does not have: answered from the index alone.
      if (!(bank in known.banks)) return null;
      return ifscRecord(known, await shard(bank), code);
    },
    async ifscNear(code) {
      const known = await index();
      const bank = code.slice(0, 4).toUpperCase();
      if (!(bank in known.banks)) return [];
      return nearCodes(known, await shard(bank), code);
    },
    async pincode(pin) {
      if (!PIN.test(pin)) return null;
      return pinRecord(await pins(), pin);
    },
  };
}

/** The lookups this worker uses: the lists in this package. */
export const referenceLookup: ReferenceLookup = createReferenceLookup();

/**
 * An IFSC or PIN the user typed in the vault editor, looked up for it. A list
 * missing from the build is an error, never "not in the list".
 */
export async function handleReferenceRequest(
  request: ReferenceRequest,
  lookup: ReferenceLookup = referenceLookup,
): Promise<Result<IfscRecord | PinRecord | null>> {
  try {
    const data = request.type === 'ref:ifsc' ? await lookup.ifsc(request.code) : await lookup.pincode(request.pin);
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'RBI’s and India Post’s lists could not be read.' };
  }
}
