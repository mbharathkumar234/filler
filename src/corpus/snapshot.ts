/**
 * A form captured for the corpus (U0.M1, `MASTER_PROMPT.md`): the page's own
 * HTML with everything that could belong to a person taken out.
 *
 * Kept: the structure the harvester, matcher and filler read — labels, hints,
 * headings, every attribute that describes a field, every option a form offers,
 * the page's own inline styles. Taken out: whatever was typed or chosen, hidden
 * tokens (an ASP.NET page's view state among them), scripts and their handlers,
 * comments, metadata, and every URL — photos, links with sessions in them,
 * stylesheets, frames. A snapshot opened later runs nothing and fetches nothing.
 *
 * What no cleaner can tell from a label is text a logged-in page prints about
 * its user ("Welcome, …"). That is why a logged-in page is captured and read
 * by the human before it is committed, and why the values scan runs over the
 * corpus (U0.M9).
 *
 * The page is copied into an inert document first, so the live page is never
 * changed and no component on it runs again. Self-contained, with no imports:
 * the capture tool injects this file into a real page as it is
 * (`scripts/capture-snapshot.mjs`). It is never part of the extension;
 * `verify-dist` refuses a build that contains `SNAPSHOT_GENERATOR`.
 */

/** Names every snapshot, and lets `verify-dist` prove the extension never ships this file. */
export const SNAPSHOT_GENERATOR = 'autofill-corpus-snapshot';

export interface SnapshotMeta {
  /** The corpus category (`MASTER_PROMPT.md` → U0.M2), e.g. "scholarships". */
  category: string;
  /** The technology the page is built with, e.g. "aspnet", "react", "php". */
  stack: string;
  /** YYYY-MM-DD. */
  capturedAt: string;
  /** The page's origin; only its host is kept. */
  origin: string;
  needsLogin: boolean;
}

/** Elements that run, load or embed something, and say nothing about a field. */
const DROPPED = new Set([
  'SCRIPT', 'NOSCRIPT', 'OBJECT', 'EMBED', 'APPLET', 'LINK', 'BASE', 'PORTAL',
  'AUDIO', 'VIDEO', 'SOURCE', 'TRACK', 'CANVAS', 'FRAMESET',
]);

/** Frames become a marker: their content is another page, captured on its own. */
const FRAMES = new Set(['IFRAME', 'FRAME']);

/** Attributes that hold a URL — a photo, a session, a stylesheet, somewhere to send the form. */
const URL_ATTRIBUTES = new Set([
  'src', 'srcset', 'href', 'action', 'formaction', 'poster', 'background', 'cite', 'data', 'ping',
  'longdesc', 'xlink:href', 'imagesrcset', 'manifest', 'codebase', 'archive', 'usemap', 'srcdoc',
  'lowsrc', 'dynsrc',
]);

/** Attributes that hold a choice, a value or a secret rather than a description. */
const PERSONAL_ATTRIBUTES = new Set([
  'checked', 'selected', 'aria-checked', 'aria-selected', 'aria-pressed', 'aria-valuetext', 'aria-valuenow',
  'nonce', 'integrity',
]);

/**
 * Roles whose `data-value` is the form's own code for a choice — a Google
 * Forms-style option — kept as a radio button's `value` is. On anything else a
 * `data-value` may be what was typed, and goes.
 */
const CHOICE_ROLES = new Set(['option', 'radio', 'checkbox', 'menuitemradio', 'menuitemcheckbox']);

/** Inputs whose `value` is the form's own code for a choice ("M", "GM") or a button's words. */
const CHOICE_INPUTS = new Set(['radio', 'checkbox', 'submit', 'button', 'reset', 'image']);

/** CSS with nothing it would fetch. */
function withoutUrls(css: string): string {
  return css.replace(/@import\s+[^;]*;?/gi, '').replace(/url\([^)]*\)/gi, 'none');
}

/** Hidden by the page's own styles, which a snapshot does not keep. */
function isHidden(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  if (view === null) return false;
  const style = view.getComputedStyle(element);
  return style.display === 'none' || style.visibility === 'hidden';
}

/**
 * A copy of `node` in the inert document: open shadow roots carried as
 * declarative `<template shadowrootmode="open">`, comments dropped, and what
 * the page's styles hid marked `hidden`.
 */
