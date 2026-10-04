/**
 * Open a corpus snapshot in a document that is not a browser's own page load —
 * jsdom, in the tests and the bench.
 *
 * A browser opening a snapshot file builds each component's shadow root from
 * its `<template shadowrootmode>`; setting `innerHTML` does not, and jsdom
 * never does. This does it by hand, so a field inside a component is where the
 * harvester looks for it.
 */

function attachShadows(root: Document | ShadowRoot): void {
  for (const template of Array.from(root.querySelectorAll('template[shadowrootmode]'))) {
    const host = template.parentElement;
    if (host === null || host.shadowRoot !== null) continue;
    const mode = template.getAttribute('shadowrootmode') === 'closed' ? 'closed' : 'open';
    const shadow = host.attachShadow({ mode });
    shadow.append(...Array.from((template as HTMLTemplateElement).content.childNodes));
    template.remove();
    attachShadows(shadow);
  }
}

/** Replace `document`'s contents with the snapshot's, its components' fields in place. */
export function openSnapshot(document: Document, html: string): void {
  document.documentElement.innerHTML = /<html[^>]*>([\s\S]*)<\/html>/i.exec(html)?.[1] ?? html;
  attachShadows(document);
}
