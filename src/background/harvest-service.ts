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
import type { MatchResult } from '@/shared/types';
import { bundledProfiles, locateBySelector } from '@/matching/profile-cache';
import { profileHealth, type ProfileHealth } from '@/matching/teach';
import { loadLearned } from '@/matching/learned-profiles';
import { matchFormWithContext } from '@/matching';
import { enrichWithLlm, recordUsage } from './llm-service';

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
  /** Phase 4: what each field maps to, profile first then rules. */
  matches: MatchResult[];
  /** Site profile used, when one applied and was not stale. */
  profileUsed: { siteId: string; version: number; resolveRate: number } | null;
  /** Set when a profile applied but too few selectors resolved (§Phase 9). */
  profileStale: { siteId: string; version: number; resolveRate: number } | null;
  /** A "same as permanent address" control, for Phase 5. */
  sameAsPermanent: string | null;
  /** § Phase 8: why the model did or did not run. Null when it was not needed. */
  llmNotice: string | null;
  /** True when a suggestion from the model is in `matches`. */
  llmUsed: boolean;
  /** § Phase 9: how much of the applicable profile still resolves, if any. */
  profileHealth: ProfileHealth | null;
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
  const url = tab?.url ?? top.url;

  // Matching runs in the worker, not the page: the rules and the synonym
  // dictionary are ours, and a hostile page must not get to observe them.
  // Learned profiles sit alongside the bundled ones: a form the model mapped
  // once is matched by profile from then on, which is what makes the plan's
  // "once per form, ever" true rather than aspirational.
  const learned = await loadLearned().catch(() => []);

  // § Phase 9: a profile's selectors are checked against what was actually
  // harvested. Until this phase that check was `() => true`, which meant the
  // staleness threshold could never fire and a half-broken profile would be
  // used to fill a form — the exact outcome §Phase 9 exists to prevent.
  const resolvesOnPage = (selectors: string[]): boolean =>
    locateBySelector(selectors, fields) !== null;

  const profiles = [...bundledProfiles(), ...learned];
  const matched = matchFormWithContext(fields, {
    url,
    fingerprint: top.fingerprint,
    profiles,
    resolve: resolvesOnPage,
  });

  // Health of whichever profile applied, stale or not — the panel needs to be
  // able to say "9 of 20 selectors still work" and name the broken keys.
  const applicable = matched.profile?.profile ?? matched.staleProfile?.profile ?? null;
  const health = applicable ? profileHealth(applicable, resolvesOnPage) : null;

  // § Phase 8 — the LLM sees only what the rules could not place, and only
  // after redaction and the value guard. It never throws: a failure comes back
  // as a notice with the deterministic results untouched.
  const enriched = await enrichWithLlm(fields, matched.results, {
    url,
    fingerprint: top.fingerprint,
    submit: top.submit ? { selectors: [top.submit.selector], label: top.submit.label } : null,
  });
  if (enriched.usage) {
    await recordUsage(enriched.usage).catch(() => {
      // A meter that fails to write must not fail the match.
    });
  }

  return {
    ok: true,
    data: {
      tabId,
      url,
      title: tab?.title ?? top.title,
      frames,
      fields,
      blockers: frames.flatMap((f) => f.blockers),
      wizard: top.wizard,
      fingerprint: top.fingerprint,
      visibleCount: frames.reduce((sum, f) => sum + f.visibleCount, 0),
      labelledCount: frames.reduce((sum, f) => sum + f.labelledCount, 0),
      matches: enriched.results,
      profileUsed: matched.profile
        ? {
            siteId: matched.profile.profile.siteId,
            version: matched.profile.profile.version,
            resolveRate: matched.profile.resolveRate,
          }
        : null,
      profileStale: matched.staleProfile
        ? {
            siteId: matched.staleProfile.profile.siteId,
            version: matched.staleProfile.profile.version,
            resolveRate: matched.staleProfile.resolveRate,
          }
        : null,
      sameAsPermanent: matched.sameAsPermanent,
      llmNotice: enriched.notice ?? null,
      llmUsed: enriched.called && enriched.results.some((r) => r.source === 'llm'),
      profileHealth: health,
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
