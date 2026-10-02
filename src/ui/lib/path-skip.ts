/**
 * "I would rather not answer" (§ vault structure).
 *
 * The academic path itself is sealed in the vault, because it names a
 * reservation category. *Declining to give one* says nothing about anybody, so
 * it lives beside the other panel preferences in `chrome.storage.local` —
 * which also means it is readable while the vault is locked, and the setup
 * card does not flash up before the path has been read back.
 */

const SKIP_KEY = 'path:skipped';

export async function hasSkippedPath(): Promise<boolean> {
  try {
    const items = await chrome.storage.local.get(SKIP_KEY);
    return items[SKIP_KEY] === true;
  } catch {
    // A panel rendered outside the extension (a test, a storybook) simply has
    // nobody who has skipped anything.
    return false;
  }
}

export async function rememberPathSkipped(skipped: boolean): Promise<void> {
  try {
    await chrome.storage.local.set({ [SKIP_KEY]: skipped });
  } catch {
    /* the question is asked again next time, which is the safe failure */
  }
}
