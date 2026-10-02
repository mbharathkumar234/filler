/**
 * The fill engine (§ Phase 5): write values into a page the way a human would,
 * in a way frameworks accept.
 *
 * The hard part is not setting `.value` — it is making React, Angular, and
 * jQuery-era postback pages *believe* the value changed. Assigning `.value`
 * directly updates the DOM but leaves React's internal tracker thinking nothing
 * happened, so the next render wipes it. Hence the native-setter dance below.
 *
 * Every write is verified by reading back. A field that silently refused the
 * value is a field the review screen must flag — the alternative is a form that
 * looks filled and submits blank.
 *
 * This module writes values but **never submits**. Submission is exclusively
 * `submit-guard.ts`, gated on an approval token (CLAUDE.md rule 1).
 */

import { normaliseText, similarity } from '@/matching/normalise';

export type FillStrategy =
  | 'text'
  | 'option-value'
  | 'option-exact-text'
  | 'option-normalised-text'
  | 'option-fuzzy'
  | 'radio-label'
  | 'checkbox'
  | 'file'
  | 'drop';

export interface FillOutcome {
  ok: boolean;
  /** How the value was matched — surfaced in the review screen. */
  strategy?: FillStrategy;
  /** True when the value was cut to fit `maxLength`. */
  truncated?: boolean;
  /** True when the match was fuzzy and deserves a human look. */
  fuzzy?: boolean;
  /** What the field actually holds after the write. */
  readBack?: string;
  reason?: string;
}

/** Below this a fuzzy option match is refused rather than guessed. */
const FUZZY_FLOOR = 0.72;

// ---------------------------------------------------------------------------
// The native setter
// ---------------------------------------------------------------------------

type Writable = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/**
 * Set `.value` through the prototype's own setter.
 *
 * React installs an instance-level `value` property to track changes. Writing
 * through it updates the DOM but leaves React's tracker believing the value is
 * unchanged, so the component re-renders over our write. Calling the *prototype*
 * setter bypasses the tracker, and the `input` event we dispatch afterwards is
 * then seen as a genuine user edit.
 */
export function setNativeValue(el: Writable, value: string): void {
  const instanceSetter = Object.getOwnPropertyDescriptor(el, 'value')?.set;
  const prototypeSetter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(el) as object,
    'value',
  )?.set;

  if (prototypeSetter && instanceSetter !== prototypeSetter) {
    prototypeSetter.call(el, value);
  } else if (instanceSetter) {
    instanceSetter.call(el, value);
  } else {
    el.value = value;
  }
}

/**
 * Dispatch the events a portal might be listening for.
 *
 * `input` and `change` cover modern frameworks; `keydown`/`keyup` cover the
 * older pages that validate on keystrokes. `blur` triggers the on-leave
 * validation that ASP.NET forms lean on.
 */
function dispatchEdit(el: Element, options: { keys?: boolean } = {}): void {
  const win = el.ownerDocument.defaultView;
  if (!win) return;

  el.dispatchEvent(new win.Event('input', { bubbles: true }));
  el.dispatchEvent(new win.Event('change', { bubbles: true }));

  if (options.keys) {
    el.dispatchEvent(new win.KeyboardEvent('keydown', { bubbles: true }));
    el.dispatchEvent(new win.KeyboardEvent('keyup', { bubbles: true }));
  }

  el.dispatchEvent(new win.FocusEvent('blur', { bubbles: false }));
}

// ---------------------------------------------------------------------------
// Text-like fields
// ---------------------------------------------------------------------------

export function fillText(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): FillOutcome {
  const max = el.maxLength;
  let write = value;
  let truncated = false;

  // §Phase 5 Should Achieve: truncate with a review flag rather than silently
  // corrupting data. A half-written Aadhaar number is worse than a flagged one.
  if (max !== undefined && max > 0 && value.length > max) {
    write = value.slice(0, max);
    truncated = true;
  }

  el.focus?.();
  setNativeValue(el, write);
  dispatchEdit(el, { keys: true });

  const readBack = el.value;
  return {
    ok: readBack === write,
    strategy: 'text',
    ...(truncated ? { truncated: true } : {}),
    readBack,
    ...(readBack === write
      ? {}
      : { reason: 'the field did not keep the value that was written' }),
  };
}

// ---------------------------------------------------------------------------
// Selects
// ---------------------------------------------------------------------------

interface OptionMatch {
  option: HTMLOptionElement;
  strategy: FillStrategy;
  fuzzy: boolean;
}

/**
 * Find the option that means `value`, cheapest and most certain first.
 *
 * The order is the plan's: option value, exact text, normalised text, fuzzy.
 * Which one won is recorded, because a fuzzy hit ("Karnatak" → "Karnataka") is
 * a guess the user should confirm, and §Phase 7 lists fuzzy select matches as
 * something the review screen must surface explicitly.
 */
