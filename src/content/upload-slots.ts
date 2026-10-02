/**
 * Upload controls that are not a plain file box (§ document attachment).
 *
 * The harvester sees `input, select, textarea`. Plenty of forms upload through
 * something else, and each shape needs a different kind of help:
 *
 *  - a **window** slot: a question whose control is an upload button ("Add
 *    file", "Browse", "Upload") with no file box beside it. Google Forms is the
 *    common case — the button opens the site's own upload window, which does
 *    not exist until the user clicks it.
 *  - a **drop** slot: a question with a drag-and-drop area and no file box in
 *    it. Dropzone.js is the common case — its real input is appended to
 *    `<body>`, nowhere near the question it belongs to.
 *  - a file box's own **Upload button**: the control an ASP.NET portal puts
 *    beside each file box, which posts the form. Recorded here so an approval
 *    can name it; never pressed here. Only `submit-guard.ts` presses anything,
 *    and only with a token (CLAUDE.md rule 1).
 *
 * Everything below is generic structure — roles, tags, the words on a button.
 * No site's ids or classes (rule 4). And, like the harvester, it only reads:
 * text is taken from detached clones, never by touching the page.
 */

import { cleanLabel, textOf } from './labels';
import { buildSelectors, cssEscape, structuralPath } from './selectors';

export interface UploadSlot {
  /** `u0`, `u1`… — never collides with a field's `f` ref. */
  ref: string;
  kind: 'window' | 'drop';
  /** The question's own words. */
  label: string;
  /** The hint beside it — "Upload 1 supported file. Max 10 MB." */
  requirementText: string;
  /** The control (window) or the drop area (drop). */
  selectors: string[];
  required: boolean;
}

export interface UploadButton {
  /** A CSS selector, because the guard resolves it with `querySelector`. */
  selector: string;
  label: string;
}

/** Form controls that hold data. A container holding one of these is someone's question. */
const DATA_CONTROL =
  'input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="button"]):not([type="image"]):not([type="reset"]), select, textarea';

const CLICKABLE = 'button, [role="button"], input[type="button"], input[type="submit"], input[type="image"], a';

const CAPTION = '[role="heading"], h1, h2, h3, h4, h5, h6, legend, label, th';

const FILE_NOUN =
  '(?:files?|documents?|docs?|photos?|photographs?|images?|pictures?|scans?|attachments?|certificates?|signatures?)';

/**
 * The words on a control that opens an upload window.
 *
 * "Upload", "Browse" and "Attach" stand alone; "Add", "Choose" and "Select"
 * need a noun, or every "Add qualification" row button would look like one.
 */
const WINDOW_VERB = new RegExp(
  `^\\+?\\s*(?:(?:upload|browse|attach)(?:\\s+(?:a|an|your|the|new))?(?:\\s+${FILE_NOUN})?|(?:add|choose|select)(?:\\s+(?:a|an|your|the|new))?\\s+${FILE_NOUN})\\s*(?:\\.\\.\\.|…)?$`,
  'i',
);

/**
 * A button's generic caption: an upload verb with, at most, "file".
 *
 * Narrower than `WINDOW_VERB` on purpose. "Upload Photograph" is a fine name
 * for an upload *control*, and an equally fine *question* — a portal's label
 * cell says exactly that. Only the words that could sit on any upload button
 * anywhere say nothing about which document is wanted.
 */
const GENERIC_CAPTION =
  /^\+?\s*(?:(?:upload|browse|attach)(?:\s+(?:a|an|your|the|new))?(?:\s+(?:files?|attachments?))?|(?:add|choose|select)(?:\s+(?:a|an|your|the|new))?\s+(?:files?|attachments?))\s*(?:\.\.\.|…)?$/i;

/**
 * Is this text a button's caption rather than a question's?
 *
 * "Choose file", "Browse", "Upload" — what a styled label wrapping a hidden
 * file box says. It names the control, and matching a document against it
 * finds nothing, or worse.
 */
export function isUploadCaption(text: string): boolean {
  return GENERIC_CAPTION.test(text.replace(/\s+/g, ' ').trim());
}

/** The words on a file box's own submit-style Upload button. */
const UPLOAD_BUTTON = new RegExp(
  `^(?:upload|attach|save)(?:\\s+(?:the|your|this))?(?:\\s+${FILE_NOUN})?$`,
  'i',
);

