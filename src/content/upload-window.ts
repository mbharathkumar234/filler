/**
 * Putting a document into a site's own upload window (§ document attachment).
 *
 * Google Forms' "Add file" opens Google's upload window: a same-origin frame
 * that does not exist until the user clicks. The user opens it; the panel's
 * "Put … in the upload window" puts the document into it; the user presses
 * its Upload. Nothing here clicks anything, ever.
 *
 * ## Why these are not part of `content.js`
 *
 * They run as `chrome.scripting.executeScript({ func, args })`, which sends
 * each function's *source text* into the page. So:
 *
 *  - **every function here is self-contained** — no imports, no helpers from
 *    module scope, nothing but its own body and browser globals. A reference
 *    to anything outside would be `undefined` in the page. The e2e suite runs
 *    them from their `toString()` to hold that line;
 *  - nothing else from the extension arrives with them. No listeners, no run
 *    controller, no overlay — only the one job, in the one frame chosen.
 *
 * Read-only apart from the one write the user asked for: the probe only
 * counts, and the placement only sets a file box's files or dispatches a drop.
 */

/** What one frame looks like, to the worker choosing where the window is. */
export interface WindowProbe {
  top: boolean;
  /** Enabled file boxes, visible or not — a window's is usually hidden. */
  fileBoxes: number;
  /** Drag-and-drop areas, declared or described in words. */
  dropAreas: number;
  /** An open dialog in this document that could hold an upload. */
  dialog: boolean;
  /** Origins of visible frames in this document, so a foreign window can be named. */
  frameOrigins: string[];
  origin: string;
  /**
   * Is this frame on screen at all? A site's upload window often stays in the
   * page, hidden, after it closes — and a hidden stale window must never be
   * mistaken for the one the user just opened.
   */
  shown: boolean;
}

export interface WindowResult {
  placed: boolean;
  route?: 'file-box' | 'drop';
  why?: string;
}

/** Count what this frame offers. Reads nothing but structure. */
export function probeUploadWindow(): WindowProbe {
  const dropWords =
    /drag\s*(?:&|and|n|'n')?\s*drop|drop\s+(?:your\s+|the\s+)?(?:files?|documents?|photos?|images?)\s+here|drag\s+(?:a\s+|your\s+)?files?\s+here/i;
  const shown = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };

  const boxes = Array.from(document.querySelectorAll('input[type="file"]')).filter(
    (box) => !(box as HTMLInputElement).disabled && !box.hasAttribute('webkitdirectory'),
  );

  let drops = document.querySelectorAll('[aria-dropeffect]').length;
  if (drops === 0 && document.body) {
    const walker = document.createTreeWalker(document.body, 4 /* SHOW_TEXT */);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? '';
      if (text.length < 200 && dropWords.test(text)) {
        drops = 1;
        break;
      }
    }
  }

  const dialog = Array.from(document.querySelectorAll('[role="dialog"], dialog[open]')).some(
    (el) => shown(el) && el.querySelector('input[type="file"], [aria-dropeffect], iframe') !== null,
  );

  const frameOrigins: string[] = [];
  for (const frame of Array.from(document.querySelectorAll('iframe'))) {
    if (!shown(frame)) continue;
    try {
      frameOrigins.push(new URL(frame.getAttribute('src') ?? '', location.href).origin);
    } catch {
      /* an unparseable src names nothing we could ask for */
    }
  }

  // `globalThis`, not `window`: this function's source ships inside the
  // worker bundle, which must not name a DOM global (`worker-bundle.test.ts`),
  // even in code that only ever runs in a page.
  let top: boolean;
  try {
    top = (globalThis.top as unknown) === globalThis;
  } catch {
    top = false;
  }

  /*
   * On screen, judged from the page's side as well as our own.
   *
   * From inside, a frame hidden with `visibility: hidden` still has its full
   * size — and that is how Google hides its upload window between uploads, to
   * show the same one again on the next "Add file". Counting it as open made
   * that next window look old, so every hold managed exactly one document. A
   * same-origin frame can see its own element in the page, so it asks there.
   */
  let shownHere = innerWidth > 0 && innerHeight > 0 && document.visibilityState !== 'hidden';
  try {
    const host = globalThis.frameElement;
    if (shownHere && host) {
      const box = host.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) shownHere = false;
      for (let el: Element | null = host; shownHere && el; el = el.parentElement) {
        const style = el.ownerDocument.defaultView?.getComputedStyle(el);
        if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          shownHere = false;
        }
      }
    }
  } catch {
    // A frame from another site cannot see its element. Its own size stands.
  }

  return {
    top,
    fileBoxes: boxes.length,
    dropAreas: drops,
    dialog,
    frameOrigins,
    origin: location.origin,
    shown: shownHere,
  };
}

/**
 * Put one file into this frame's upload window.
 *
 * `mode` is the panel's second try. The first ("box") sets the window's file
 * box the way a drag-and-drop would, and drops only when there is no box. If
 * the window did not react, the user can ask for "drop", which skips the box.
 * Doing both at once could hand the window the same file twice.
 */
