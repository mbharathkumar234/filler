/**
 * The teach-mode element picker (§ Phase 9).
 *
 * The user points at a field the extension got wrong or could not see, and we
 * record what it is. Everything here exists to make that one gesture reliable
 * on a page that was not designed to be pointed at.
 *
 * ## Why the listeners look paranoid
 *
 * A portal is full of things that want the click first: labels that focus an
 * input, `<a>` wrappers, buttons that navigate, forms that submit on Enter. So
 * the picker listens in the **capture** phase and stops the event dead —
 * `preventDefault`, `stopPropagation`, `stopImmediatePropagation`. A picker
 * that let the click through would navigate away mid-teach, and on a form the
 * user has already filled that is worse than not having a picker at all.
 *
 * For the same reason `pointerdown` is swallowed too: some frameworks act on
 * pointerdown and never wait for the click.
 *
 * ## What it never does
 *
 * It does not read values, and it does not offer security controls. A CAPTCHA
 * box or a one-time-code field cannot be taught, because there is no key to
 * teach it *to* — the taxonomy has none, by design (P4). Pointing at one is
 * refused with a reason rather than silently ignored.
 */

import type { FieldDescriptor } from '@/shared/types';
import { detectBlockers } from './blockers';
import { buildSelectors } from './selectors';
import { resolveLabel } from './labels';

const HOST_ID = 'autofill-assistant-picker';

export interface PickedElement {
  /** Ranked selectors, as `buildSelectors` produced them. */
  selectors: string[];
  /** What the user would call this field. */
  label: string;
  tag: string;
  type: string | null;
  /** The harvested ref, when this element is one we already knew about. */
  ref: string | null;
  /** Set when the element cannot be taught, with a reason for the user. */
  refused?: string;
}

export interface PickerHandle {
  stop(): void;
  /** Test seam: pick this element as though the user had clicked it. */
  pick(el: Element): void;
}

export interface PickerOptions {
  onPick(picked: PickedElement): void;
  onCancel?(): void;
  /** The current harvest, so a pick can be tied back to a known field. */
  known?: readonly FieldDescriptor[];
  /** Resolve a descriptor ref to its element, for the `known` lookup. */
  resolve?(ref: string): Element | null;
}

/**
 * Start picking. Returns a handle; call `stop()` when done.
 *
 * Escape cancels, because a mode with no way out is a trap — and on a page
 * where every click is being swallowed, the user needs a key that still works.
 */
export function startPicker(doc: Document, options: PickerOptions): PickerHandle {
  const { host, outline, hint } = mountChrome(doc);
  let stopped = false;

  const targetOf = (event: Event): Element | null => {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    // Never point at our own furniture.
    if (target.closest(`#${HOST_ID}`) !== null) return null;
    return target.closest('input, select, textarea') ?? target;
  };

  const onMove = (event: PointerEvent) => {
    const el = targetOf(event);
    if (!el) return;
    positionOutline(outline, el);
    hint.textContent = describe(el);
  };

  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  const onClick = (event: MouseEvent) => {
    const el = targetOf(event);
    if (!el) return;
    swallow(event);
    handle.pick(el);
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    swallow(event);
    handle.stop();
    options.onCancel?.();
  };

  const listeners: Array<[string, EventListener]> = [
    ['pointermove', onMove as EventListener],
    ['pointerdown', swallow],
    ['mousedown', swallow],
    ['click', onClick as EventListener],
    ['keydown', onKey as EventListener],
  ];

  for (const [type, listener] of listeners) {
    doc.addEventListener(type, listener, true);
  }

  const handle: PickerHandle = {
    stop() {
      if (stopped) return;
      stopped = true;
      for (const [type, listener] of listeners) {
        doc.removeEventListener(type, listener, true);
      }
      host.remove();
    },
    pick(el: Element) {
      if (stopped) return;
      options.onPick(describeElement(el, doc, options));
    },
  };

  return handle;
}

/**
 * Turn a clicked element into something teachable.
 *
 * Refusals carry a sentence rather than being dropped: a user who clicks a
 * CAPTCHA box and gets no response will click it again.
 */
