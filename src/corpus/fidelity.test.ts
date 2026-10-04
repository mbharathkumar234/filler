// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { harvest } from '@/content/harvester';
import { matchForm } from '@/matching/deterministic';
import { openSnapshot } from './open';
import { snapshotHtml } from './snapshot';

/**
 * A snapshot changes nothing the matcher reads (U0.M1, `MASTER_PROMPT.md`).
 *
 * Every form already in `fixtures/` is loaded, captured, and loaded again from
 * its snapshot. The harvester must find the same fields with the same labels,
 * and the matcher must give the same answers at the same confidence. If the
 * cleaner ever drops something the product reads, the corpus would measure a
 * different product, and this fails.
 */

const PAGES = import.meta.glob(['../../fixtures/bench/*.html', '../../fixtures/heldout-*/*.html', '../../fixtures/*-portal/*.html'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** What the product sees on the page in `document` now. */
function seen() {
  const { fields } = harvest(document);
  const matches = matchForm(fields);
  return fields.map((field, index) => ({
    label: field.labelText,
    nearby: field.nearbyText,
    tag: field.tag,
    type: field.type,
    options: field.options?.map((option) => `${option.value}=${option.text}`),
    key: matches[index]!.key,
    confidence: matches[index]!.confidence,
  }));
}

/** The page as a browser would leave it, its own scripts run. */
function load(html: string): void {
  document.documentElement.innerHTML = /<html[^>]*>([\s\S]*)<\/html>/i.exec(html)?.[1] ?? html;
  for (const script of Array.from(document.querySelectorAll('script'))) {
    if (!script.textContent) continue;
    const replacement = document.createElement('script');
    replacement.textContent = script.textContent;
    script.replaceWith(replacement);
  }
}

describe('a snapshot shows the matcher what the page did', () => {
  const pages = Object.entries(PAGES).sort(([a], [b]) => a.localeCompare(b));

  it('has forms to check', () => {
    expect(pages.length).toBeGreaterThanOrEqual(15);
  });

  it.each(pages.map(([path, html]) => [path.split('/').slice(-2).join('/'), html]))('%s', (_, html) => {
    load(html);
    const before = seen();
    const snapshot = snapshotHtml(document, {
      category: 'everyday',
      stack: 'fixture',
      capturedAt: '2026-10-04',
      origin: 'http://localhost',
      needsLogin: false,
    });

    openSnapshot(document, snapshot);
    expect(document.querySelectorAll('script')).toHaveLength(0);
    expect(seen()).toEqual(before);
  });
});
