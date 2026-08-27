/**
 * Explaining why a page could not be read (§ found in use).
 *
 * ## Why this is a module and not two lines in a catch block
 *
 * It used to be two lines in a catch block, and they were wrong. Any injection
 * error matching `/cannot be scripted|Cannot access/i` was reported as:
 *
 *   "This page cannot be read — Chrome blocks extensions on it (a store page,
 *    a PDF viewer, or a settings page)."
 *
 * On a Google Form that is false. Chrome does not block extensions on
 * `docs.google.com`. What actually happened is that `activeTab` had lapsed —
 * Chrome grants it when the user invokes the extension and **revokes it on
 * navigation** — so the refusal was "Cannot access contents of the page",
 * which matched the regex and was then dressed up as something it was not.
 *
 * A confident wrong explanation is worse than a vague right one. This one sent
 * the user off to conclude the extension cannot read Google Forms, when the
 * answer was one click on the toolbar icon.
 *
 * ## The distinction that matters
 *
 * Not "which error string is this" — Chrome's wording changes between versions
 * and says little about the cause. The useful question is **can the user do
 * anything about it**, and that is answered by the URL:
 *
 *  - `chrome://`, `devtools://`, another extension, the Web Store: genuinely
 *    closed to every extension. Say so plainly; offering a permission here
 *    would be a dead end.
 *  - A PDF or a `file://` page: closed for their own reasons, each with its
 *    own remedy.
 *  - Anything else on http(s): **a permission the user can grant**, and the
 *    message has to say how.
 *
 * Every branch carries a remedy, because a message that only says no is the
 * thing this module exists to stop shipping.
 */

export type InjectionProblem =
  | 'restricted-scheme'
  | 'other-extension'
  | 'web-store'
  | 'pdf-viewer'
  | 'local-file'
  | 'no-permission'
  | 'unknown';

export interface InjectionFailure {
  problem: InjectionProblem;
  /** What happened, in the user's terms. */
  message: string;
  /** What to do about it. Never empty. */
  remedy: string;
  /** Can this be fixed by granting a host permission? */
  grantable: boolean;
  /** The pattern to request, when `grantable`. */
  origin?: string;
}

/** Schemes no extension may script, whatever it asks for. */
const CLOSED_SCHEMES = new Set([
  'chrome:',
  'edge:',
  'brave:',
  'opera:',
  'vivaldi:',
  'about:',
  'devtools:',
  'view-source:',
  'chrome-search:',
  'chrome-untrusted:',
]);

/** The Web Store, which Chrome protects specifically. */
function isWebStore(host: string, path: string): boolean {
  if (host === 'chromewebstore.google.com') return true;
  // The old store lived under a path on a host that serves much else.
  return host === 'chrome.google.com' && path.startsWith('/webstore');
}

/**
 * Does this error mean "you are not allowed", as opposed to anything else?
 *
 * Matched loosely on purpose: Chrome's exact wording varies by version, and
 * these are the phrases it has used for a refusal of access. Anything that does
 * not match is reported as itself rather than guessed at.
 */
function isPermissionRefusal(detail: string): boolean {
  return /cannot access|host permission|cannot be scripted|not allowed/i.test(detail);
}

export function explainInjectionFailure(url: string, error: unknown): InjectionFailure {
  const detail = error instanceof Error ? error.message : String(error ?? 'unknown error');

  let parsed: URL | null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }

  if (parsed === null) {
    return {
      problem: 'unknown',
      message: `This page could not be read: ${detail}`,
      remedy: 'Try reloading the page, then press Scan again.',
      grantable: false,
    };
  }

  if (parsed.protocol === 'chrome-extension:') {
    return {
      problem: 'other-extension',
      message: 'This is another extension’s page, which Chrome keeps closed to everything else.',
      remedy: 'Open the form you want to fill in an ordinary tab, then press Scan there.',
      grantable: false,
    };
  }

  if (CLOSED_SCHEMES.has(parsed.protocol)) {
    return {
      problem: 'restricted-scheme',
      message: 'This is a browser page, and Chrome does not let any extension read it.',
      remedy: 'Open the form you want to fill in an ordinary tab, then press Scan there.',
      grantable: false,
    };
  }

  if (isWebStore(parsed.hostname, parsed.pathname)) {
    return {
      problem: 'web-store',
      message: 'Chrome does not let extensions read the Chrome Web Store.',
      remedy: 'Open the form you want to fill in an ordinary tab, then press Scan there.',
      grantable: false,
    };
  }

  if (parsed.protocol === 'file:') {
    return {
      problem: 'local-file',
      message: 'This is a file on your computer, and extensions cannot read those by default.',
      remedy:
        'To allow it: go to chrome://extensions, open this extension’s Details, and turn on “Allow access to file URLs”.',
      grantable: false,
    };
  }

  // A PDF is rendered by Chrome's own viewer, which no extension can script —
  // and unlike a permission, nothing the user grants will change that.
  if (parsed.pathname.toLowerCase().endsWith('.pdf')) {
    return {
      problem: 'pdf-viewer',
      message: 'This is a PDF, and Chrome’s PDF viewer cannot be read by extensions.',
      remedy:
        'If the form is a PDF you fill offline, download it and upload it under Documents instead. If there is a web version of the form, open that.',
      grantable: false,
    };
  }

  // The URL says *which page this is*; the error says whether the refusal was
  // about permission at all. Both are needed. Classifying on the URL alone
  // would tell somebody whose tab had simply closed that they need to grant a
  // permission — the same confident wrong explanation in a new place.
  if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && isPermissionRefusal(detail)) {
    return {
      problem: 'no-permission',
      message: `Not allowed to read ${parsed.hostname} yet.`,
      remedy:
        'Click the extension’s icon in the toolbar while this page is open — that grants access for this tab. To avoid doing it every time you come back, allow this site below.',
      grantable: true,
      origin: `${parsed.protocol}//${parsed.hostname}/*`,
    };
  }

  return {
    problem: 'unknown',
    message: `This page could not be read: ${detail}`,
    remedy: 'Try reloading the page, then press Scan again.',
    grantable: false,
  };
}
