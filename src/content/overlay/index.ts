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

export type OverlayStatus =
  | 'idle'
  | 'filling'
  | 'paused'
  | 'waiting'
  | 'checking'
  | 'review'
  | 'blocked'
  | 'done';

const LABELS: Record<OverlayStatus, string> = {
  idle: 'AutoFill ready',
  filling: 'Filling…',
  paused: 'Paused — your turn',
  /** § Phase 6: a CAPTCHA, OTP, signature or payment. The user acts, not us. */
  waiting: 'Over to you',
  /** § Phase 6: re-checking the page after a postback or a pause. */
  checking: 'Checking the page again…',
  review: 'Ready for your review',
  blocked: 'Submission blocked',
  done: 'Filled — nothing submitted',
};

const COLOURS: Record<OverlayStatus, string> = {
  idle: '#334155',
  filling: '#1d4ed8',
  paused: '#b45309',
  waiting: '#b45309',
  checking: '#1d4ed8',
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
  /** § Phase 6: the pause panel shown while a human-only step is pending. */
  pause: HTMLElement;
  pauseText: HTMLElement;
  pauseContinue: HTMLButtonElement;
}

let overlay: Overlay | null = null;
let onAbort: (() => void) | null = null;
let onContinue: (() => void) | null = null;

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
  .pause {
    pointer-events: auto;
    max-width: 340px; background: #fffbeb; color: #0f172a;
    border: 1px solid #f59e0b; border-left: 4px solid #b45309;
    border-radius: 8px; padding: 12px;
    box-shadow: 0 4px 16px rgba(15, 23, 42, .2);
    display: flex; flex-direction: column; gap: 10px;
  }
  .pause-text { font-size: 12px; }
  .pause button { background: #b45309; color: #fff; border-color: #92400e; }
  .pause button:hover { background: #92400e; }
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

  const pause = doc.createElement('div');
  pause.className = 'pause';
  pause.hidden = true;
  // Announced, because a run that silently stops is indistinguishable from a
  // run that crashed — and this one is waiting on the user specifically.
  pause.setAttribute('role', 'status');

  const pauseText = doc.createElement('div');
  pauseText.className = 'pause-text';

  const pauseContinue = doc.createElement('button');
  pauseContinue.type = 'button';
  pauseContinue.textContent = 'I have completed this — continue';
  pauseContinue.addEventListener('click', () => onContinue?.());

  pause.append(pauseText, pauseContinue);

  text.append(label, progress);
  pill.append(dot, text, abort);
  wrap.append(toast, pause, pill);
  root.append(style, wrap);
  doc.body.append(host);

  overlay = { host, root, pill, label, progress, toast, abort, pause, pauseText, pauseContinue };
  setStatus('idle');
}

export function setAbortHandler(fn: () => void): void {
  onAbort = fn;
}

export function setContinueHandler(fn: () => void): void {
  onContinue = fn;
}

/**
 * Hand the page back to the user (§ Phase 6).
 *
 * The instruction always comes from `blockers.ts`'s frozen table — never from
 * the page. A portal that could write the text in our own overlay could tell
 * the user "AutoFill will now complete this for you", and the one thing this
 * panel exists to say is the opposite.
 */
export function showPause(instruction: string): void {
  if (!overlay) return;
  overlay.pauseText.textContent = instruction;
  overlay.pause.hidden = false;
  setStatus('waiting', 'Waiting for you. Nothing is being filled.');
}

export function hidePause(): void {
  if (!overlay) return;
  overlay.pause.hidden = true;
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
  onContinue = null;
}

/** Test seam: read what the user would see. */
export function __overlayText(): {
  label: string;
  progress: string;
  toast: string;
  pause: string;
} | null {
  if (!overlay) return null;
  return {
    label: overlay.label.textContent ?? '',
    progress: overlay.progress.textContent ?? '',
    toast: overlay.toast.hidden ? '' : (overlay.toast.textContent ?? ''),
    pause: overlay.pause.hidden ? '' : (overlay.pauseText.textContent ?? ''),
  };
}

/** Test seam: press the pause panel's button, as the user would. */
export function __pressContinue(): void {
  overlay?.pauseContinue.click();
}