const DROP_TEXT = /drag\s*(?:&|and|n|'n')?\s*drop|drop\s+(?:your\s+|the\s+)?(?:files?|documents?|photos?|images?)\s+here/i;

/**
 * How far up from a control a question's caption may sit.
 *
 * Framework-built forms wrap a button in many layers of styling divs before
 * reaching the block that holds the question's words; six was not enough.
 */
const MAX_CLIMB = 12;

/** Structural roles that mark one question, for when climbing finds no words. */
const QUESTION_BLOCK = '[role="listitem"], [role="group"], fieldset, li';

/** Longest requirement hint we keep. Beyond this it is instructions for the whole page. */
const MAX_REQUIREMENT = 300;

// ---------------------------------------------------------------------------
// Reading text without touching the page
// ---------------------------------------------------------------------------

function indexPath(ancestor: Element, el: Element): number[] | null {
  const path: number[] = [];
  let node: Element | null = el;
  while (node && node !== ancestor) {
    const parent: Element | null = node.parentElement;
    if (!parent) return null;
    path.unshift([...parent.children].indexOf(node));
    node = parent;
  }
  return node === ancestor ? path : null;
}

/**
 * The container's text with the control's own caption removed.
 *
 * "Add file" is the button's name, not the question's. The removal happens on
 * a detached clone — the page itself is never edited.
 */
function textWithout(container: Element, control: Element): string {
  const clone = container.cloneNode(true) as Element;
  const path = indexPath(container, control);
  if (path) {
    let target: Element | null = clone;
    for (const index of path) target = target?.children[index] ?? null;
    target?.remove();
  }
  for (const other of [...clone.querySelectorAll('[role="button"], svg')]) other.remove();
  return textOf(clone);
}

/**
 * What a control says, as a person reads it.
 *
 * Icons are left out: an icon font spells its glyph's name as text
 * ("upload"), and `textContent` welds it to the caption — "uploadAdd File" —
 * which no wording rule matches. Read from a clone, with element boundaries
 * kept as spaces, like every other label here.
 */
function controlText(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.replace(/\s+/g, ' ').trim();
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') return (el.getAttribute('value') ?? el.getAttribute('alt') ?? '').trim();
  const clone = el.cloneNode(true) as Element;
  for (const icon of [...clone.querySelectorAll('svg, i, [aria-hidden="true"]')]) icon.remove();
  return textOf(clone);
}

/**
 * Does this short caption read as an upload control?
 *
 * Also true when the phrase *ends* the caption — "file_upload Add File",
 * "+ Upload" — because leftovers from icons and badges come first. Long text
 * is never a button's caption.
 */
