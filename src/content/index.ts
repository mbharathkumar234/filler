/**
 * Content script entry (§ Phase 3).
 *
 * Injected on an explicit user gesture via `chrome.scripting.executeScript`,
 * never declared in the manifest — a declared content script auto-injects into
 * every matching page, which is exactly the broad `<all_urls>` behaviour the
 * plan forbids and the store reviews for.
 *
 * Phase 3 scope: harvest and report. It writes nothing to the page.
 */

import { harvest, type HarvestResult } from './harvester';
import { fingerprintForm } from '@/runtime/plan';
import { envelope, isEnvelope, type ExtensionRequest } from '@/shared/messages';
import type { FieldDescriptor } from '@/shared/types';

/** Latest harvest, kept so later phases can resolve a ref back to an element. */
let current: HarvestResult | null = null;

export interface HarvestReport {
  url: string;
  title: string;
  fingerprint: string;
  fields: FieldDescriptor[];
  blockers: HarvestResult['blockers'];
  wizard: HarvestResult['wizard'];
  labelSources: Record<string, string>;
  /** Fields visible on screen — the denominator for the ≥95% label bar. */
  visibleCount: number;
  labelledCount: number;
}

function formAction(): string | null {
  const form = document.querySelector('form');
  return form?.getAttribute('action') ?? null;
}

function identifiers(result: HarvestResult): string[] {
  return [...result.elements.values()].map(
    (el) => el.getAttribute('name') ?? el.getAttribute('id') ?? '',
  );
}

export async function runHarvest(): Promise<HarvestReport> {
  current = harvest(document, { shadowDom: true, frameId: 0 });

  const visible = current.fields.filter((f) => f.visible);
  const fingerprint = await fingerprintForm({
    url: location.href,
    formAction: formAction(),
    fields: current.fields,
    identifiers: identifiers(current),
    step: current.wizard?.step ?? null,
  });

  return {
    url: location.href,
    title: document.title,
    fingerprint,
    fields: current.fields,
    blockers: current.blockers,
    wizard: current.wizard,
    labelSources: Object.fromEntries(current.labelSources),
    visibleCount: visible.length,
    labelledCount: visible.filter((f) => f.labelText.trim() !== '').length,
  };
}

/** Resolve a descriptor ref back to its live element. Used from Phase 5 on. */
export function elementFor(ref: string): Element | undefined {
  return current?.elements.get(ref);
}

// The script is injected repeatedly across a session; only wire listeners once.
declare global {
  interface Window {
    __autofillContentReady?: boolean;
  }
}

if (!window.__autofillContentReady) {
  window.__autofillContentReady = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isEnvelope(message)) return false;
    // Only the extension's own worker may drive the content script.
    if (sender.id !== chrome.runtime.id) return false;

    const request = message.payload as ExtensionRequest;
    if (request.type !== 'harvest:request') return false;

    runHarvest().then(
      (report) => sendResponse({ ok: true, data: report }),
      (error: unknown) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'Harvest failed.',
        }),
    );
    return true;
  });

  // Announce readiness so the worker need not race the injection.
  void chrome.runtime.sendMessage(envelope({ type: 'harvest:ready' })).catch(() => {
    // The panel may not be open. Nothing to do.
  });
}
