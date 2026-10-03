/**
 * The DOM harvester (§ Phase 3): DOM → `FieldDescriptor[]`.
 *
 * Read-only. It never writes an attribute, never sets a style, never dispatches
 * an event. A portal must not be able to tell that the page was inspected, and
 * more practically: a harvester that mutates is a harvester that can break the
 * page it is trying to help with.
 *
 * Scope discipline — this file maps the page and stops. No matching (Phase 4),
 * no filling (Phase 5).
 */

import type { FieldDescriptor, FieldOption, FieldTag } from '@/shared/types';
import { choiceWidgetOf, isSuggestionList, widgetOptions } from './choice-widgets';
import { cleanLabel, resolveLabel, resolveNearbyText, type ResolvedLabel } from './labels';
import { buildSelectors } from './selectors';
import {
  isUploadCaption,
  questionContainer,
  questionLabelFor,
  requirementTextFor,
} from './upload-slots';

/** Input types that are not user-fillable data, or that we must never touch. */
const SKIPPED_INPUT_TYPES = new Set([
  'submit',
  'button',
  'reset',
  'image',
  'hidden',
  // Never harvest a credential field: it is not ours to fill (P4), and even
  // describing it invites a future phase to try.
  'password',
]);

/** Names/ids that mark a security control. Reported, never filled (P4). */
const SECURITY_HINTS = /captcha|otp|^vcode$|verification.?code|securitycode|__requestverification/i;

export interface HarvestOptions {
  /** Pierce open shadow roots. Phase 3 "Should Achieve". */
  shadowDom?: boolean;
  /** Frame id this harvest is running in. 0 for the top document. */
  frameId?: number;
  /** Cap, so a pathological page cannot hang the panel. */
  maxFields?: number;
}

export interface HarvestResult {
  fields: FieldDescriptor[];
  /** Resolves a descriptor ref back to its element, for later phases. */
  elements: Map<string, Element>;
  /** Cross-origin frames and security widgets we could see but not read. */
  blockers: BlockerCandidate[];
  /** Multi-step wizard detection, when the page looks like one. */
  wizard: WizardInfo | null;
  /** Rationale per field, for the review screen. */
  labelSources: Map<string, ResolvedLabel['source']>;
}

export interface BlockerCandidate {
  type: 'unknown_widget' | 'captcha' | 'otp';
  reason: string;
  selector: string;
}

export interface WizardInfo {
  /** 1-based, when detectable. */
  step: number | null;
  totalSteps: number | null;
  /** Text of the step indicator or next control that gave it away. */
  evidence: string;
}

/**
 * Native controls, and the choice questions that are not native controls: a
 * Google Form's dropdowns and multiple-choice questions are divs with a role
 * (`choice-widgets.ts`). One query, so every field keeps its place in the page.
 */
const FIELD_SELECTOR = 'input, select, textarea, [role="radiogroup"], [role="listbox"]';
const CHOICE_ROLES = '[role="radiogroup"], [role="listbox"]';

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

/**
 * Is this control actually on screen for the user?
 *
 * Two independent checks, because neither alone is enough: computed style
 * catches `display:none` (and works without layout, so tests can exercise it),
 * while the bounding rect catches zero-sized and clipped elements that styles
 * alone would call visible.
 */
export function isVisible(el: Element): boolean {
  const win = el.ownerDocument?.defaultView;
  if (!win) return false;

  if (el.hasAttribute('hidden')) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;

  let node: Element | null = el;
  let depth = 0;
  while (node && depth < 30) {
    const style = win.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
      return false;
    }
    if (style.opacity === '0') return false;
    node = node.parentElement;
    depth += 1;
  }

  // Layout check. In a DOM without layout every rect is zero, so only treat a
  // zero rect as hidden when the environment actually does layout.
  const rect = el.getBoundingClientRect();
  const hasLayout = (el.ownerDocument.body?.getBoundingClientRect().height ?? 0) > 0;
  if (hasLayout && rect.width === 0 && rect.height === 0) return false;

  return true;
}

