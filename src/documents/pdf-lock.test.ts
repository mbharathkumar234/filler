import { describe, expect, it } from 'vitest';

import { admitPdf, lockFromError, type PdfLock } from './pdf-lock';

/**
 * A PDF that opens only with a password (§ documents).
 *
 * An e-Aadhaar is downloaded locked, and so is an e-PAN. Unopened, a locked
 * PDF reads as nothing and cannot be made into a copy a portal will take. The
 * user types its password once, when the file is saved; these tests pin what
 * saving does with it. Opening the file itself is pdf.js's job, and is proved
 * in a real browser against real locked files (`e2e/pdf-lock.spec.ts`).
 */

describe('what pdf.js says when a PDF is locked', () => {
  // pdf.js rejects with a `PasswordException` whose code is one of its
  // `PasswordResponses`: 1 when no password was given, 2 when it was wrong.
  const exception = (code: number) => Object.assign(new Error('locked'), { name: 'PasswordException', code });

  it('reads "no password given" as a file that needs one', () => {
    expect(lockFromError(exception(1))).toBe('needs-password');
  });

  it('reads "incorrect password" as a wrong one', () => {
    expect(lockFromError(exception(2))).toBe('wrong-password');
  });

  it('asks for a password when the reason is one it does not know', () => {
    // Asking is the answer that can be put right; "corrupt" is not.
    expect(lockFromError(exception(99))).toBe('needs-password');
  });

  it('says nothing about passwords for any other failure', () => {
    expect(lockFromError(Object.assign(new Error('Invalid PDF structure.'), { name: 'InvalidPDFException' }))).toBeNull();
    expect(lockFromError(new Error('boom'))).toBeNull();
    expect(lockFromError('not even an error')).toBeNull();
  });
});

describe('saving a PDF', () => {
  /** A file that opens without a password, or only with `password`. */
  const file = (password?: string) => {
    const tried: Array<string | undefined> = [];
    const probe = async (given?: string): Promise<PdfLock> => {
      tried.push(given);
      if (password === undefined) return 'open';
      if (given === undefined) return 'needs-password';
      return given === password ? 'open' : 'wrong-password';
    };
    return { probe, tried };
  };

  it('saves a PDF that opens by itself, and keeps no password', async () => {
    const { probe } = file();
    await expect(admitPdf(probe)).resolves.toEqual({ save: true });
  });

  it('keeps no password for a file that never needed one, even if one was typed', async () => {
    // Many certificates carry an owner password that restricts printing and
    // nothing else: they open freely, and the vault keeps nothing it need not.
    const { probe } = file();
    await expect(admitPdf(probe, 'typed anyway')).resolves.toEqual({ save: true });
  });

  it('asks for the password of a locked file, and saves nothing yet', async () => {
    const { probe } = file('RAVI1998');
    await expect(admitPdf(probe)).resolves.toEqual({ save: false, locked: 'needs-password' });
    await expect(admitPdf(probe, '')).resolves.toEqual({ save: false, locked: 'needs-password' });
  });

  it('says so when the password does not open it, and saves nothing', async () => {
    const { probe } = file('RAVI1998');
    await expect(admitPdf(probe, 'ravi1998')).resolves.toEqual({ save: false, locked: 'wrong-password' });
  });

  it('saves a locked file with the password that opened it', async () => {
    const { probe, tried } = file('RAVI1998');
    await expect(admitPdf(probe, 'RAVI1998')).resolves.toEqual({ save: true, password: 'RAVI1998' });
    // Tried as it is first: the password is only kept when it is needed.
    expect(tried).toEqual([undefined, 'RAVI1998']);
  });
});
