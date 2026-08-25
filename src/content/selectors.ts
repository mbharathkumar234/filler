/**
 * Ranked selector generation (§ Phase 3).
 *
 * Every field gets a *list* of selectors, best first, because portals rewrite
 * their DOM constantly. ASP.NET WebForms regenerates ids on every postback;
 * React apps hash class names per build. A single selector is a fill run that
 * breaks silently a month later — a ranked list is one that degrades.
 *
 * Order: id → name → label-anchored XPath → structural path. That is roughly
 * "most specific" to "most durable", and the resolver walks it until one hits.
 */

/**
 * Ids that look machine-generated and will not survive a page reload.
 *
 * The classic offenders:
 *   - ASP.NET: `ctl00_ContentPlaceHolder1_txtName`, `dnn_ctr445_...`
 *   - GUIDs and long hex runs: `field-8f14e45fceea167a`
 *   - Framework hashes: `mui-1234`, `:r3:`, `headlessui-input-7`
 *   - Bare index suffixes appended at render time: `input_17`
 */
export function looksUnstable(id: string): boolean {
  if (id === '') return true;
  return (
    /^ctl\d{2}[_$]/i.test(id) ||
    /(^|[_$-])ctl\d{2}([_$-]|$)/i.test(id) ||
    // DotNetNuke: dnn_ctr445_ViewName_txt
    /(^|[_$-])(dnn|ctr)\d*([_$-]|$)/i.test(id) ||
    /[0-9a-f]{12,}/i.test(id) ||
    /^[:.]/.test(id) ||
    /^(mui|radix|headlessui|chakra|mantine|ember)[-_]/i.test(id) ||
    /^r[0-9a-z]{4,}$/i.test(id) ||
    /\d{4,}$/.test(id) ||
    // Framework-generated ids are often mostly digits.
    (id.replace(/\D/g, '').length > 6 && id.replace(/\D/g, '').length / id.length > 0.5)
  );
}

/** Names are usually authored, but the same generated patterns leak into them. */
export function looksUnstableName(name: string): boolean {
  if (name === '') return true;
  return /^ctl\d{2}[_$]/i.test(name) || /[0-9a-f]{12,}/i.test(name);
}

export function cssEscape(value: string): string {
  // `CSS.escape` is unavailable in some worker/test contexts; this covers the
  // characters that actually appear in portal ids and names.
  return value.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}

function tagOf(el: Element): string {
  return el.tagName.toLowerCase();
}

/** `input[name="x"]` — scoped by tag so a name shared across tags stays distinct. */
function nameSelector(el: Element): string | null {
  const name = el.getAttribute('name');
  if (!name || looksUnstableName(name)) return null;
  return `${tagOf(el)}[name="${cssEscape(name)}"]`;
}

function idSelector(el: Element): string | null {
  const id = el.getAttribute('id');
  if (!id || looksUnstable(id)) return null;
  return `#${cssEscape(id)}`;
}

/**
 * A structural path: `form > div:nth-of-type(2) > input:nth-of-type(1)`.
 *
 * Survives id churn, breaks on layout changes. Last resort, but it is the one
 * selector that always exists.
 */
export function structuralPath(el: Element, root: Document | ShadowRoot | Element): string {
  const parts: string[] = [];
  let current: Element | null = el;

  while (current && current !== root && current.nodeType === 1) {
    const tag = tagOf(current);
    const parent: Element | null = current.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }

    const siblings = [...parent.children].filter((c) => tagOf(c) === tag);
    if (siblings.length === 1) {
      parts.unshift(tag);
    } else {
      parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
    }

    // An id-bearing ancestor anchors the path and keeps it short.
    const parentId = parent.getAttribute('id');
    if (parentId && !looksUnstable(parentId)) {
      parts.unshift(`#${cssEscape(parentId)}`);
      break;
    }
    current = parent;
  }

  return parts.join(' > ');
}

/**
 * An XPath anchored on the field's visible label text.
 *
 * This is the selector that survives an ASP.NET postback: the ids change, the
 * class names change, but the page still says "Father's Name" next to the box.
 */
export function labelAnchoredXPath(el: Element, labelText: string): string | null {
  const text = labelText.trim();
  if (text.length < 2 || text.length > 60) return null;
  if (text.includes('"')) return null;

  const doc = el.ownerDocument;
  if (!doc) return null;

  const tag = tagOf(el);

  const candidates = [
    `//label[normalize-space(text())="${text}"]/following::${tag}[1]`,
    `//td[contains(normalize-space(.),"${text}")]/following::${tag}[1]`,
    `//th[contains(normalize-space(.),"${text}")]/following::${tag}[1]`,
    `//*[normalize-space(text())="${text}"]/following::${tag}[1]`,
  ];

  // Every candidate is *verified* against the live DOM before being offered.
  //
  // Generating one from the label text alone produces confident nonsense: a
  // label that came from a placeholder or an aria-label matches no element at
  // all, `<th>` headers are not `<td>`, and in a grid `following::input[1]`
  // from the third header resolves to the first column's input — a selector
  // that silently fills the wrong field. Better to offer no XPath than a wrong
  // one; the structural path is always there as a fallback.
  for (const xpath of candidates) {
    if (resolvesTo(doc, xpath, el)) return xpath;
  }

  return null;
}

function resolvesTo(doc: Document, xpath: string, el: Element): boolean {
  try {
    const found = doc.evaluate(xpath, doc, null, 9 /* FIRST_ORDERED_NODE_TYPE */, null);
    return found.singleNodeValue === el;
  } catch {
    return false;
  }
}

/**
 * Build the ranked selector list for a field.
 *
 * Always returns at least one entry: the structural path is unconditional.
 */
export function buildSelectors(
  el: Element,
  labelText: string,
  root: Document | ShadowRoot | Element,
): string[] {
  const selectors: string[] = [];

  const byId = idSelector(el);
  if (byId) selectors.push(byId);

  const byName = nameSelector(el);
  if (byName) selectors.push(byName);

  const byLabel = labelAnchoredXPath(el, labelText);
  if (byLabel) selectors.push(byLabel);

  selectors.push(structuralPath(el, root));

  // An unstable id is still better than nothing if we have little else.
  const rawId = el.getAttribute('id');
  if (!byId && rawId && selectors.length < 2) {
    selectors.push(`#${cssEscape(rawId)}`);
  }

  return [...new Set(selectors)].filter((s) => s.length > 0);
}

/** True for XPath expressions, which need `evaluate` rather than `querySelector`. */
export function isXPath(selector: string): boolean {
  return selector.startsWith('//') || selector.startsWith('(/');
}
