/**
 * Teach-mode orchestration (§ Phase 9).
 *
 * Holds the picks a user is accumulating for one tab, turns them into a
 * versioned profile, and offers the rollback. The interesting logic is in
 * `matching/teach.ts` — this is the part that has to talk to a tab.
 *
 * ## Picks are held here, not in the page
 *
 * A teach session survives the postback that a portal fires when the user
 * clicks around, and the content script does not: its memory dies with the
 * document. Keeping the picks in the worker means a user who teaches three
 * fields, triggers a re-render, and teaches two more still ends up with five.
 */

import type { Result } from '@/shared/messages';
import { envelope } from '@/shared/messages';
import type { DocConstraint, SiteProfile } from '@/shared/types';
import type { FieldKey } from '@/matching/taxonomy';
import { isFieldKey } from '@/matching/taxonomy';
import {
  buildTaughtProfile,
  profileHealth,
  type ProfileHealth,
  type TeachDocumentPick,
  type TeachPick,
} from '@/matching/teach';
import {
  findLearned,
  loadLearned,
  profileHistory,
  rollbackProfile,
  saveVersion,
  siteIdFor,
} from '@/matching/learned-profiles';
import { exportProfiles, importProfiles } from '@/matching/profile-transfer';
import { locateBySelector } from '@/matching/profile-cache';
import { harvestTab } from './harvest-service';

export interface TeachSession {
  tabId: number;
  fingerprint: string;
  url: string;
  picks: TeachPick[];
  documents: TeachDocumentPick[];
  startedAt: number;
}

const sessions = new Map<number, TeachSession>();

/** Test seam. */
export function __resetTeachForTests(): void {
  sessions.clear();
}

export function teachSession(tabId: number): TeachSession | null {
  return sessions.get(tabId) ?? null;
}

/**
 * Begin (or resume) a teach session for a tab.
 *
 * Re-harvests, because the fingerprint of the form being taught is what the
 * resulting profile is keyed by — and on a page that has drifted, the old
 * fingerprint is precisely the wrong one.
 */
export async function startTeaching(tabId: number): Promise<Result<TeachSession>> {
  const harvested = await harvestTab(tabId);
  if (!harvested.ok) return harvested;

  const existing = sessions.get(tabId);
  const session: TeachSession =
    existing && existing.fingerprint === harvested.data.fingerprint
      ? existing
      : {
          tabId,
          fingerprint: harvested.data.fingerprint,
          url: harvested.data.url,
          picks: [],
          documents: [],
          startedAt: Date.now(),
        };

  sessions.set(tabId, session);

  const response = (await chrome.tabs.sendMessage(
    tabId,
    envelope({ type: 'teach:pick-start' }),
    { frameId: 0 },
  )) as Result<null> | undefined;

  if (!response?.ok) {
    return { ok: false, error: response?.error ?? 'The page did not start the picker.' };
  }

  return { ok: true, data: session };
}

export async function stopTeaching(tabId: number): Promise<Result<null>> {
  const response = (await chrome.tabs
    .sendMessage(tabId, envelope({ type: 'teach:pick-stop' }), { frameId: 0 })
    .catch(() => undefined)) as Result<null> | undefined;
  void response;
  return { ok: true, data: null };
}

export function cancelTeaching(tabId: number): void {
  sessions.delete(tabId);
}

/**
 * Record one mapping.
 *
 * Re-teaching the same key replaces the earlier pick rather than adding a
 * second: a user who points at the wrong box and then the right one means the
 * second answer.
 */
export function recordPick(
  tabId: number,
  pick: { ref: string | null; key: string; selectors: string[]; label: string },
): Result<TeachSession> {
  const session = sessions.get(tabId);
  if (!session) return { ok: false, error: 'No teach session is open for this tab.' };
  if (!isFieldKey(pick.key)) return { ok: false, error: `"${pick.key}" is not a known field.` };
  if (pick.selectors.length === 0) {
    return { ok: false, error: 'That field has nothing stable to identify it by.' };
  }

  session.picks = [
    ...session.picks.filter((existing) => existing.key !== pick.key),
    {
      ref: pick.ref ?? '',
      key: pick.key,
      selectors: pick.selectors,
      label: pick.label,
    },
  ];

  return { ok: true, data: session };
}

export function recordDocumentPick(
  tabId: number,
  pick: { ref: string | null; key: string; selectors: string[]; label: string; constraint: DocConstraint },
): Result<TeachSession> {
  const session = sessions.get(tabId);
  if (!session) return { ok: false, error: 'No teach session is open for this tab.' };
  if (!isFieldKey(pick.key) || !pick.key.startsWith('doc.')) {
    return { ok: false, error: `"${pick.key}" is not a document field.` };
  }

  session.documents = [
    ...session.documents.filter((existing) => existing.key !== pick.key),
    {
      ref: pick.ref ?? '',
      key: pick.key as FieldKey,
      selectors: pick.selectors,
      label: pick.label,
      constraint: pick.constraint,
    },
  ];

  return { ok: true, data: session };
}

