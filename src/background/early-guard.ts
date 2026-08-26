/**
 * The early guard (§ COMPLETION_PLAN Phase B).
 *
 *   "Submit guard installed at `document_start`, capture phase, covering
 *    `click`, `submit`, and `Enter` keydown."
 *
 * ## The hole this closes
 *
 * Phase 5 recorded the pre-injection window as acceptable because "nothing of
 * ours had been filled". That reasoning covers a *first* page load and nothing
 * else. After a fill, an ASP.NET postback preserves the field values, so the
 * page comes back **carrying the extension's own data** — and a portal that
 * submits during `load` sends it before a gesture-injected content script can
 * exist. `tests/e2e/guard-adversarial.spec.ts` demonstrates exactly that, and
 * the URL it lands on carries the filled Aadhaar.
 *
 * That is a P2 violation, not a documented limit.
 *
 * ## The permission problem, and the resolution
 *
 * Two Must-Achieve items in the completion plan pull against each other:
 * Phase B wants `document_start`, and Phase F says **no `<all_urls>`**. A
 * gesture-injected script can never run at `document_start`, and a statically
 * declared one needs host permission for the site.
 *
 * The resolution is per-origin and opt-in. `optional_host_permissions` lets the
 * user grant **one origin at a time**, in context, at the moment they run a
 * fill on that portal. With that grant the guard is registered as a real
 * `document_start` content script for that origin alone, and it is unregistered
 * when the user revokes the permission. Nothing is granted by default; the
 * manifest's standing `host_permissions` stays empty.
 *
 * So the user's choice is explicit and legible: *"protect this portal from the
 * moment it loads"*, on a portal they have already chosen to use.
 */

/** Built by Vite as a separate entry; see vite.config.ts rollupOptions. */
const CONTENT_SCRIPT = 'content.js';

/** Prefix for every dynamically registered guard, so ours are identifiable. */
const ID_PREFIX = 'early-guard:';

export interface EarlyGuardState {
  origin: string;
  /** Has the user granted host permission for this origin? */
  granted: boolean;
  /** Is a `document_start` script actually registered right now? */
  registered: boolean;
}

/**
 * The origin pattern for a page URL.
 *
 * Returns null for anything that is not an http(s) page — `chrome://`, a
 * PDF viewer, a file URL. Those cannot be scripted and must not be offered.
 */
export function originPattern(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return `${parsed.protocol}//${parsed.hostname}/*`;
  } catch {
    return null;
  }
}

function idFor(pattern: string): string {
  return `${ID_PREFIX}${pattern.replace(/[^a-z0-9]/gi, '-')}`;
}

/** Has the user granted us this origin? */
export async function hasPermission(pattern: string): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

/**
 * Ask for the origin.
 *
 * Must be called from a user gesture — Chrome refuses otherwise, which is the
 * behaviour we want: a permission prompt the user did not provoke is a
 * permission prompt they will dismiss.
 */
export async function requestPermission(pattern: string): Promise<boolean> {
  try {
    return await chrome.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}

export async function revokePermission(pattern: string): Promise<void> {
  await unregister(pattern);
  try {
    await chrome.permissions.remove({ origins: [pattern] });
  } catch {
    // Already gone, or refused. Either way there is nothing to do.
  }
}

/**
 * Register the guard to run at `document_start` on this origin.
 *
 * `persistAcrossSessions: false` on purpose. A registration that outlived the
 * browser would be a standing content script the user could not see, and the
 * whole point of this design is that the exposure is one origin, chosen
 * deliberately. Re-registration happens on the next run.
 */
export async function register(pattern: string): Promise<boolean> {
  if (!(await hasPermission(pattern))) return false;

  const id = idFor(pattern);
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    if (existing.length > 0) return true;

    await chrome.scripting.registerContentScripts([
      {
        id,
        matches: [pattern],
        js: [CONTENT_SCRIPT],
        runAt: 'document_start',
        allFrames: false,
        persistAcrossSessions: false,
      },
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function unregister(pattern: string): Promise<void> {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [idFor(pattern)] });
  } catch {
    // Not registered. Nothing to undo.
  }
}

/** Drop every early guard this extension registered. */
export async function unregisterAll(): Promise<void> {
  try {
    const scripts = await chrome.scripting.getRegisteredContentScripts();
    const ids = scripts.map((s) => s.id).filter((id) => id.startsWith(ID_PREFIX));
    if (ids.length > 0) await chrome.scripting.unregisterContentScripts({ ids });
  } catch {
    // Nothing registered.
  }
}

/**
 * Bring the registration in line with the permission, for one page.
 *
 * Called when a run starts. If the user has granted the origin, the guard is
 * registered; if they have not, nothing happens and the run proceeds with the
 * gesture-injected guard as before — degraded, not broken.
 */
export async function syncFor(url: string): Promise<EarlyGuardState> {
  const pattern = originPattern(url);
  if (!pattern) return { origin: '', granted: false, registered: false };

  const granted = await hasPermission(pattern);
  const registered = granted ? await register(pattern) : false;
  if (!granted) await unregister(pattern);

  return { origin: pattern, granted, registered };
}

/** What the panel shows for the current page. */
export async function statusFor(url: string): Promise<EarlyGuardState> {
  const pattern = originPattern(url);
  if (!pattern) return { origin: '', granted: false, registered: false };

  const granted = await hasPermission(pattern);
  return { origin: pattern, granted, registered: await isRegistered(pattern) };
}

async function isRegistered(pattern: string): Promise<boolean> {
  try {
    const found = await chrome.scripting.getRegisteredContentScripts({ ids: [idFor(pattern)] });
    return found.length > 0;
  } catch {
    return false;
  }
}

/**
 * Every origin the user has granted, so the panel can list and revoke them.
 *
 * A permission the user cannot see is a permission they cannot withdraw.
 */
export async function grantedOrigins(): Promise<string[]> {
  try {
    const all = await chrome.permissions.getAll();
    return (all.origins ?? []).slice().sort();
  } catch {
    return [];
  }
}
