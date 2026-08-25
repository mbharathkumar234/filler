/**
 * Harvest orchestration (§ Phase 3).
 *
 * Injects the content script **on an explicit user gesture only** and collects
 * the result. `activeTab` grants access to the current tab at the moment the
 * user clicks our action — it expires on navigation, which is precisely the
 * scope P1 wants and the smallest thing the store has to justify.
 */

import type { Result } from '@/shared/messages';
import { envelope } from '@/shared/messages';
import type { HarvestReport } from '@/content/index';

/** Built by Vite as a separate entry; see vite.config.ts rollupOptions. */
const CONTENT_SCRIPT = 'content.js';

export interface FrameReport extends HarvestReport {
  frameId: number;
}

export interface TabHarvest {
  tabId: number;
  url: string;
  title: string;
  frames: FrameReport[];
  /** Flattened across frames, with frameId stamped on each descriptor. */
  fields: HarvestReport['fields'];
  blockers: HarvestReport['blockers'];
  wizard: HarvestReport['wizard'];
  fingerprint: string;
  visibleCount: number;
  labelledCount: number;
}

/**
 * Inject into the tab and harvest every same-origin frame.
 *
 * `allFrames: true` reaches same-origin iframes, which the plan requires;
 * cross-origin ones cannot be injected at all under `activeTab` and surface as
 * blockers from the top frame's own scan instead.
 */
export async function harvestTab(tabId: number): Promise<Result<TabHarvest>> {
  let injected: chrome.scripting.InjectionResult<unknown>[];
  try {
    injected = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [CONTENT_SCRIPT],
    });
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error && /cannot be scripted|Cannot access/i.test(error.message)
          ? 'This page cannot be read — Chrome blocks extensions on it (a store page, a PDF viewer, or a settings page).'
          : `Could not read this page: ${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }

  const frames: FrameReport[] = [];
  for (const injection of injected) {
    const report = await requestHarvest(tabId, injection.frameId);
    if (report) frames.push({ ...report, frameId: injection.frameId });
  }

  if (frames.length === 0) {
    return { ok: false, error: 'No readable frame responded on this page.' };
  }

  const top = frames.find((f) => f.frameId === 0) ?? frames[0]!;

  // Stamp frameId onto each descriptor so Phase 5 knows where to write.
  const fields = frames.flatMap((frame) =>
    frame.fields.map((field) => ({ ...field, frameId: frame.frameId })),
  );

  const tab = await chrome.tabs.get(tabId).catch(() => null);

  return {
    ok: true,
    data: {
      tabId,
      url: tab?.url ?? top.url,
      title: tab?.title ?? top.title,
      frames,
      fields,
      blockers: frames.flatMap((f) => f.blockers),
      wizard: top.wizard,
      fingerprint: top.fingerprint,
      visibleCount: frames.reduce((sum, f) => sum + f.visibleCount, 0),
      labelledCount: frames.reduce((sum, f) => sum + f.labelledCount, 0),
    },
  };
}

async function requestHarvest(tabId: number, frameId: number): Promise<HarvestReport | null> {
  try {
    const response = (await chrome.tabs.sendMessage(
      tabId,
      envelope({ type: 'harvest:request' }),
      { frameId },
    )) as Result<HarvestReport> | undefined;

    return response?.ok ? response.data : null;
  } catch {
    // A frame that does not answer is not an error: about:blank frames and
    // ad iframes routinely have no listener.
    return null;
  }
}