function isEnabled(el: Element): boolean {
  if (el.hasAttribute('disabled')) return false;
  if (el.getAttribute('aria-disabled') === 'true') return false;
  if ((el as HTMLInputElement).readOnly) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Field classification
// ---------------------------------------------------------------------------

function classify(el: Element): FieldTag {
  const widget = choiceWidgetOf(el);
  if (widget === 'radiogroup') return 'radio-group';
  if (widget === 'listbox') return 'select';
  const tag = el.tagName.toLowerCase();
  if (tag === 'select') return 'select';
  if (tag === 'textarea') return 'textarea';

  const type = (el.getAttribute('type') ?? 'text').toLowerCase();
  if (type === 'radio') return 'radio-group';
  if (type === 'checkbox') return 'checkbox';
  if (type === 'file') return 'file';
  return 'input';
}

function optionsOf(el: Element): FieldOption[] | undefined {
  if (el.tagName.toLowerCase() !== 'select') return undefined;
  const options = [...el.querySelectorAll('option')].map((option) => ({
    value: option.getAttribute('value') ?? option.textContent?.trim() ?? '',
    text: (option.textContent ?? '').replace(/\s+/g, ' ').trim(),
  }));
  return options.length > 0 ? options : undefined;
}

/**
 * Radio groups are one logical field, not N.
 *
 * A portal renders "Gender" as three inputs sharing a name; the taxonomy has
 * one `identity.gender` key. Collapsing here means the matcher and the review
 * screen both see what the user sees.
 */
function radioGroupOptions(el: Element, scope: ParentNode): FieldOption[] {
  const name = el.getAttribute('name');
  if (!name) return [];
  const members = [...scope.querySelectorAll(`input[type="radio"]`)].filter(
    (r) => r.getAttribute('name') === name,
  );
  return members.map((member) => ({
    value: member.getAttribute('value') ?? '',
    text: resolveLabel(member).text,
  }));
}

// ---------------------------------------------------------------------------
// Harvest
// ---------------------------------------------------------------------------

export function harvest(
  root: Document | ShadowRoot,
  options: HarvestOptions = {},
): HarvestResult {
  const { shadowDom = true, frameId = 0, maxFields = 500 } = options;

  const fields: FieldDescriptor[] = [];
  const elements = new Map<string, Element>();
  const labelSources = new Map<string, ResolvedLabel['source']>();
  const blockers: BlockerCandidate[] = [];
  const seenRadioGroups = new Set<string>();

  let index = 0;

  const collect = (scope: Document | ShadowRoot | Element, scopeRoot: Document | ShadowRoot) => {
    for (const el of [...scope.querySelectorAll(FIELD_SELECTOR)]) {
      if (fields.length >= maxFields) return;

      const type = (el.getAttribute('type') ?? '').toLowerCase();
      if (SKIPPED_INPUT_TYPES.has(type)) continue;

      // A role that is not a question we can answer — an autocomplete's list of
      // suggestions, a group of real radio buttons — is passed over here; the
      // real controls inside it are found on their own.
      const widget = choiceWidgetOf(el);
      if (el.matches(CHOICE_ROLES) && !(el.tagName.toLowerCase() === 'select')) {
        if (!widget || isSuggestionList(el)) continue;
      }
      // A box inside a choice question is its "Other", answered with the choice.
      const owner = widget ? null : el.parentElement?.closest(CHOICE_ROLES);
      if (owner && choiceWidgetOf(owner)) continue;

      const identity = `${el.getAttribute('name') ?? ''} ${el.getAttribute('id') ?? ''}`;
      if (SECURITY_HINTS.test(identity)) {
        // Report, never describe as fillable (P4).
        blockers.push({
          type: /captcha/i.test(identity) ? 'captcha' : 'otp',
          reason: `Security field "${identity.trim()}" — the user must complete this themselves.`,
          selector: buildSelectors(el, '', scopeRoot)[0] ?? '',
        });
        continue;
      }

      // One descriptor per radio group.
      if (type === 'radio') {
        const name = el.getAttribute('name') ?? '';
        if (name && seenRadioGroups.has(name)) continue;
        if (name) seenRadioGroups.add(name);
      }

      const ref = `f${index}`;
      index += 1;

      const tag = classify(el);
      const label = labelFor(el, tag);
      const options = widget
        ? widgetOptions(el).map(({ option }) => ({ value: option.value ?? option.text, text: option.text }))
        : tag === 'radio-group'
          ? radioGroupOptions(el, scope)
          : optionsOf(el);

      const descriptor: FieldDescriptor = {
        ref,
        selectors: buildSelectors(el, label.text, scopeRoot),
        tag,
        labelText: label.text,
        nearbyText: resolveNearbyText(el),
        required: isRequired(el),
        frameId,
        visible: isVisible(el),
        enabled: isEnabled(el),
      };

      const rawType = el.getAttribute('type');
      if (rawType) descriptor.type = rawType.toLowerCase();

      const placeholder = el.getAttribute('placeholder');
      if (placeholder) descriptor.placeholder = placeholder;

      const autocomplete = el.getAttribute('autocomplete');
      if (autocomplete) descriptor.autocomplete = autocomplete;

      if (options && options.length > 0) descriptor.options = options;

      const maxLength = el.getAttribute('maxlength');
      if (maxLength && Number(maxLength) > 0) descriptor.maxLength = Number(maxLength);

      const pattern = el.getAttribute('pattern');
      if (pattern) descriptor.pattern = pattern;

      // `inputmode` is how a modern portal declares "digits only". The traits
      // veto reads it, so a numeric box labelled "Name" cannot become one.
      const inputmode = el.getAttribute('inputmode');
      if (inputmode) descriptor.inputmode = inputmode;

      // A file box's requirement is what decides the size and format of the
      // document that goes into it — see `documents/field-constraint.ts`.
      if (tag === 'file') {
        const accept = el.getAttribute('accept');
        if (accept) descriptor.accept = accept;
        const requirement = requirementTextFor(
          el,
          label.text,
          questionContainer(el, new Set(scope.querySelectorAll('input[type="file"]'))),
        );
        if (requirement) descriptor.requirementText = requirement;
      }

      fields.push(descriptor);
      elements.set(ref, el);
      labelSources.set(ref, label.source);

      if (shadowDom && el.shadowRoot) collect(el.shadowRoot, scopeRoot);
    }

    // Shadow hosts elsewhere in the tree.
    if (shadowDom) {
      for (const host of [...scope.querySelectorAll('*')]) {
        if (host.shadowRoot) collect(host.shadowRoot, scopeRoot);
      }
    }
  };

  collect(root, root);
  blockers.push(...findFrameBlockers(root));

  return { fields, elements, blockers, wizard: detectWizard(root), labelSources };
}

/** Label sources that are a guess rather than the page naming the field. */
const WEAK_SOURCES: ReadonlySet<ResolvedLabel['source']> = new Set([
  'placeholder',
  'title',
  'name-attribute',
  'none',
]);

/**
 * A field's label, with fallbacks that only file boxes need.
 *
 * A file box hidden behind a styled "Choose file" button, or inside a
 * drag-and-drop widget, rarely has a label of its own — the caption belongs to
 * the question around it. So for a file box these readings are not trusted:
 *
 *  - a guessed source (placeholder, title, a humanised id);
 *  - a label that is only a button's caption — "Choose file", "Browse";
 *  - text that merely precedes a box nobody can see. Dropzone appends its
 *    input to the end of `<body>`, where the "preceding text" is the entire
 *    form, and a box named after the entire form could be given any document.
 *
 * The question's own heading replaces them when there is one. When there is
 * not, the invisible box stays unnamed: a document that goes nowhere is better
 * than one that goes into the wrong box.
 */
function labelFor(el: Element, tag: FieldTag): ResolvedLabel {
  if (tag === 'radio-group' && el.tagName.toLowerCase() === 'input') {
    const legend = groupLegend(el);
    if (legend) return { text: legend, source: 'question-heading' };
  }
  const label = resolveLabel(el);
  if (tag !== 'file') return label;

  const strayText = label.source === 'preceding-text' && !isVisible(el);
  const guessed = WEAK_SOURCES.has(label.source) || isUploadCaption(label.text) || strayText;
  if (!guessed) return label;

  const heading = questionLabelFor(el);
  if (heading) return { text: heading, source: 'question-heading' };
  return strayText ? { text: '', source: 'none' } : label;
}

/**
 * A radio group's question, from the fieldset that holds it.
 *
 * A radio's own label is its option — "M", "Hindu" — and the first one's was
 * standing in for the question. The legend is the question when the fieldset
 * holds this group alone (and, at most, the box for its "Other"); a fieldset
 * holding more is a section, and its legend a section heading.
 */
function groupLegend(radio: Element): string {
  const fieldset = radio.closest('fieldset');
  const legend = fieldset?.querySelector(':scope > legend');
  if (!fieldset || !legend) return '';
  const name = radio.getAttribute('name');
  let boxes = 0;
  for (const control of fieldset.querySelectorAll('input, select, textarea')) {
    const type = (control.getAttribute('type') ?? '').toLowerCase();
    if (type === 'hidden') continue;
    if (type === 'radio' && control.getAttribute('name') === name) continue;
    if (control.tagName.toLowerCase() === 'input' && (type === '' || type === 'text')) {
      boxes += 1;
      if (boxes === 1) continue;
    }
    return '';
  }
  return cleanLabel(legend.textContent);
}

function isRequired(el: Element): boolean {
  if (el.hasAttribute('required')) return true;
  if (el.getAttribute('aria-required') === 'true') return true;
  // Portals mark required fields with a class or a nearby asterisk far more
  // often than with the attribute.
  const className = el.getAttribute('class') ?? '';
  if (/\b(required|mandatory|is-required)\b/i.test(className)) return true;
  // Portals mark required with an asterisk beside the label, which in a table
  // layout sits in a different cell from the input — so check the row too.
  const scope = el.closest('tr, .form-group, .field, li') ?? el.closest('td, div');
  if (scope && /[*∗]/.test(scope.textContent?.slice(0, 300) ?? '')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/**
 * Find iframes we cannot read.
 *
 * A cross-origin frame is reported as a `BLOCKED:unknown_widget` candidate
 * rather than skipped, because it is usually the CAPTCHA, the payment widget,
 * or the eSign step — exactly the things Phase 6 must pause for. Silence here
 * would mean a run that thinks it filled everything and then submits into a
 * gate the user never saw.
 */
export function findFrameBlockers(root: Document | ShadowRoot): BlockerCandidate[] {
  const blockers: BlockerCandidate[] = [];

  for (const frame of [...root.querySelectorAll('iframe, frame')]) {
    const src = frame.getAttribute('src') ?? '';
    const title = frame.getAttribute('title') ?? '';

    if (!isInaccessibleFrame(frame, src)) continue;

    const looksLikeCaptcha = /recaptcha|hcaptcha|turnstile|captcha/i.test(`${src} ${title}`);
    blockers.push({
      type: looksLikeCaptcha ? 'captcha' : 'unknown_widget',
      reason: looksLikeCaptcha
        ? 'A CAPTCHA widget is on this page. You will need to complete it yourself.'
        : `A cross-origin frame (${describeOrigin(src)}) could not be read. It may contain fields.`,
      selector: buildSelectors(frame, title, root)[0] ?? 'iframe',
    });
  }

  return blockers;
}

/**
 * Can we read inside this frame?
 *
 * Origin is compared from the URL rather than trusting `contentDocument`,
 * because the answer has to be right in two places: a real browser (where a
 * cross-origin access throws) and jsdom (where it does not, since nothing is
 * actually loaded). Comparing origins is correct in both.
 */
function isInaccessibleFrame(frame: Element, src: string): boolean {
  // srcdoc and about:blank inherit the parent's origin.
  if (frame.hasAttribute('srcdoc')) return false;
  if (!src || src === 'about:blank') return false;
  if (src.startsWith('javascript:')) return false;

  const doc = frame.ownerDocument;
  const here = doc?.defaultView?.location?.href ?? '';

  try {
    const target = new URL(src, here || undefined);
    if (target.protocol === 'data:' || target.protocol === 'blob:') return true;
    const current = new URL(here);
    if (target.origin !== current.origin) return true;
  } catch {
    // An unparseable src is one we certainly cannot traverse into.
    return true;
  }

  // Same origin by URL — confirm the document is really reachable.
  try {
    return (frame as HTMLIFrameElement).contentDocument === null;
  } catch {
    return true;
  }
}

function describeOrigin(src: string): string {
  if (!src) return 'no source';
  try {
    return new URL(src, 'https://example.invalid').host || 'relative';
  } catch {
    return 'unparseable';
  }
}

// ---------------------------------------------------------------------------
// Multi-step wizards
// ---------------------------------------------------------------------------

const STEP_PATTERNS = [
  /step\s*(\d+)\s*(?:of|\/)\s*(\d+)/i,
  /page\s*(\d+)\s*(?:of|\/)\s*(\d+)/i,
  /(\d+)\s*\/\s*(\d+)\s*$/,
];

/**
 * Detect a multi-step form and which step we are on.
 *
 * Phase 6 folds this into the form fingerprint so a resumed run does not think
 * step 3 is step 1 and refill the wrong page.
 */
export function detectWizard(root: Document | ShadowRoot): WizardInfo | null {
  const scope = 'body' in root ? (root as Document).body : (root as ShadowRoot);
  if (!scope) return null;

  // Headings are in the list because plenty of portals announce the step in an
  // <h1> and nowhere else — "Scholarship Application — Step 2 of 3" — with no
  // step class, no progress bar, and no numbered nav to find.
  const candidates = [
    ...scope.querySelectorAll(
      '[class*="step" i], [class*="wizard" i], [class*="progress" i], [id*="step" i], nav, ol, ul, h1, h2, h3, h4, legend, caption',
    ),
  ].slice(0, 60);

  for (const node of candidates) {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    for (const pattern of STEP_PATTERNS) {
      const match = pattern.exec(text);
      if (match) {
        return {
          step: Number(match[1]),
          totalSteps: Number(match[2]),
          evidence: text,
        };
      }
    }
  }

  // An active item in a step list, without explicit numbering.
  const active = scope.querySelector(
    '[class*="step" i][class*="active" i], [class*="step" i][aria-current]',
  );
  if (active) {
    const list = active.parentElement;
    const items = list ? [...list.children] : [];
    const position = items.indexOf(active);
    return {
      step: position >= 0 ? position + 1 : null,
      totalSteps: items.length > 0 ? items.length : null,
      evidence: (active.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
    };
  }

  // A "Next" control implies more steps, even when we cannot count them.
  const next = [...scope.querySelectorAll('button, input[type="submit"], a')].find((el) =>
    /^(next|save\s*(&|and)\s*(next|continue)|continue|proceed)$/i.test(
      (el.textContent ?? el.getAttribute('value') ?? '').trim(),
    ),
  );
  if (next) {
    return {
      step: null,
      totalSteps: null,
      evidence: (next.textContent ?? next.getAttribute('value') ?? 'Next').trim(),
    };
  }

  return null;
}
