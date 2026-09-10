/**
 * Label resolution (§ Phase 3).
 *
 * The plan names the cases that matter, and they are all real portal patterns:
 * `<table>` layouts, `<label>` siblings without `for`, floating labels,
 * `aria-labelledby`, and bare text nodes preceding the input.
 *
 * This is the highest-leverage code in the harvester. A field with no label is
 * a field the matcher cannot map and the review screen cannot describe — and
 * §Phase 3's Verify bar is ">=95% of visible fields with a non-empty labelText".
 *
 * Everything here is DOM-reading only: no mutation, no styles written, no
 * network. A portal must not be able to tell that we looked.
 */

/** Longest label we will keep. Beyond this it is prose, not a label. */
const MAX_LABEL = 120;

/** How far up the tree to look for a section heading. */
const SECTION_DEPTH = 6;

const IGNORED_TEXT = /^[\s*:•·\-–—()[\]{}]*$/;

export interface ResolvedLabel {
  text: string;
  /** Which rule produced it — surfaced in the review screen's rationale. */
  source:
    | 'label-for'
    | 'label-wrapping'
    | 'aria-labelledby'
    | 'aria-label'
    | 'table-cell'
    | 'sibling-label'
    | 'preceding-text'
    | 'placeholder'
    | 'title'
    | 'name-attribute'
    | 'none';
}

export function cleanLabel(raw: string | null | undefined): string {
  if (!raw) return '';
  const text = raw
    .replace(/\s+/g, ' ')
    .replace(/[*∗]/g, '') // required-field asterisks
    .replace(/^[\s:•·\-–—]+|[\s:•·\-–—]+$/g, '')
    .trim();
  return text.length > MAX_LABEL ? text.slice(0, MAX_LABEL).trim() : text;
}

/**
 * Tags that format *within* a word and must not introduce a space.
 *
 * Everything else is treated as a separate contribution to the label, which is
 * how a browser computes an accessible name and how a sighted reader sees the
 * page. `span` and `a` are deliberately **not** here: in modern form UIs they
 * are structural wrappers around whole phrases, not intra-word emphasis. The
 * trade is stated plainly — `<span>Stu</span>dent` would become "Stu dent" —
 * and it is the right way round, because welding two phrases together is both
 * far more common and far more damaging than splitting one word.
 */
const INLINE_TAGS = new Set([
  'b', 'i', 'em', 'strong', 'u', 's', 'sub', 'sup',
  'mark', 'abbr', 'code', 'kbd', 'samp', 'var', 'wbr', 'font', 'tt',
]);

/**
 * Concatenate an element's text the way it reads, not the way it is stored.
 *
 * `textContent` joins adjacent elements with **nothing at all**, which is fine
 * until a page puts two separate phrases in two sibling elements. Microsoft
 * Forms does exactly that: the question title and a screen-reader-only type
 * hint are siblings, so `textContent` returned
 *
 *     "1.Student NameSingle line text. Single line text."
 *
 * `NameSingle` is not a word, so "student name" no longer matched anything —
 * and what survived was the "1." from the question number and the "line" from
 * the type hint, which together partly match the synonym "address line 1".
 * The field was mapped to `address.permanent.line1` at 0.59, inside the
 * fill-and-flag band. A student's street address would have been typed into
 * the box labelled Student Name.
 *
 * So text nodes are collected with a separator at element boundaries. The
 * label becomes "1. Student Name Single line text.", which matches
 * `identity.full_name` at 0.80 — and the noise from the hint is harmless once
 * it is no longer glued to a real word.
 */
function collectText(node: Node, parts: string[]): void {
  if (node.nodeType === 3 /* text */) {
    parts.push(node.textContent ?? '');
    return;
  }
  if (node.nodeType !== 1 /* element */) return;

  const separates = !INLINE_TAGS.has((node as Element).tagName.toLowerCase());
  if (separates) parts.push(' ');
  for (const child of node.childNodes) collectText(child, parts);
  if (separates) parts.push(' ');
}