function copyNode(node: Node, inert: Document, inBody: boolean, parentHidden: boolean): Node | null {
  if (node.nodeType === 3) return inert.createTextNode(node.nodeValue ?? '');
  if (node.nodeType !== 1) return null;

  const element = node as Element;
  const copy = inert.importNode(element, false) as Element;
  const body = inBody || element.tagName === 'BODY';
  const hidden = parentHidden || (body && isHidden(element));
  if (hidden && !parentHidden) copy.setAttribute('hidden', '');

  const shadow = (element as HTMLElement).shadowRoot;
  if (shadow !== null && shadow !== undefined) {
    const template = inert.createElement('template');
    template.setAttribute('shadowrootmode', 'open');
    for (const child of Array.from(shadow.childNodes)) {
      const copied = copyNode(child, inert, body, hidden);
      if (copied !== null) template.content.append(copied);
    }
    copy.append(template);
  }

  const children = element.tagName === 'TEMPLATE' ? (element as HTMLTemplateElement).content.childNodes : element.childNodes;
  const target = copy.tagName === 'TEMPLATE' ? (copy as HTMLTemplateElement).content : copy;
  for (const child of Array.from(children)) {
    const copied = copyNode(child, inert, body, hidden);
    if (copied !== null) target.append(copied);
  }
  return copy;
}

function keepsValue(element: Element): boolean {
  const tag = element.tagName;
  if (tag === 'OPTION' || tag === 'BUTTON' || tag === 'LI') return true;
  if (tag === 'INPUT') return CHOICE_INPUTS.has((element.getAttribute('type') ?? 'text').toLowerCase());
  return false;
}

/** Take out of the copy everything that is not a description of the form. */
function clean(root: Element | DocumentFragment): void {
  for (const element of Array.from(root.querySelectorAll('*'))) {
    // Already gone with an ancestor.
    if (!root.contains(element)) continue;
    const tag = element.tagName;

    if (DROPPED.has(tag)) {
      element.remove();
      continue;
    }
    if (FRAMES.has(tag)) {
      const marker = element.ownerDocument.createElement('div');
      marker.setAttribute('data-snapshot-frame', '');
      element.replaceWith(marker);
      continue;
    }
    if (tag === 'META' && !element.hasAttribute('charset') && element.getAttribute('name') !== 'viewport') {
      element.remove();
      continue;
    }

    if (tag === 'TEMPLATE') clean((element as HTMLTemplateElement).content);
    if (tag === 'TEXTAREA') element.textContent = '';
    if (tag === 'STYLE') element.textContent = withoutUrls(element.textContent ?? '');
    const editable = element.getAttribute('contenteditable');
    if (editable !== null && editable.toLowerCase() !== 'false') element.textContent = '';

    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const choiceCode = name === 'data-value' && CHOICE_ROLES.has((element.getAttribute('role') ?? '').toLowerCase());
      if (
        name.startsWith('on') ||
        PERSONAL_ATTRIBUTES.has(name) ||
        (name.startsWith('data-') && name !== 'data-snapshot-frame' && !choiceCode)
      ) {
        element.removeAttribute(attribute.name);
      } else if (URL_ATTRIBUTES.has(name)) {
        if (tag === 'A' && name === 'href') element.setAttribute('href', '#');
        else if (tag === 'FORM' && name === 'action') element.setAttribute('action', '#');
        else element.removeAttribute(attribute.name);
      } else if (name === 'style') {
        element.setAttribute('style', withoutUrls(attribute.value));
      } else if (name === 'value' && !keepsValue(element)) {
        element.removeAttribute(attribute.name);
      }
    }
  }
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin.replace(/^[a-z]+:\/\//i, '').replace(/[/?#].*$/, '');
  }
}

/** The page as a corpus snapshot: its form, and nothing of the person who opened it. */
export function snapshotHtml(document: Document, meta: SnapshotMeta): string {
  const inert = document.implementation.createHTMLDocument('');
  const copy = copyNode(document.documentElement, inert, false, false) as Element;
  clean(copy);

  let head = copy.querySelector('head');
  if (head === null) {
    head = inert.createElement('head');
    copy.prepend(head);
  }
  const described: Array<[string, string]> = [
    ['generator', SNAPSHOT_GENERATOR],
    ['corpus:category', meta.category],
    ['corpus:stack', meta.stack],
    ['corpus:captured', meta.capturedAt],
    ['corpus:origin', hostOf(meta.origin)],
    ['corpus:login', meta.needsLogin ? 'yes' : 'no'],
  ];
  for (const [name, content] of described.reverse()) {
    const tag = inert.createElement('meta');
    tag.setAttribute('name', name);
    tag.setAttribute('content', content);
    head.prepend(tag);
  }
  return `<!doctype html>\n${copy.outerHTML}\n`;
}