export function placeFileInWindow(
  base64: string,
  mime: string,
  filename: string,
  mode: 'box' | 'drop',
): WindowResult {
  const dropWords =
    /drag\s*(?:&|and|n|'n')?\s*drop|drop\s+(?:your\s+|the\s+)?(?:files?|documents?|photos?|images?)\s+here|drag\s+(?:a\s+|your\s+)?files?\s+here/i;

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const file = new File([bytes], filename, { type: mime });
  const carrying = (): DataTransfer => {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    return transfer;
  };

  const takes = (box: HTMLInputElement): boolean => {
    const accept = (box.getAttribute('accept') ?? '').toLowerCase().trim();
    if (accept === '') return true;
    return accept.split(',').some((raw) => {
      const entry = raw.trim();
      if (entry === mime || entry === '*/*' || entry === '*') return true;
      if (entry.endsWith('/*')) return mime.startsWith(entry.slice(0, -1));
      return entry.startsWith('.') && filename.toLowerCase().endsWith(entry);
    });
  };

  /*
   * Where "the window" is.
   *
   * In a frame of its own, the whole frame is the window. In the page itself
   * it is the page's open dialog, and only that. Searching the whole page sent
   * a document meant for an upload window into the first file box that would
   * take its type: on a test portal an income certificate went into the
   * *photo* box, named "income_certificate.jpg", and the portal rightly
   * refused it. The page's own file boxes are Fill's, never a window's.
   */
  let inTop: boolean;
  try {
    inTop = (globalThis.top as unknown) === globalThis;
  } catch {
    inTop = false;
  }
  const onScreen = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const scope: Element | Document | null = inTop
    ? (Array.from(document.querySelectorAll('[role="dialog"], dialog[open]')).find(onScreen) ?? null)
    : document;
  if (scope === null) {
    return { placed: false, why: 'No upload window is open on this page. Open it with its own button first.' };
  }

  const boxes = Array.from(scope.querySelectorAll<HTMLInputElement>('input[type="file"]')).filter(
    (box) => !box.disabled && !box.hasAttribute('webkitdirectory'),
  );
  // A reused window keeps the views it showed before, each with its own box.
  // The one that counts is in the view on screen now.
  const inShownView = (el: Element): boolean => {
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  };
  const box =
    boxes.find((candidate) => takes(candidate) && inShownView(candidate)) ??
    [...boxes].reverse().find(takes) ??
    null;

  if (mode === 'box' && box) {
    try {
      // Emptied first: a window reused for a second document still holds the
      // first, and setting the same list again may not raise a change at all.
      box.value = '';
      box.files = carrying().files;
      // Checked before the events, not after: a window such as Google's takes
      // the file on `change` and empties its box at once, so reading the box
      // afterwards mistook a successful upload for a refusal.
      const landed = box.files !== null && box.files.length === 1 && box.files[0]?.name === filename;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.dispatchEvent(new Event('change', { bubbles: true }));
      if (landed) return { placed: true, route: 'file-box' };
    } catch {
      // Fall through to a drop.
    }
  }

  let target: Element | null = scope.querySelector('[aria-dropeffect]');
  const walkRoot: Node | null = scope === document ? document.body : (scope as Element);
  if (!target && walkRoot) {
    const walker = document.createTreeWalker(walkRoot, 4 /* SHOW_TEXT */);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? '';
      if (text.length < 200 && dropWords.test(text)) {
        target = node.parentElement;
        break;
      }
    }
  }

  if (target) {
    const transfer = carrying();
    let taken = false;
    for (const type of ['dragenter', 'dragover', 'drop']) {
      const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer });
      const uncancelled = target.dispatchEvent(event);
      if (type === 'drop') taken = !uncancelled;
    }
    if (taken) return { placed: true, route: 'drop' };
  }

  if (boxes.length > 0 && !box) {
    return { placed: false, why: `The upload window does not accept ${filename.split('.').pop()?.toUpperCase() ?? 'this'} files.` };
  }
  return {
    placed: false,
    why: target
      ? 'The upload window did not take the file.'
      : 'No place for a file was found in the upload window.',
  };
}

/**
 * Does the form show this file under this question right now?
 *
 * The truth about an upload is the form, not the extension's memory of what
 * it sent: a window can take a file and still fail to upload it, and the user
 * can remove a file with its ✕ at any time. A site that has a document on a
 * question lists it by name there — Google Forms shows a chip reading
 * "photo.png" — so the question's own block is searched for the name.
 *
 * Found by the question's caption rather than its button, because the button
 * is often hidden once the question has its file. Read-only and
 * self-contained, like the rest of this file.
 */
export function questionShowsFile(label: string, filename: string): boolean {
  const norm = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();
  const wanted = norm(label);
  if (!wanted || !document.body) return false;
  const walker = document.createTreeWalker(document.body, 4 /* SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (norm(node.textContent ?? '') !== wanted) continue;
    let el: Element | null = node.parentElement;
    for (let depth = 0; el && depth < 12; depth += 1, el = el.parentElement) {
      if ((el.textContent ?? '').includes(filename)) return true;
      const tag = el.tagName.toLowerCase();
      // The question's own block, and no further: the next question's file is not this one's.
      if (el.getAttribute('role') === 'listitem' || tag === 'fieldset' || tag === 'li' || tag === 'form') break;
    }
  }
  return false;
}
