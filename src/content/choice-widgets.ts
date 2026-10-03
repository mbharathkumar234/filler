/**
 * Choice questions that are not form controls (§ choice questions).
 *
 * A Google Form has no <select> and no radio button. Its dropdown is a div
 * with role="listbox" holding divs with role="option"; its multiple-choice
 * question is a div with role="radiogroup" holding divs with role="radio", and
 * its "Other:" is one of those, with a text box beside it. There is no `.value`
 * to set. The page changes when a person presses an option, and only then — so
 * that is what the filler does, and the only thing it does here.
 *
 * `pressChoice` is the one function in this file that dispatches a pointer
 * event. It presses an element whose role is radio, option or listbox, and
 * refuses everything else: a button of any kind, a link, anything inside one,
 * anything `submit-guard.ts` would call a submit, and a label that would pass
 * the press on to one. Sending, saving and navigating stay out of reach
 * (CLAUDE.md rule 1, P2) — and the submit guard's own capture-phase listener
 * still stands behind this, as it does behind the page's own clicks.
 *
 * Which option a value means is decided by `matching/choose-option.ts`, the
 * same rule the native <select> and radio buttons use.
 */

import { chooseOption, isOtherOption, isPlaceholderOption, type ChoiceOption } from '@/matching/choose-option';
import { fillText, strategyOf, type FillOutcome } from './filler';
import { isVisible } from './harvester';
import { isSubmitish } from './submit-guard';

export type ChoiceWidget = 'radiogroup' | 'listbox';

export const CHOICE_WIDGET_SELECTOR = '[role="radiogroup"], [role="listbox"]';

/** Google marks its "Other:" choice with this value. */
const OTHER_VALUE = '__other_option__';

/**
 * Is this element a choice question the filler can answer by pressing?
 *
 * Not a native control (those are filled as themselves), not a group of real
 * radio buttons wearing a role, and not a list of several answers at once.
 */
export function choiceWidgetOf(el: Element): ChoiceWidget | null {
  const tag = el.tagName.toLowerCase();
  if (tag === 'select' || tag === 'input' || tag === 'textarea') return null;
  const role = el.getAttribute('role');
  if (role === 'radiogroup') {
    if (el.querySelector('input[type="radio"]')) return null;
    return el.querySelector('[role="radio"]') ? 'radiogroup' : null;
  }
  if (role === 'listbox') {
    if (el.getAttribute('aria-multiselectable') === 'true') return null;
    return el.querySelector('[role="option"]') ? 'listbox' : null;
  }
  return null;
}

/**
 * A list of suggestions under a box being typed in — an autocomplete's popup —
 * is not a question. Its options are the page's guesses at what is being typed.
 */
export function isSuggestionList(el: Element): boolean {
  const id = el.getAttribute('id');
  if (!id) return false;
  const doc = el.ownerDocument;
  for (const owner of doc.querySelectorAll('[aria-controls], [aria-owns]')) {
    const refs = `${owner.getAttribute('aria-controls') ?? ''} ${owner.getAttribute('aria-owns') ?? ''}`;
    if (!refs.split(/\s+/).includes(id)) continue;
    const role = owner.getAttribute('role');
    if (role === 'combobox' || role === 'searchbox' || owner.tagName.toLowerCase() === 'input') return true;
  }
  return false;
}

// ── Reading ────────────────────────────────────────────────────────────────

export interface WidgetOption {
  el: Element;
  option: ChoiceOption;
}

const memberRole = (kind: ChoiceWidget) => (kind === 'radiogroup' ? 'radio' : 'option');

function optionText(el: Element): string {
  const aria = (el.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim();
  if (aria) return aria;
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text || (el.getAttribute('data-value') ?? '');
}

function describeOption(el: Element): ChoiceOption {
  const text = optionText(el);
  const value = el.getAttribute('data-value');
  const option: ChoiceOption = { text, ...(value === null ? {} : { value }) };
  return value === OTHER_VALUE || isOtherOption(option) ? { ...option, other: true } : option;
}

/** The value that names an option across the copies a dropdown keeps of it. */
const optionKey = (el: Element) => el.getAttribute('data-value') ?? optionText(el);

/**
 * Each option once, in the page's order. A dropdown's open list repeats every
 * option of its closed one; the first copy stands for both.
 */
export function widgetOptions(group: Element): WidgetOption[] {
  const kind = choiceWidgetOf(group);
  if (!kind) return [];
  const seen = new Set<string>();
  const out: WidgetOption[] = [];
  for (const el of group.querySelectorAll(`[role="${memberRole(kind)}"]`)) {
    const key = optionKey(el);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ el, option: describeOption(el) });
  }
  return out;
}

const isChosen = (el: Element) =>
  el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true';