export function describeElement(
  el: Element,
  doc: Document,
  options: Pick<PickerOptions, 'known' | 'resolve'> = {},
): PickedElement {
  const tag = el.tagName.toLowerCase();
  const type = el.getAttribute('type');
  const label = resolveLabel(el).text.trim();
  const selectors = buildSelectors(el, label, doc);

  const base: PickedElement = {
    selectors,
    label: label || describe(el),
    tag,
    type,
    ref: refFor(el, options),
  };

  if (!['input', 'select', 'textarea'].includes(tag)) {
    return { ...base, refused: 'That is not a form field. Point at a box, a dropdown, or a file input.' };
  }
  if (type === 'password') {
    return { ...base, refused: 'Passwords are never filled by this extension. Type it yourself.' };
  }
  if (type === 'hidden') {
    return { ...base, refused: 'That field is hidden, so there is nothing for you to check.' };
  }

  // P4: a security control has no key in the taxonomy to teach it to.
  const blocked = detectBlockers(doc).some(
    (finding) => finding.type === 'captcha' || finding.type === 'otp',
  );
  if (blocked && isSecurityField(el)) {
    return {
      ...base,
      refused: 'That is a security field. You complete those yourself — AutoFill never will.',
    };
  }

  if (selectors.length === 0) {
    return { ...base, refused: 'This field has nothing stable to identify it by.' };
  }

  return base;
}

function isSecurityField(el: Element): boolean {
  const identity = `${el.getAttribute('name') ?? ''} ${el.getAttribute('id') ?? ''} ${
    el.getAttribute('placeholder') ?? ''
  }`;
  return /captcha|otp|one.?time|verification.?code|security.?code/i.test(identity);
}

function refFor(el: Element, options: Pick<PickerOptions, 'known' | 'resolve'>): string | null {
  const { known, resolve } = options;
  if (!known || !resolve) return null;
  for (const field of known) {
    if (resolve(field.ref) === el) return field.ref;
  }
  return null;
}

function describe(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const name = el.getAttribute('name') ?? el.getAttribute('id') ?? '';
  return name ? `${tag} “${name}”` : tag;
}

// ---------------------------------------------------------------------------
// The overlay
// ---------------------------------------------------------------------------

interface Chrome {
  host: HTMLElement;
  outline: HTMLElement;
  hint: HTMLElement;
}

/**
 * The picker's own furniture, in a closed shadow root.
 *
 * Same reasoning as the Phase 5 status overlay: a portal's stylesheet must not
 * be able to restyle our controls away, and the user has to be able to tell
 * our outline from the page's own focus ring.
 */
function mountChrome(doc: Document): Chrome {
  doc.getElementById(HOST_ID)?.remove();

  const host = doc.createElement('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'closed' });

  const style = doc.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .outline {
      position: fixed; box-sizing: border-box; pointer-events: none;
      border: 2px solid #7c3aed; border-radius: 4px;
      box-shadow: 0 0 0 4px rgba(124, 58, 237, .2);
      z-index: 2147483646; transition: none;
    }
    .bar {
      position: fixed; left: 50%; top: 12px; transform: translateX(-50%);
      z-index: 2147483647; pointer-events: none;
      background: #7c3aed; color: #fff; border-radius: 999px;
      padding: 8px 16px; max-width: 90vw;
      font: 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif;
      box-shadow: 0 4px 16px rgba(15, 23, 42, .3);
      display: flex; gap: 10px; align-items: baseline;
    }
    .hint { opacity: .85; font-size: 12px; }
  `;

  const outline = doc.createElement('div');
  outline.className = 'outline';
  outline.style.width = '0';
  outline.style.height = '0';

  const bar = doc.createElement('div');
  bar.className = 'bar';
  bar.setAttribute('role', 'status');

  const title = doc.createElement('strong');
  title.textContent = 'Click the field you want to teach';

  const hint = doc.createElement('span');
  hint.className = 'hint';
  hint.textContent = 'Esc to cancel';

  bar.append(title, hint);
  root.append(style, outline, bar);
  doc.body.append(host);

  return { host, outline, hint };
}

function positionOutline(outline: HTMLElement, el: Element): void {
  const rect = el.getBoundingClientRect();
  outline.style.top = `${rect.top - 2}px`;
  outline.style.left = `${rect.left - 2}px`;
  outline.style.width = `${rect.width + 4}px`;
  outline.style.height = `${rect.height + 4}px`;
}
