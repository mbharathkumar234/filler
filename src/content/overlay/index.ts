/**
 * In-page overlay (§ Phase 5): a status pill the user can always see, plus an
 * Abort button and the toast the submit guard raises when it blocks something.
 *
 * Two constraints shape this file:
 *
 *  - **It must be visible on a hostile page.** Portals set aggressive global
 *    styles. The overlay lives in a closed shadow root with `all: initial` so
 *    the page cannot restyle it into invisibility, and at a very high z-index.
 *  - **It must not look like part of the page.** The user has to be able to
 *    tell our controls from the portal's, or the Abort button becomes just
 *    another button on a government form.
 *
 * It writes only into its own container — never into the page's form fields.
 */

export type OverlayStatus = 'idle' | 'filling' | 'paused' | 'review' | 'blocked' | 'done';

const LABELS: Record<OverlayStatus, string> = {
  idle: 'AutoFill ready',
  filling: 'Filling…',
  paused: 'Paused — your turn',
  review: 'Ready for your review',
  blocked: 'Submission blocked',
  done: 'Filled — nothing submitted',
};

const COLOURS: Record<OverlayStatus, string> = {
  idle: '#334155',
  filling: '#1d4ed8',
  paused: '#b45309',
  review: '#047857',
  blocked: '#b91c1c',
  done: '#047857',
};

const CONTAINER_ID = 'autofill-assistant-overlay';

interface Overlay {
  host: HTMLElement;
  root: ShadowRoot;
  pill: HTMLElement;
  label: HTMLElement;
  progress: HTMLElement;
  toast: HTMLElement;
  abort: HTMLButtonElement;
}

let overlay: Overlay | null = null;
let onAbort: (() => void) | null = null;

const STYLE = `
  :host { all: initial; }
  .wrap {
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
    font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
    display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
    pointer-events: none;
  }
  .pill {
    pointer-events: auto;
    display: flex; align-items: center; gap: 10px;
    background: #ffffff; color: #0f172a;
    border: 1px solid #cbd5e1; border-left: 4px solid var(--accent, #334155);
    border-radius: 8px; padding: 8px 12px;
    box-shadow: 0 4px 16px rgba(15, 23, 42, .18);
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent, #334155); flex: none; }
  .text { display: flex; flex-direction: column; }
  .label { font-weight: 600; }
  .progress { color: #64748b; font-size: 11px; }
  button {
    font: inherit; cursor: pointer;
    background: #f1f5f9; color: #0f172a;
    border: 1px solid #cbd5e1; border-radius: 6px; padding: 4px 10px;
  }
  button:hover { background: #e2e8f0; }
  .toast {
    pointer-events: auto;
    max-width: 340px; background: #7f1d1d; color: #fff;
    border-radius: 8px; padding: 10px 12px;
    box-shadow: 0 4px 16px rgba(15, 23, 42, .3);
  }
  [hidden] { display: none !important; }
`;

export function mountOverlay(doc: Document = document): void {
  if (overlay?.host.isConnected) return;

  const host = doc.createElement('div');
  host.id = CONTAINER_ID;
  // Closed: the page must not be able to reach in and rewrite our controls.
  const root = host.attachShadow({ mode: 'closed' });

  const style = doc.createElement('style');
  style.textContent = STYLE;

  const wrap = doc.createElement('div');
  wrap.className = 'wrap';

  const toast = doc.createElement('div');
  toast.className = 'toast';
  toast.hidden = true;
  toast.setAttribute('role', 'alert');

  const pill = doc.createElement('div');
  pill.className = 'pill';

  const dot = doc.createElement('span');
  dot.className = 'dot';

  const text = doc.createElement('div');
  text.className = 'text';

  const label = doc.createElement('span');
  label.className = 'label';
  label.textContent = LABELS.idle;

  const progress = doc.createElement('span');
  progress.className = 'progress';
  progress.textContent = 'Nothing will be submitted without your approval.';

  const abort = doc.createElement('button');
  abort.type = 'button';
  abort.textContent = 'Abort';
  abort.addEventListener('click', () => onAbort?.());

  text.append(label, progress);
  pill.append(dot, text, abort);
  wrap.append(toast, pill);
  root.append(style, wrap);
  doc.body.append(host);

  overlay = { host, root, pill, label, progress, toast, abort };
  setStatus('idle');
}

export function setAbortHandler(fn: () => void): void {
  onAbort = fn;
}

export function setStatus(status: OverlayStatus, detail?: string): void {
  if (!overlay) return;
  overlay.pill.style.setProperty('--accent', COLOURS[status]);
  overlay.label.textContent = LABELS[status];
  overlay.progress.textContent =
    detail ?? 'Nothing will be submitted without your approval.';
  overlay.abort.hidden = status === 'done' || status === 'idle';
}

export function setProgress(done: number, total: number): void {
  if (!overlay) return;
  overlay.progress.textContent = `${done} of ${total} fields`;
}

/** The submit guard's toast. Auto-hides so it does not obscure the page. */
export function showToast(message: string, ms = 6000): void {
  if (!overlay) return;
  overlay.toast.textContent = message;
  overlay.toast.hidden = false;
  setTimeout(() => {
    if (overlay) overlay.toast.hidden = true;
  }, ms);
}

export function unmountOverlay(): void {
  overlay?.host.remove();
  overlay = null;
  onAbort = null;
}

/** Test seam: read what the user would see. */
export function __overlayText(): { label: string; progress: string; toast: string } | null {
  if (!overlay) return null;
  return {
    label: overlay.label.textContent ?? '',
    progress: overlay.progress.textContent ?? '',
    toast: overlay.toast.hidden ? '' : (overlay.toast.textContent ?? ''),
  };
}
