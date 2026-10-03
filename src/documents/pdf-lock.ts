/**
 * A PDF that opens only with a password (§ documents).
 *
 * An e-Aadhaar is downloaded locked, and so is an e-PAN. Unopened, a locked PDF
 * reads as nothing, and the copy a portal is given cannot be made from it. So
 * the user is asked for the password once, when they save the file, and it is
 * kept with the document, sealed in the vault like the document itself
 * (`vault/document-store.ts`): every later reading and every portal copy opens
 * the file with it, and nothing asks again.
 *
 * It is the user who types it. The vault holds enough to build an e-Aadhaar's
 * password itself — four letters of the name, the year of birth — and that was
 * offered and turned down: the person whose file it is opens it.
 *
 * The decision is pure over a probe, so it is tested without a PDF engine; the
 * probe itself is pdf.js, proved against real locked files in a real browser.
 */

import { openPdf } from './pdfjs';

/** How a PDF opened: by itself, not without a password, or not with the one given. */
export type PdfLock = 'open' | 'needs-password' | 'wrong-password';

/** pdf.js's `PasswordResponses`, which it reports as the exception's code. */
const INCORRECT_PASSWORD = 2;

/** The lock a pdf.js failure describes, or null when it failed for another reason. */
export function lockFromError(error: unknown): Exclude<PdfLock, 'open'> | null {
  if (typeof error !== 'object' || error === null) return null;
  const { name, code } = error as { name?: unknown; code?: unknown };
  if (name !== 'PasswordException') return null;
  // Any code but "incorrect" is a request for one: asking can be put right.
  return code === INCORRECT_PASSWORD ? 'wrong-password' : 'needs-password';
}

/**
 * Try to open a PDF — with `password`, if one is given.
 *
 * Throws for a file that is not a PDF pdf.js can open at all; a locked one is
 * an answer, not an error.
 */
export async function pdfLock(bytes: Uint8Array, password?: string): Promise<PdfLock> {
  const task = await openPdf(bytes, password);
  try {
    await task.promise;
    return 'open';
  } catch (error) {
    const lock = lockFromError(error);
    if (lock === null) throw error;
    return lock;
  } finally {
    await task.destroy();
  }
}

/** What saving a PDF does: store it, with a password only if it needs one, or ask. */
export type PdfAdmission =
  | { save: true; password?: string }
  | { save: false; locked: 'needs-password' | 'wrong-password' };

/**
 * Whether to save a PDF, and with what.
 *
 * Tried as it is first: a file that opens by itself is saved with no password,
 * even if one was typed — many certificates carry an owner password that only
 * restricts printing, and the vault keeps nothing it does not need. A file that
 * needs one is saved only once the password given opens it.
 */
export async function admitPdf(
  probe: (password?: string) => Promise<PdfLock>,
  password?: string,
): Promise<PdfAdmission> {
  if ((await probe()) === 'open') return { save: true };
  if (password === undefined || password === '') return { save: false, locked: 'needs-password' };
  return (await probe(password)) === 'open'
    ? { save: true, password }
    : { save: false, locked: 'wrong-password' };
}