const TEXT_BOX = 'input:not([type]), input[type="text"], textarea';

/**
 * The box an "Other" choice writes its answer in.
 *
 * The nearest one to the option: the row it sits in, then the group. Past the
 * group, only a box that says it is for "Other" — the next question's answer
 * box is not this one's.
 */
export function otherBoxFor(group: Element, optionEl: Element): HTMLInputElement | HTMLTextAreaElement | null {
  const stop = group.parentElement;
  for (let node = optionEl.parentElement; node && node !== stop; node = node.parentElement) {
    const boxes = [...node.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(TEXT_BOX)];
    if (boxes.length === 1) return boxes[0]!;
    if (boxes.length > 1) return boxes.find((box) => /other/i.test(box.getAttribute('aria-label') ?? '')) ?? null;
  }
  const question = group.closest('[role="listitem"], fieldset, li');
  return (
    [...(question?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(TEXT_BOX) ?? [])].find((box) =>
      /other/i.test(box.getAttribute('aria-label') ?? ''),
    ) ?? null
  );
}

/** What the question holds now: the chosen option's words, "Other"'s answer, or ''. */
export function readChoice(group: Element): string {
  const kind = choiceWidgetOf(group);
  if (!kind) return '';
  const chosen = [...group.querySelectorAll(`[role="${memberRole(kind)}"]`)].find(isChosen);
  if (!chosen) return '';
  const option = describeOption(chosen);
  if (isPlaceholderOption(option)) return '';
  if (option.other) {
    const answer = otherBoxFor(group, chosen)?.value.trim();
    if (answer) return answer;
  }
  return option.text;
}

// ── Pressing ───────────────────────────────────────────────────────────────

const PRESSABLE_ROLES = new Set(['radio', 'option', 'listbox']);

/** Anything a press could pass on to that sends, saves or goes somewhere. */
const ACTIVATES = 'a[href], button, summary, [role="button"], [role="link"], [role="menuitem"], input, select, textarea';

/**
 * May this element be pressed? Only a choice, and only one whose press cannot
 * reach anything else: a click bubbles, and a link or button it bubbles
 * through does what a link or button does.
 */
export function mayPress(el: Element): boolean {
  if (!PRESSABLE_ROLES.has(el.getAttribute('role') ?? '')) return false;
  if (el.closest(ACTIVATES)) return false;
  if (isSubmitish(el)) return false;
  const label = el.closest('label');
  const control = (label as HTMLLabelElement | null)?.control;
  if (control && !(control instanceof HTMLInputElement && (control.type === 'radio' || control.type === 'checkbox'))) {
    return false;
  }
  return true;
}

/**
 * Press a choice the way a person does: pointer down, mouse down, focus,
 * pointer up, mouse up, click. Pages listen for different parts of it; a
 * radio or an option pressed twice is still the one choice.
 */
