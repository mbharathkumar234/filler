/**
 * Re-verification (§ Phase 6).
 *
 *   "`REVERIFYING` re-resolves every field ref; if any value was reset →
 *    refill it; if a selector fails → `DRIFTED`."
 *
 * This runs after anything that could have moved the ground: a postback, a
 * navigation, a CAPTCHA the user just solved, a wizard step. The assumption it
 * exists to kill is "we filled it, so it is filled". On an ASP.NET page that is
 * frequently false — the round trip regenerates every element id and hands back
 * a form with empty boxes, and a run that did not check would take the user to
 * a review screen listing values that are not on the page.
 *
 * Read-only, like the harvester. It resolves, reads, and reports; the decision
 * about what to do next belongs to the reducer, and the writing belongs to the
 * fill engine.
 */

import type { FieldRef } from '@/shared/types';
import { choiceWidgetOf, readChoice } from './choice-widgets';
import { isXPath } from './selectors';

export interface PlannedRef {
  ref: FieldRef;
  /** Ranked selectors, exactly as the harvester produced them. */
  selectors: string[];
  required?: boolean;
  /**
   * What we last wrote, when we still know. Absent after a navigation — the
   * content script's memory dies with the document, and the value is
   * deliberately not persisted.
   */
  expected?: string;
}

export interface FieldVerdict {
  ref: FieldRef;
  /** Did any of its selectors still find an element? */
  resolved: boolean;
  /** Which selector won — for the review screen and for drift diagnosis. */
  via?: string;
  /** Is the field empty right now? */
  empty: boolean;
  /**
   * True when the live value is what we wrote, false when it changed, null
   * when we have no expectation to compare against.
   */
  matches: boolean | null;
}

export interface ReverifyResult {
  verdicts: FieldVerdict[];
  /** Selectors that no longer resolve → the machine escalates to DRIFTED. */
  lost: FieldRef[];
  /** Resolved, but empty or altered → refill these. */
  needsRefill: FieldRef[];
  /** Required fields still empty, for the review screen. */
  requiredButEmpty: FieldRef[];
  /** Fields that survived on a selector other than their first choice. */
  movedSelector: FieldRef[];
}

/**
 * Walk every planned field against the live DOM.
 *
 * Deliberately tolerant about *which* selector wins. A postback that renames
 * `ctl00_x_txtName` to `ctl00_y_txtName` breaks the id but not the label-
 * anchored XPath, and treating that as drift would send the user to a teaching
 * screen for a form that is working perfectly.
 */
export function reverify(
  fields: readonly PlannedRef[],
  root: Document = document,
): ReverifyResult {
  const verdicts: FieldVerdict[] = [];
  const lost: FieldRef[] = [];
  const needsRefill: FieldRef[] = [];
  const requiredButEmpty: FieldRef[] = [];
  const movedSelector: FieldRef[] = [];

  for (const field of fields) {
    const found = resolveRanked(field.selectors, root);

    if (!found) {
      verdicts.push({ ref: field.ref, resolved: false, empty: true, matches: null });
      lost.push(field.ref);
      continue;
    }

    const current = readValue(found.el);
    const empty = current === '';
    const matches = field.expected === undefined ? null : sameValue(current, field.expected);

    verdicts.push({
      ref: field.ref,
      resolved: true,
      via: found.selector,
      empty,
      matches,
    });

    if (found.index > 0) movedSelector.push(field.ref);

    // Refill when the page took the value away, or replaced it with something
    // that is not what we wrote. Both are what a postback does.
    if (matches === false || (matches === null && empty)) needsRefill.push(field.ref);
    if (field.required === true && empty) requiredButEmpty.push(field.ref);
  }

  return { verdicts, lost, needsRefill, requiredButEmpty, movedSelector };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface Resolved {
  el: Element;
  selector: string;
  /** Position in the ranked list. 0 means the first choice still works. */
  index: number;
}

/**
 * Try each selector in the harvester's ranked order and report which won.
 *
 * Reporting the index matters: a run that keeps falling back to the structural
 * path is a run whose site profile is going stale, which is Phase 9's problem
 * and worth the two extra lines to notice here.
 */
export function resolveRanked(
  selectors: readonly string[],
  root: Document = document,
): Resolved | null {
  for (const [index, selector] of selectors.entries()) {
    const el = resolveOne(selector, root);
    if (el) return { el, selector, index };
  }
  return null;
}

function resolveOne(selector: string, root: Document): Element | null {
  try {
    if (isXPath(selector)) {
      return root.evaluate(selector, root, null, 9, null).singleNodeValue as Element | null;
    }
    return root.querySelector(selector);
  } catch {
    // A selector generated for a page that has since changed can be invalid
    // rather than merely unmatched. That is a miss, not a crash.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reading values back
// ---------------------------------------------------------------------------

/**
 * The current value of a field, as a string.
 *
 * Reading `.value` here is reading back *our own* fill on an ordinary form
 * field. It is not the CAPTCHA/OTP exemption — `blockers.ts` is the module
 * forbidden from reading anything, and those fields never reach a plan.
 */
export function readValue(el: Element): string {
  const tag = el.tagName.toLowerCase();

  if (tag === 'select') {
    const select = el as HTMLSelectElement;
    return select.selectedIndex >= 0 ? (select.value ?? '') : '';
  }

  if (tag === 'input') {
    const input = el as HTMLInputElement;
    const type = (input.getAttribute('type') ?? 'text').toLowerCase();

    if (type === 'checkbox') return input.checked ? 'true' : '';
    if (type === 'radio') {
      // The group's value, not this member's: a radio group is one field.
      const name = input.getAttribute('name');
      if (!name) return input.checked ? input.value : '';
      const chosen = input.ownerDocument.querySelector<HTMLInputElement>(
        `input[type="radio"][name="${cssEscape(name)}"]:checked`,
      );
      return chosen?.value ?? '';
    }
    if (type === 'file') {
      // A file input's contents are not readable, and its name is not ours to
      // record. Its emptiness is all we need, and all we take.
      return (input.files?.length ?? 0) > 0 ? 'file' : '';
    }
    return input.value ?? '';
  }

  if (tag === 'textarea') return (el as HTMLTextAreaElement).value ?? '';

  // A Google Forms-style question holds the option chosen in it, not its text.
  if (choiceWidgetOf(el)) return readChoice(el);

  return (el.getAttribute('value') ?? el.textContent ?? '').trim();
}

/**
 * Is this the value we wrote?
 *
 * Compared leniently, because portals normalise what you give them: trimming
 * whitespace, upper-casing a PAN, reformatting a date, stripping the spaces
 * out of an account number. Treating any of those as "the page reset my value"
 * would refill forever in a loop.
 */
export function sameValue(current: string, expected: string): boolean {
  if (current === expected) return true;
  const a = normaliseForCompare(current);
  const b = normaliseForCompare(expected);
  if (a === b) return true;
  // maxLength truncation: the page kept a prefix of what we sent.
  return a.length > 0 && b.startsWith(a);
}

function normaliseForCompare(value: string): string {
  return value.trim().toLowerCase().replace(/[\s/-]+/g, '');
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value;
}