export function findOption(el: HTMLSelectElement, value: string): OptionMatch | null {
  const options = [...el.options];
  const wanted = normaliseText(value);

  const byValue = options.find((option) => option.value === value);
  if (byValue) return { option: byValue, strategy: 'option-value', fuzzy: false };

  const byExactText = options.find((option) => option.text.trim() === value.trim());
  if (byExactText) return { option: byExactText, strategy: 'option-exact-text', fuzzy: false };

  const byNormalised = options.find(
    (option) =>
      normaliseText(option.text) === wanted || normaliseText(option.value) === wanted,
  );
  if (byNormalised) {
    return { option: byNormalised, strategy: 'option-normalised-text', fuzzy: false };
  }

  let best: { option: HTMLOptionElement; score: number } | null = null;
  for (const option of options) {
    // A placeholder row ("-- Select --") must never win a fuzzy match.
    if (option.value === '' && option.index === 0) continue;
    const score = Math.max(
      similarity(wanted, normaliseText(option.text)),
      similarity(wanted, normaliseText(option.value)),
    );
    if (score >= FUZZY_FLOOR && (!best || score > best.score)) {
      best = { option, score };
    }
  }

  return best ? { option: best.option, strategy: 'option-fuzzy', fuzzy: true } : null;
}

export function fillSelect(el: HTMLSelectElement, value: string): FillOutcome {
  const match = findOption(el, value);
  if (!match) {
    return {
      ok: false,
      readBack: el.value,
      reason: `no option on this dropdown matches "${value}"`,
    };
  }

  el.focus?.();
  setNativeValue(el, match.option.value);
  dispatchEdit(el);

  const readBack = el.value;
  return {
    ok: readBack === match.option.value,
    strategy: match.strategy,
    ...(match.fuzzy ? { fuzzy: true } : {}),
    readBack,
    ...(readBack === match.option.value
      ? {}
      : { reason: 'the dropdown did not keep the selected option' }),
  };
}

// ---------------------------------------------------------------------------
// Radio groups and checkboxes
// ---------------------------------------------------------------------------

/** Label text for a radio/checkbox member, for value matching. */
function memberLabel(el: HTMLInputElement): string {
  const wrapping = el.closest('label');
  if (wrapping) {
    const clone = wrapping.cloneNode(true) as Element;
    for (const control of [...clone.querySelectorAll('input,select,textarea')]) control.remove();
    return (clone.textContent ?? '').trim();
  }
  const id = el.getAttribute('id');
  if (id) {
    const owner = el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (owner) return (owner.textContent ?? '').trim();
  }
  return '';
}

export function fillRadioGroup(el: HTMLInputElement, value: string): FillOutcome {
  const name = el.getAttribute('name');
  const members = name
    ? [...el.ownerDocument.querySelectorAll<HTMLInputElement>('input[type="radio"]')].filter(
        (member) => member.getAttribute('name') === name,
      )
    : [el];

  const wanted = normaliseText(value);

  const byValue = members.find((member) => member.value === value);
  const byLabel =
    byValue ??
    members.find((member) => normaliseText(memberLabel(member)) === wanted) ??
    members.find((member) => normaliseText(member.value) === wanted);

  if (!byLabel) {
    return { ok: false, reason: `no option in this group matches "${value}"` };
  }

  byLabel.focus?.();
  byLabel.checked = true;
  dispatchEdit(byLabel);

  return {
    ok: byLabel.checked,
    strategy: 'radio-label',
    readBack: byLabel.value,
  };
}

const TRUTHY = /^(yes|true|1|on|checked|y)$/i;

export function fillCheckbox(el: HTMLInputElement, value: string): FillOutcome {
  const shouldCheck = TRUTHY.test(value.trim());
  el.focus?.();
  el.checked = shouldCheck;
  dispatchEdit(el);

  return {
    ok: el.checked === shouldCheck,
    strategy: 'checkbox',
    readBack: String(el.checked),
  };
}

// ---------------------------------------------------------------------------
// File inputs
// ---------------------------------------------------------------------------

/**
 * Attach a derived document to a file input.
 *
 * `input.files` is read-only; a `DataTransfer` list is the only way to populate
 * it, and it is the same mechanism a drag-and-drop would use. The bytes come
 * from the Phase 2 derivation pipeline — the master never leaves the worker.
 */