function textOf(el: Element | null): string {
  if (!el) return '';
  // Exclude nested form controls: a wrapping <label> containing the input
  // would otherwise pick up the input's own value or option text.
  const clone = el.cloneNode(true) as Element;
  for (const control of [...clone.querySelectorAll('input, select, textarea, button, script, style')]) {
    control.remove();
  }

  const parts: string[] = [];
  collectText(clone, parts);
  // `cleanLabel` collapses the runs of whitespace this deliberately creates.
  return cleanLabel(parts.join(''));
}

/** Text of the immediately preceding sibling nodes, nearest first. */
function precedingText(el: Element): string {
  let node: Node | null = el.previousSibling;
  const parts: string[] = [];

  while (node && parts.join(' ').length < MAX_LABEL) {
    if (node.nodeType === 3 /* text */) {
      const text = cleanLabel(node.textContent);
      if (text && !IGNORED_TEXT.test(text)) parts.unshift(text);
    } else if (node.nodeType === 1 /* element */) {
      const element = node as Element;
      // Another control means we have walked into the previous field.
      if (element.matches('input, select, textarea')) break;
      const text = textOf(element);
      if (text && !IGNORED_TEXT.test(text)) parts.unshift(text);
    }
    node = node.previousSibling;
  }

  return cleanLabel(parts.join(' '));
}

/**
 * The `<table>` case: `<td>Father's Name</td><td><input></td>`.
 *
 * Walks left across cells, and falls back to the row's first cell — portals
 * often put the label in column 1 with the input three columns over.
 */
function tableCellLabel(el: Element): string {
  const cell = el.closest('td, th');
  if (!cell) return '';

  let sibling = cell.previousElementSibling;
  while (sibling) {
    // A cell holding another control belongs to the previous field. Stop the
    // leftward walk — continuing would label this input with the neighbour's
    // caption, and §6.4 rates a wrong label worse than no label. The header-row
    // lookup below still applies, which is what handles grid layouts.
    if (sibling.querySelector('input, select, textarea')) break;

    const text = textOf(sibling);
    if (text && !IGNORED_TEXT.test(text)) return text;
    sibling = sibling.previousElementSibling;
  }

  // Nothing to the left in this row; try the row above in the same column
  // (a header row over a grid of inputs).
  const row = cell.closest('tr');
  const table = row?.closest('table');
  if (row && table) {
    const columnIndex = [...row.children].indexOf(cell);
    const previousRow = row.previousElementSibling;
    const header = previousRow?.children[columnIndex];
    if (header) {
      const text = textOf(header);
      if (text && !IGNORED_TEXT.test(text)) return text;
    }
  }

  return '';
}

/**
 * Floating / Material-style labels: `<div><input><label>Name</label></div>`,
 * where the label follows the input rather than preceding it.
 */
function siblingLabel(el: Element): string {
  const parent = el.parentElement;
  if (!parent) return '';

  for (const label of [...parent.querySelectorAll(':scope > label')]) {
    const text = textOf(label);
    if (text && !IGNORED_TEXT.test(text)) return text;
  }

  // One level up, for wrapper-per-field markup.
  const grandparent = parent.parentElement;
  if (grandparent) {
    const controls = grandparent.querySelectorAll('input, select, textarea');
    // Only trust this when the wrapper holds exactly one control.
    if (controls.length === 1) {
      for (const label of [...grandparent.querySelectorAll('label')]) {
        const text = textOf(label);
        if (text && !IGNORED_TEXT.test(text)) return text;
      }
    }
  }

  return '';
}

function ariaLabelledBy(el: Element): string {
  const ids = el.getAttribute('aria-labelledby');
  if (!ids) return '';
  const doc = el.ownerDocument;
  const parts = ids
    .split(/\s+/)
    .map((id) => doc?.getElementById(id))
    .filter((node): node is HTMLElement => node !== null && node !== undefined)
    .map((node) => textOf(node))
    .filter(Boolean);
  return cleanLabel(parts.join(' '));
}