export function pressChoice(el: Element): boolean {
  if (!mayPress(el)) return false;
  const win = el.ownerDocument.defaultView;
  if (!win) return false;
  const rect = el.getBoundingClientRect();
  const at = {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
  const pointer = typeof win.PointerEvent === 'function';
  if (pointer) el.dispatchEvent(new win.PointerEvent('pointerdown', { ...at, buttons: 1, pointerType: 'mouse', isPrimary: true }));
  el.dispatchEvent(new win.MouseEvent('mousedown', { ...at, buttons: 1 }));
  (el as HTMLElement).focus?.();
  if (pointer) el.dispatchEvent(new win.PointerEvent('pointerup', { ...at, buttons: 0, pointerType: 'mouse', isPrimary: true }));
  el.dispatchEvent(new win.MouseEvent('mouseup', { ...at, buttons: 0 }));
  el.dispatchEvent(new win.MouseEvent('click', { ...at, buttons: 0, detail: 1 }));
  return true;
}

/**
 * The keyboard's way to the same choice, for a page that ignores the mouse.
 * Space and Escape only — Enter in a form is a submission, and is never sent.
 */
function pressKey(el: Element, key: ' ' | 'Escape'): boolean {
  if (!mayPress(el)) return false;
  const win = el.ownerDocument.defaultView;
  if (!win) return false;
  const init = { key, code: key === ' ' ? 'Space' : 'Escape', bubbles: true, cancelable: true, composed: true };
  (el as HTMLElement).focus?.();
  el.dispatchEvent(new win.KeyboardEvent('keydown', init));
  el.dispatchEvent(new win.KeyboardEvent('keyup', init));
  return true;
}

// ── Filling ────────────────────────────────────────────────────────────────

export type Wait = (ms: number) => Promise<void>;

export const sleep: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long a page gets to show what a press did. */
export const SETTLE_MS = 1500;
const POLL_MS = 50;

/** Ask until the page answers, or `ms` has passed. */
export async function until<T>(
  probe: () => T | null | undefined | false,
  wait: Wait,
  ms = SETTLE_MS,
): Promise<T | null> {
  for (let spent = 0; ; spent += POLL_MS) {
    const found = probe();
    if (found) return found;
    if (spent >= ms) return null;
    await wait(POLL_MS);
  }
}

type Pressed = { ok: true } | { ok: false; reason: string };

async function chooseRadio(target: Element, wait: Wait): Promise<Pressed> {
  if (isChosen(target)) return { ok: true };
  if (!pressChoice(target)) return { ok: false, reason: 'this option is not one the filler may press' };
  if (await until(() => isChosen(target), wait)) return { ok: true };
  pressKey(target, ' ');
  if (await until(() => isChosen(target), wait)) return { ok: true };
  return { ok: false, reason: 'the question did not take the choice' };
}

/**
 * Every copy of one option a dropdown shows: its own list, the list it opens
 * (inside it, or wherever `aria-controls` and `aria-owns` point), and any open
 * list the page added that belongs to no other dropdown.
 */
function copiesOf(listbox: Element, key: string): Element[] {
  const doc = listbox.ownerDocument;
  const scopes: ParentNode[] = [listbox];
  for (const attr of ['aria-controls', 'aria-owns']) {
    for (const id of (listbox.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean)) {
      const popup = doc.getElementById(id);
      if (popup) scopes.push(popup);
    }
  }
  const found = new Set<Element>();
  for (const scope of scopes) {
    for (const el of scope.querySelectorAll('[role="option"]')) if (optionKey(el) === key) found.add(el);
  }
  for (const el of doc.querySelectorAll('[role="option"]')) {
    const owner = el.closest('[role="listbox"], select');
    if ((owner === null || owner === listbox) && optionKey(el) === key && isVisible(el)) found.add(el);
  }
  return [...found];
}

async function chooseFromList(listbox: Element, target: Element, wait: Wait): Promise<Pressed> {
  const key = optionKey(target);
  const taken = () => copiesOf(listbox, key).some(isChosen);
  if (taken()) return { ok: true };

  if (!pressChoice(listbox)) return { ok: false, reason: 'this dropdown is not one the filler may press' };
  let shown = await until(() => copiesOf(listbox, key).find(isVisible), wait);
  if (!shown) {
    pressKey(listbox, ' ');
    shown = await until(() => copiesOf(listbox, key).find(isVisible), wait);
  }
  if (!shown) {
    pressKey(listbox, 'Escape');
    return { ok: false, reason: 'the dropdown did not open' };
  }
  if (!pressChoice(shown)) {
    pressKey(listbox, 'Escape');
    return { ok: false, reason: 'this option is not one the filler may press' };
  }
  if (await until(taken, wait)) return { ok: true };
  pressKey(listbox, 'Escape');
  return { ok: false, reason: 'the dropdown did not take the choice' };
}

/** Answer a Google Forms-style question with the option `value` means. */
export async function fillChoiceWidget(group: Element, value: string, wait: Wait = sleep): Promise<FillOutcome> {
  const kind = choiceWidgetOf(group);
  if (!kind) return { ok: false, reason: 'this is not a choice question' };
  const entries = widgetOptions(group);
  const choice = chooseOption(value, entries.map(({ option }) => option));
  if (choice.kind === 'none') return { ok: false, readBack: readChoice(group), reason: choice.reason };

  const target = entries[choice.index]!.el;
  const pressed = kind === 'radiogroup' ? await chooseRadio(target, wait) : await chooseFromList(group, target, wait);
  if (!pressed.ok) return { ok: false, readBack: readChoice(group), reason: pressed.reason };

  if (choice.kind === 'other') {
    const box = otherBoxFor(group, target);
    if (!box) {
      return {
        ok: true,
        strategy: 'option-other',
        fuzzy: true,
        readBack: readChoice(group),
        reason: 'chose "Other", but there is no box beside it for the answer',
      };
    }
    const typed = fillText(box, choice.text);
    // Typing in Google's box chooses "Other" for you; make sure it stayed chosen.
    const kept = typed.ok && (isChosen(target) || Boolean(await until(() => isChosen(target), wait)));
    return {
      ok: kept,
      strategy: 'option-other',
      readBack: readChoice(group),
      ...(kept ? {} : { reason: 'the answer was typed, but "Other" did not stay chosen' }),
    };
  }

  const how = strategyOf(choice);
  return {
    ok: true,
    strategy: how.strategy,
    ...(how.fuzzy ? { fuzzy: true } : {}),
    readBack: readChoice(group),
  };
}