function readsAsUploadControl(text: string): boolean {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  if (words.join(' ').length > 40) return false;
  for (let skip = 0; skip <= Math.min(3, words.length - 1); skip += 1) {
    if (WINDOW_VERB.test(words.slice(skip).join(' '))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The question a control belongs to
// ---------------------------------------------------------------------------

/**
 * The block holding one question: its caption, its hint, and its control.
 *
 * Climbs until it finds words that are not the control's own, and stops the
 * moment a block holds another question's control — past that point the text
 * belongs to someone else. `peers` are the other controls of the same kind on
 * the page: two "Add file" buttons in one block are two questions.
 */
export function questionContainer(
  control: Element,
  peers: ReadonlySet<Element> = new Set(),
): Element | null {
  let node = control.parentElement;
  for (let depth = 0; node && depth < MAX_CLIMB; depth += 1, node = node.parentElement) {
    const tag = node.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html' || tag === 'form') return null;
    if (holdsAnotherQuestion(node, control, peers)) return null;
    // A wrapping label, or a styled wrapper saying only "Choose file", is part
    // of the control. The question is further out.
    if (tag === 'label') continue;
    const own = textWithout(node, control);
    if (own !== '' && !isUploadCaption(own)) return node;
  }
  return null;
}

function holdsAnotherQuestion(node: Element, control: Element, peers: ReadonlySet<Element>): boolean {
  for (const other of node.querySelectorAll(`${DATA_CONTROL}, input[type="file"]`)) {
    if (other !== control && !control.contains(other) && !other.contains(control)) return true;
  }
  for (const peer of peers) {
    if (peer !== control && node.contains(peer) && !control.contains(peer) && !peer.contains(control)) {
      return true;
    }
  }
  return false;
}

/** The question's caption: its heading if it has one, else its first words. */
export function containerLabel(container: Element, control: Element): string {
  for (const caption of container.querySelectorAll(CAPTION)) {
    if (caption.contains(control) || control.contains(caption)) continue;
    const text = textOf(caption);
    if (text) return text;
  }

  // No caption element: the first block of words that is not the control.
  for (const child of container.children) {
    if (child === control || child.contains(control)) continue;
    const text = textOf(child);
    if (text) return text;
  }
  return cleanLabel(textWithout(container, control));
}

function describedBy(el: Element): string {
  const ids = el.getAttribute('aria-describedby');
  if (!ids) return '';
  return ids
    .split(/\s+/)
    .map((id) => el.ownerDocument.getElementById(id))
    .filter((node): node is HTMLElement => node !== null)
    .map((node) => textOf(node))
    .filter(Boolean)
    .join(' ');
}

/**
 * The hint beside an upload control, without its caption.
 *
 * Where a portal says "JPEG, 20–50 KB" or "Max 10 MB". Capped: a block that
 * runs past a few sentences is the page's general instructions, and parsing
 * those would apply one document's rules to another.
 */
export function requirementTextFor(
  control: Element,
  label: string,
  container: Element | null,
): string {
  const parts: string[] = [];
  const described = describedBy(control);
  if (described) parts.push(described);

  if (container) {
    let around = textWithout(container, control);
    if (label) around = around.replace(label, ' ');
    around = around.replace(/\s+/g, ' ').replace(/^[\s*:•·\-–—]+/, '').trim();
    if (around && !parts.includes(around)) parts.push(around);
  }

  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return text.length > MAX_REQUIREMENT ? text.slice(0, MAX_REQUIREMENT).trim() : text;
}

/** A file box's caption from its question, for a box with no label of its own. */
export function questionLabelFor(fileInput: Element): string {
  const container = questionContainer(fileInput, fileBoxesAround(fileInput));
  return container ? containerLabel(container, fileInput) : '';
}

function fileBoxesAround(fileInput: Element): Set<Element> {
  return new Set(fileInput.ownerDocument.querySelectorAll('input[type="file"]'));
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

/**
 * A link that goes somewhere is navigation, however it is worded.
 *
 * Found on a test portal whose header links to its own document page as
 * "Upload Documents". Read as an "Add file" button, it became an upload
 * question called "Home" — the nearest text — which the panel then asked the
 * user to assign a document to, and which belonged to no requirement at all.
 * An anchor still counts when it is a button in disguise: no href, `#`, or
 * `javascript:`, which is how older portals draw their Upload controls.
 */
function navigates(el: Element): boolean {
  if (el.tagName.toLowerCase() !== 'a') return false;
  const href = (el.getAttribute('href') ?? '').trim();
  return href !== '' && !href.startsWith('#') && !/^javascript:/i.test(href);
}

/** The page's own chrome: a menu is not a question, whatever its links say. */
const PAGE_CHROME = 'nav, [role="navigation"], [role="banner"], [role="contentinfo"]';

function isWindowControl(el: Element): boolean {
  if (navigates(el) || el.closest(PAGE_CHROME) !== null) return false;
  // A submit-type "Upload" posts the form; that is a file box's button, and
  // it is recorded separately, with its file box.
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  if (el.tagName.toLowerCase() === 'input' && type !== 'button') return false;
  if (el.tagName.toLowerCase() === 'button' && type === 'submit') return false;
  return readsAsUploadControl(controlText(el));
}

/** Drop areas: declared with `aria-dropeffect`, or saying "drag and drop" in words. */
function findDropAreas(root: Document): Element[] {
  const found = new Set<Element>(root.querySelectorAll('[aria-dropeffect]'));
  const walker = root.createTreeWalker(root.body ?? root, 4 /* SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    if (text.length > 200 || !DROP_TEXT.test(text)) continue;
    const parent = node.parentElement;
    if (!parent || parent.closest('script, style')) continue;
    // The drop handler usually sits on an ancestor; events bubble up to it.
    found.add(parent.closest('[aria-dropeffect]') ?? parent);
  }
  // Keep the outermost of any nested pair — one widget, one slot.
  return [...found].filter((el) => ![...found].some((other) => other !== el && other.contains(el)));
}

/**
 * The question block by its role, when climbing found no words of its own.
 *
 * A listitem, a group, a fieldset — structure the page declares — and only
 * when it holds no other control of the same kind.
 */
function questionBlock(control: Element, peers: ReadonlySet<Element>): Element | null {
  const block = control.parentElement?.closest(QUESTION_BLOCK) ?? null;
  if (!block) return null;
  for (const peer of peers) {
    if (peer !== control && block.contains(peer)) return null;
  }
  return block;
}

/** The control's own `aria-labelledby`, when it names a question rather than itself. */
function labelledBy(control: Element): string {
  const ids = control.getAttribute('aria-labelledby');
  if (!ids) return '';
  const text = ids
    .split(/\s+/)
    .map((id) => control.ownerDocument.getElementById(id))
    .filter((node): node is HTMLElement => node !== null && !node.contains(control))
    .map((node) => textOf(node))
    .filter(Boolean)
    .join(' ');
  return text && !isUploadCaption(text) && !readsAsUploadControl(text) ? text : '';
}

export interface SlotScan {
  slots: UploadSlot[];
  /** ref -> element, for `elementFor` and the fill. */
  elements: Map<string, Element>;
}

/**
 * Find the upload questions a form asks that have no file box of their own.
 *
 * `visible` is injected rather than imported so this module does not depend
 * on the harvester that depends on it.
 */
export function findUploadSlots(root: Document, visible: (el: Element) => boolean): SlotScan {
  const dropAreas = findDropAreas(root).filter(visible);
  const controls = [...root.querySelectorAll(CLICKABLE)].filter(
    (el) => isWindowControl(el) && visible(el),
  );

  const slots: UploadSlot[] = [];
  const elements = new Map<string, Element>();
  const claimed = new Set<Element>();

  const consider = (el: Element, kind: UploadSlot['kind'], peers: ReadonlySet<Element>) => {
    // Inside a question already found: the "Browse" button of a drop widget.
    if ([...claimed].some((container) => container.contains(el))) return;
    const container = questionContainer(el, peers) ?? questionBlock(el, peers);
    if (!container || claimed.has(container)) return;
    // A question with a file box of its own is the harvester's to fill.
    if (container.querySelector('input[type="file"]')) return;

    const label = labelledBy(el) || containerLabel(container, el);
    if (!label) return;
    claimed.add(container);

    const ref = `u${slots.length}`;
    slots.push({
      ref,
      kind,
      label,
      requirementText: requirementTextFor(el, label, container),
      selectors: buildSelectors(el, label, root),
      required: /[*∗]/.test(container.textContent?.slice(0, 300) ?? '') ||
        container.querySelector('[aria-required="true"]') !== null,
    });
    elements.set(ref, el);
  };

  // Drop areas first: a Dropzone-style widget also has a "Browse" button, and
  // a drop is the one of the two the extension can complete by itself.
  const dropPeers = new Set(dropAreas);
  for (const area of dropAreas) consider(area, 'drop', dropPeers);
  const controlPeers = new Set(controls);
  for (const control of controls) consider(control, 'window', controlPeers);

  return { slots, elements };
}

// ---------------------------------------------------------------------------
// A file box's own Upload button
// ---------------------------------------------------------------------------

/** A selector `querySelector` can use: the guard does not speak XPath. */
export function cssSelectorFor(el: Element, root: Document): string {
  const id = el.getAttribute('id');
  if (id) return `#${cssEscape(id)}`;
  const name = el.getAttribute('name');
  if (name) return `${el.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
  return structuralPath(el, root);
}

/**
 * The control beside a file box that sends it — "Upload", "Upload Photo".
 *
 * Only inside the file box's own question, and never the form's final submit:
 * an approval to upload a photograph must not be able to name "Submit
 * Application" by accident.
 */
export function findUploadButton(
  fileInput: Element,
  finalSubmit: Element | null,
): { element: Element; button: UploadButton } | null {
  const container = questionContainer(fileInput, fileBoxesAround(fileInput)) ?? fileInput.parentElement;
  if (!container) return null;

  for (const candidate of container.querySelectorAll(CLICKABLE)) {
    if (candidate === finalSubmit || (finalSubmit && candidate.contains(finalSubmit))) continue;
    const text = controlText(candidate);
    if (!UPLOAD_BUTTON.test(text)) continue;
    return {
      element: candidate,
      button: { selector: cssSelectorFor(candidate, fileInput.ownerDocument), label: text },
    };
  }
  return null;
}