/** Humanise `txtFatherName` / `applicant_dob` as an absolute last resort. */
export function humaniseIdentifier(value: string): string {
  const stripped = value
    .replace(/^(txt|ddl|chk|rdo|lst|hdn|fu|btn|input|field|frm)[_-]?/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length < 2) return '';
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

/**
 * Resolve the label for a form control, best rule first.
 *
 * Returns the rule that won alongside the text, because "we read the cell to
 * the left" is exactly the kind of thing a user needs to see when a match looks
 * wrong (§ Phase 7, "match rationale").
 */
export function resolveLabel(el: Element): ResolvedLabel {
  const doc = el.ownerDocument;

  // 1. <label for="...">
  const id = el.getAttribute('id');
  if (id && doc) {
    for (const label of [...doc.querySelectorAll('label[for]')]) {
      if (label.getAttribute('for') === id) {
        const text = textOf(label);
        if (text) return { text, source: 'label-for' };
      }
    }
  }

  // 2. A wrapping <label>.
  const wrapping = el.closest('label');
  if (wrapping) {
    const text = textOf(wrapping);
    if (text) return { text, source: 'label-wrapping' };
  }

  // 3. aria-labelledby, then aria-label.
  const labelled = ariaLabelledBy(el);
  if (labelled) return { text: labelled, source: 'aria-labelledby' };

  const aria = cleanLabel(el.getAttribute('aria-label'));
  if (aria) return { text: aria, source: 'aria-label' };

  // 4. Table layouts.
  const cell = tableCellLabel(el);
  if (cell) return { text: cell, source: 'table-cell' };

  // 5. A <label> sibling without `for` (floating labels).
  const sibling = siblingLabel(el);
  if (sibling) return { text: sibling, source: 'sibling-label' };

  // 6. Bare text nodes before the input.
  const preceding = precedingText(el);
  if (preceding) return { text: preceding, source: 'preceding-text' };

  // 7. Attributes that are not labels but are better than nothing.
  const placeholder = cleanLabel(el.getAttribute('placeholder'));
  if (placeholder) return { text: placeholder, source: 'placeholder' };

  const title = cleanLabel(el.getAttribute('title'));
  if (title) return { text: title, source: 'title' };

  const fromName = humaniseIdentifier(el.getAttribute('name') ?? el.getAttribute('id') ?? '');
  if (fromName) return { text: fromName, source: 'name-attribute' };

  return { text: '', source: 'none' };
}

/**
 * Nearby context for the LLM (§ Phase 8) and the review screen's grouping.
 *
 * The nearest section heading, plus any legend or fieldset caption. This is
 * what distinguishes "Address Line 1" under *Permanent Address* from the
 * identical field under *Correspondence Address*.
 */
export function resolveNearbyText(el: Element): string {
  const parts: string[] = [];

  const legend = el.closest('fieldset')?.querySelector('legend');
  if (legend) {
    const text = textOf(legend);
    if (text) parts.push(text);
  }

  const heading = findPrecedingHeading(el);
  if (heading && !parts.includes(heading)) parts.push(heading);

  return cleanLabel(parts.join(' — '));
}

function findPrecedingHeading(el: Element): string {
  let node: Element | null = el;
  let depth = 0;

  while (node && depth < SECTION_DEPTH) {
    let sibling: Element | null = node.previousElementSibling;
    while (sibling) {
      if (/^h[1-6]$/i.test(sibling.tagName)) {
        const text = textOf(sibling);
        if (text) return text;
      }
      // Section headings are often styled divs, not <h*>.
      const heading = sibling.querySelector?.('h1, h2, h3, h4, h5, h6');
      if (heading) {
        const text = textOf(heading);
        if (text) return text;
      }
      sibling = sibling.previousElementSibling;
    }
    node = node.parentElement;
    depth += 1;
  }

  return '';
}