export function fillFile(
  el: HTMLInputElement,
  bytes: Uint8Array,
  mime: string,
  filename: string,
): FillOutcome {
  const win = el.ownerDocument.defaultView;
  if (!win || typeof win.DataTransfer === 'undefined') {
    return { ok: false, reason: 'this browser will not allow attaching a file programmatically' };
  }

  try {
    el.files = transferOf(win, bytes, mime, filename).files;
    dispatchEdit(el);

    const attached = el.files?.length === 1 && el.files[0]?.name === filename;
    return {
      ok: attached,
      strategy: 'file',
      readBack: el.files?.[0]?.name ?? '',
      ...(attached ? {} : { reason: 'the file input did not accept the attachment' }),
    };
  } catch (error) {
    return {
      ok: false,
      reason: `could not attach the file: ${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }
}

function transferOf(
  win: Window & typeof globalThis,
  bytes: Uint8Array,
  mime: string,
  filename: string,
): DataTransfer {
  const transfer = new win.DataTransfer();
  transfer.items.add(new win.File([bytes as BlobPart], filename, { type: mime }));
  return transfer;
}

/**
 * Drop a document onto a drag-and-drop area that has no file box of its own.
 *
 * The same `DataTransfer` a real drag carries, delivered as the three events a
 * drop widget listens for. Success is read from the widget's own answer: a
 * handler that took the file cancels the `drop`, because otherwise the browser
 * would navigate away to display it. A drop nobody cancelled went nowhere.
 *
 * There is no read-back — the widget keeps the file in its own state — and no
 * undo. Some widgets start uploading the moment a file lands; that is the
 * site's code, just as some sites check a value the moment it is typed.
 */
export function fillDrop(
  el: Element,
  bytes: Uint8Array,
  mime: string,
  filename: string,
): FillOutcome {
  const win = el.ownerDocument.defaultView;
  if (!win || typeof win.DataTransfer === 'undefined' || typeof win.DragEvent === 'undefined') {
    return { ok: false, reason: 'this browser will not allow dropping a file programmatically' };
  }

  try {
    const transfer = transferOf(win, bytes, mime, filename);
    let taken = false;
    for (const type of ['dragenter', 'dragover', 'drop']) {
      const event = new win.DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer });
      const uncancelled = el.dispatchEvent(event);
      if (type === 'drop') taken = !uncancelled;
    }
    return {
      ok: taken,
      strategy: 'drop',
      readBack: taken ? filename : '',
      ...(taken ? {} : { reason: 'nothing on the page took the dropped file' }),
    };
  } catch (error) {
    return {
      ok: false,
      reason: `could not drop the file: ${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface FileValue {
  bytes: Uint8Array;
  mime: string;
  filename: string;
}

/**
 * Write a value into whatever kind of control this is.
 *
 * Retry-once-then-flag lives in the run orchestrator, not here: this function
 * reports what happened and stays free of policy.
 */
export function fillElement(el: Element, value: string | FileValue): FillOutcome {
  const tag = el.tagName.toLowerCase();

  if (typeof value !== 'string') {
    if (tag === 'input' && (el.getAttribute('type') ?? '').toLowerCase() === 'file') {
      return fillFile(el as HTMLInputElement, value.bytes, value.mime, value.filename);
    }
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      return { ok: false, reason: 'a text field needs text, not a document' };
    }
    // Anything else a document was aimed at is a drop area (§ document attachment).
    return fillDrop(el, value.bytes, value.mime, value.filename);
  }

  if (tag === 'select') return fillSelect(el as HTMLSelectElement, value);

  if (tag === 'textarea') {
    return fillText(el as HTMLTextAreaElement, value);
  }

  if (tag === 'input') {
    const input = el as HTMLInputElement;
    const type = (input.getAttribute('type') ?? 'text').toLowerCase();

    if (type === 'file') {
      return { ok: false, reason: 'a file input needs a document, not text' };
    }

    if (type === 'radio') return fillRadioGroup(input, value);
    if (type === 'checkbox') return fillCheckbox(input, value);
    return fillText(input, value);
  }

  return { ok: false, reason: `cannot write into a <${tag}> element` };
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

export interface FieldSnapshot {
  ref: string;
  value: string;
  checked?: boolean;
  /**
   * A file box's previous contents. A `FileList` rather than `.value`: a file
   * box's value can only ever be set to empty, so restoring the user's own
   * pick means handing the list itself back.
   */
  files?: FileList | null;
  /** Not a form control — a drop area. Nothing of ours to put back. */
  inert?: true;
}

const FORM_CONTROLS = new Set(['input', 'select', 'textarea']);

/** Capture what a field held before we touched it (§Phase 5 Should: Undo). */
export function snapshot(ref: string, el: Element): FieldSnapshot {
  if (!FORM_CONTROLS.has(el.tagName.toLowerCase())) return { ref, value: '', inert: true };
  const input = el as HTMLInputElement;
  if (input.type === 'file') return { ref, value: '', files: input.files };
  const snap: FieldSnapshot = { ref, value: input.value ?? '' };
  if (input.type === 'radio' || input.type === 'checkbox') snap.checked = input.checked;
  return snap;
}

/** Put a field back. False when there was nothing we could restore. */
export function restore(el: Element, snap: FieldSnapshot): boolean {
  if (snap.inert) return false;
  const input = el as HTMLInputElement;
  if (snap.files !== undefined) {
    // Setting `.value` to anything but '' throws on a file box, which is how
    // Undo used to break on one that held a file.
    if (snap.files && snap.files.length > 0) input.files = snap.files;
    else input.value = '';
  } else if (snap.checked !== undefined) {
    input.checked = snap.checked;
  } else {
    setNativeValue(input, snap.value);
  }
  dispatchEdit(el);
  return true;
}