export function forgetPick(tabId: number, key: string): Result<TeachSession> {
  const session = sessions.get(tabId);
  if (!session) return { ok: false, error: 'No teach session is open for this tab.' };
  session.picks = session.picks.filter((pick) => pick.key !== key);
  session.documents = session.documents.filter((pick) => pick.key !== key);
  return { ok: true, data: session };
}

export interface SavedProfile {
  siteId: string;
  version: number;
  fields: number;
  documents: number;
}

/**
 * Write the session out as a new profile version.
 *
 * The `survives` probe is the plan's "prefers selectors that survive across
 * regenerated-ID variants", measured rather than guessed: the page is
 * re-harvested at save time, which on an ASP.NET portal is a *different render*
 * from the one the user picked on. A selector that still finds its field across
 * that boundary has demonstrated the property we want, and one that does not
 * has demonstrated the opposite.
 */
export async function saveTeaching(tabId: number): Promise<Result<SavedProfile>> {
  const session = sessions.get(tabId);
  if (!session) return { ok: false, error: 'No teach session is open for this tab.' };
  if (session.picks.length === 0 && session.documents.length === 0) {
    return { ok: false, error: 'Nothing was taught yet — point at a field first.' };
  }

  const harvested = await harvestTab(tabId);
  if (!harvested.ok) return harvested;
  const harvest = harvested.data;

  const survives = (selector: string): boolean =>
    locateBySelector([selector], harvest.fields) !== null;

  const previous = await findLearned(session.fingerprint).catch(() => null);
  const submit = harvest.frames.find((frame) => frame.frameId === 0)?.submit ?? null;

  const profile = buildTaughtProfile({
    siteId: siteIdFor(session.url, harvest.fingerprint),
    url: session.url,
    fingerprint: harvest.fingerprint,
    picks: session.picks,
    documents: session.documents,
    previous,
    submit: submit ? { selectors: [submit.selector], label: submit.label } : null,
    survives,
  });

  await saveVersion(profile);
  sessions.delete(tabId);

  return {
    ok: true,
    data: {
      siteId: profile.siteId,
      version: profile.version,
      fields: profile.fields.length,
      documents: profile.documents.length,
    },
  };
}

// ---------------------------------------------------------------------------
// History and repair
// ---------------------------------------------------------------------------

export interface ProfileVersionSummary {
  version: number;
  lastVerifiedAt: string;
  fields: number;
  taught: number;
}

export async function versionsFor(fingerprint: string): Promise<ProfileVersionSummary[]> {
  return (await profileHistory(fingerprint)).map(summarise);
}

function summarise(profile: SiteProfile): ProfileVersionSummary {
  return {
    version: profile.version,
    lastVerifiedAt: profile.lastVerifiedAt,
    fields: profile.fields.length,
    taught: profile.fields.filter((field) => field.source === 'taught').length,
  };
}

export async function rollback(fingerprint: string): Promise<Result<ProfileVersionSummary | null>> {
  const restored = await rollbackProfile(fingerprint);
  if (!restored) {
    return { ok: false, error: 'There is no earlier version to go back to.' };
  }
  return { ok: true, data: summarise(restored) };
}

/**
 * Share what this device has learned (§ Phase 9 Should).
 *
 * Bundled profiles are excluded — they ship with the extension, so re-sharing
 * them is noise.
 */
export async function exportLearned(): Promise<string> {
  return exportProfiles(await loadLearned());
}

/**
 * Take in a bundle from somewhere else.
 *
 * `importProfiles` has already stripped it to selectors and keys and demoted
 * every mapping out of `taught` — see the note at the top of that file about
 * what an imported profile is being trusted to do. Each surviving profile is
 * stored as its own version, so an import is as undoable as a teach.
 */
export async function importLearned(text: string): Promise<Result<{ imported: number; rejected: string[] }>> {
  const outcome = importProfiles(text);
  for (const profile of outcome.profiles) {
    await saveVersion(profile);
  }
  return { ok: true, data: { imported: outcome.profiles.length, rejected: outcome.rejected } };
}

/** Health of the profile for a tab's current form, for the repair prompt. */
export async function healthFor(tabId: number): Promise<Result<ProfileHealth | null>> {
  const harvested = await harvestTab(tabId);
  if (!harvested.ok) return harvested;

  const profile = await findLearned(harvested.data.fingerprint).catch(() => null);
  if (!profile) return { ok: true, data: null };

  return {
    ok: true,
    data: profileHealth(profile, (selectors) =>
      locateBySelector(selectors, harvested.data.fields) !== null,
    ),
  };
}
