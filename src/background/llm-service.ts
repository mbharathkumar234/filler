/**
 * LLM orchestration (§ Phase 8).
 *
 * The order of operations *is* the privacy design, so it is worth reading as
 * a list before reading it as code:
 *
 *  1. Nothing unmapped → do not call. The rules already won.
 *  2. A learned profile exists for this form → do not call. That is the plan's
 *     "once per form, ever".
 *  3. Vault locked → do not call. The denylist comes from the vault, and
 *     without it there is no way to check that the page is not echoing the
 *     user's own name back at the model. Fail closed.
 *  4. No API key → do not call.
 *  5. Redact (structure and syntax) → guard (the user's own values) → and only
 *     then send.
 *  6. Merge underneath the rules, cap the confidence, learn the answer.
 *
 * Every "do not call" returns a notice rather than an error. The plan asks for
 * graceful degradation and it is also the only sane behaviour for something
 * people use on a deadline: the rules still work, and the user is told why the
 * model did not run.
 *
 * This module *is* allowed to touch the vault — it is the one that computes the
 * denylist. `redaction.ts` and `llm-client.ts` are not, and the lint rule keeps
 * them that way.
 */

import type { FieldDescriptor, MatchResult, SiteProfile } from '@/shared/types';
import { FIELD_KEYS } from '@/matching/taxonomy';
import {
  LlmResponseInvalid,
  mergeSuggestions,
  parseSuggestions,
  unmappedRefs,
  type LlmSuggestion,
} from '@/matching/llm-matcher';
import { findLearned, learnedProfileFrom, loadLearned, saveLearned } from '@/matching/learned-profiles';
import { getAllFields } from '@/vault/profile-store';
import { openVaultDb } from '@/vault/db';
import {
  API_KEY_SETTING,
  deleteSetting,
  getSetting,
  hasSetting,
  MODEL_SETTING,
  putSetting,
} from '@/vault/settings-store';
import { isUnlocked, withKey } from '@/vault/session';
import { redactFields } from './redaction';
import { denyListFrom, guardPayload } from './value-guard';
import {
  askModel,
  DEFAULT_MODEL,
  FAILURE_TEXT,
  LlmUnavailable,
  type LlmUsage,
  type Transport,
} from './llm-client';

export interface LlmOutcome {
  results: MatchResult[];
  /** Did we actually call the model? */
  called: boolean;
  /** Shown in the panel when the model did not run, or ran and failed. */
  notice?: string;
  usage?: LlmUsage;
  /** A profile was written, so this form will not need the model again. */
  learned?: string;
  /** How many values the guard removed before sending. */
  redacted?: number;
}

export interface EnrichOptions {
  url: string;
  fingerprint: string;
  submit?: { selectors: string[]; label: string } | null;
  /** Injected in tests; real runs use `fetch`. */
  transport?: Transport;
  /** Injected in tests, so the vault is not needed to exercise the flow. */
  overrides?: {
    apiKey?: string | null;
    denyList?: string[];
    unlocked?: boolean;
    learned?: SiteProfile | null;
  };
}

/**
 * Ask the model about the fields the rules could not place.
 *
 * Never throws: every failure becomes a notice attached to the unchanged
 * deterministic results.
 */
export async function enrichWithLlm(
  fields: readonly FieldDescriptor[],
  deterministic: readonly MatchResult[],
  options: EnrichOptions,
): Promise<LlmOutcome> {
  const results = [...deterministic];
  const unmapped = unmappedRefs(results);
  if (unmapped.length === 0) return { results, called: false };

  // 2. Already learned? The plan's "once per form, ever".
  const learned =
    options.overrides?.learned !== undefined
      ? options.overrides.learned
      : await findLearned(options.fingerprint).catch(() => null);
  if (learned) {
    return {
      results,
      called: false,
      notice: 'This form was learned earlier, so the model was not called again.',
    };
  }

  // 3. Locked vault: no denylist, so no send.
  const unlocked = options.overrides?.unlocked ?? isUnlocked();
  if (!unlocked) {
    return {
      results,
      called: false,
      notice: 'Unlock your vault to let the model help with the fields the rules could not place.',
    };
  }

  // 4. No key.
  const apiKey =
    options.overrides?.apiKey !== undefined ? options.overrides.apiKey : await readApiKey();
  if (apiKey === null || apiKey.trim() === '') {
    return { results, called: false, notice: FAILURE_TEXT['no-key'] };
  }

  // 5. Redact, then guard.
  const targets = fields.filter((field) => unmapped.includes(field.ref));
  const redaction = redactFields(targets);
  const denyList = options.overrides?.denyList ?? (await readDenyList());
  const guard = guardPayload(redaction.fields, denyList);

  if (!guard.payload) {
    return { results, called: false, notice: guard.refused ?? FAILURE_TEXT.refused };
  }
  if (guard.payload.fields.length === 0) {
    return { results, called: false };
  }

  const model = (await readModel()) ?? undefined;

  // 6. Call, with the plan's single retry on a malformed reply.
  let suggestions: LlmSuggestion[];
  let usage: LlmUsage;
  const allowedRefs = new Set(guard.payload.fields.map((field) => field.ref));

  try {
    const first = await askModel(
      guard.payload,
      FIELD_KEYS,
      { apiKey, ...(model === undefined ? {} : { model }) },
      options.transport,
    );
    usage = first.usage;

    try {
      suggestions = parseSuggestions(first.text, allowedRefs);
    } catch (error) {
      if (!(error instanceof LlmResponseInvalid || error instanceof SyntaxError)) throw error;

      // One retry, then give up. A second malformed reply is a model that is
      // not going to produce JSON today, and burning more calls on it costs
      // the user money for nothing.
      const second = await askModel(
        guard.payload,
        FIELD_KEYS,
        { apiKey, ...(model === undefined ? {} : { model }) },
        options.transport,
      );
      usage = {
        inputTokens: usage.inputTokens + second.usage.inputTokens,
        outputTokens: usage.outputTokens + second.usage.outputTokens,
      };
      suggestions = parseSuggestions(second.text, allowedRefs);
    }
  } catch (error) {
    const notice =
      error instanceof LlmUnavailable
        ? error.message
        : error instanceof LlmResponseInvalid || error instanceof SyntaxError
          ? FAILURE_TEXT['bad-response']
          : FAILURE_TEXT.offline;
    return { results, called: true, notice, ...(guard.removed ? { redacted: guard.removed } : {}) };
  }

  const merged = mergeSuggestions(results, suggestions);

  // 7. Learn it, so this form never needs the model again.
  let learnedId: string | undefined;
  const profile = learnedProfileFrom({
    url: options.url,
    fingerprint: options.fingerprint,
    fields,
    results: merged,
    submit: options.submit ?? null,
  });
  if (profile) {
    await saveLearned(profile).catch(() => {
      // A profile we failed to store costs one extra call next time. It is
      // not worth failing the match over.
    });
    learnedId = profile.siteId;
  }

  return {
    results: merged,
    called: true,
    usage,
    ...(learnedId === undefined ? {} : { learned: learnedId }),
    ...(guard.removed ? { redacted: guard.removed } : {}),
  };
}

// ---------------------------------------------------------------------------
// Vault reads — the reason this module exists rather than living in the client
// ---------------------------------------------------------------------------

async function readApiKey(): Promise<string | null> {
  try {
    return await withKey((db, key) => getSetting(db, key, API_KEY_SETTING));
  } catch {
    return null;
  }
}

async function readModel(): Promise<string | null> {
  try {
    return await withKey((db, key) => getSetting(db, key, MODEL_SETTING));
  } catch {
    return null;
  }
}

/**
 * The user's own values, as needles for the guard.
 *
 * Read here and handed to `value-guard.ts` as opaque strings. They are used
 * only for `replace`, never copied into a payload, and the guard re-checks
 * afterwards and refuses if any survived.
 */
async function readDenyList(): Promise<string[]> {
  try {
    const entries = await withKey(async (db, key) => getAllFields(db, key));
    return denyListFrom(entries.map((entry) => ({ key: entry.key as string, value: entry.value })));
  } catch {
    // No vault, no denylist. The caller has already checked `isUnlocked`, so
    // reaching here means something is wrong — return nothing, which makes the
    // guard a no-op and the *page's* own scrubbing the only defence. That is
    // weaker than intended, so it is treated as a refusal below.
    return [];
  }
}

// ---------------------------------------------------------------------------
// Settings, for the panel
// ---------------------------------------------------------------------------

export interface LlmStatus {
  /** Is a key stored? Answered without decrypting it. */
  hasKey: boolean;
  unlocked: boolean;
  model: string | null;
  learnedCount: number;
  usage: { calls: number; inputTokens: number; outputTokens: number };
  /** Estimated spend so far, USD. Null when the model's price is not known. */
  estimatedCost: number | null;
}

export const USAGE_KEY = 'llm:usage';

/**
 * Price per million tokens, USD (verified against the model overview docs).
 *
 * Hard-coded and therefore capable of going stale, which is why the panel says
 * "estimate". The alternative — fetching a price list — would mean a second
 * network call from a module whose whole purpose is to have exactly one, so
 * the honest label is the better trade.
 */
export const PRICING: Readonly<Record<string, { input: number; output: number }>> = Object.freeze({
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-fable-5': { input: 10, output: 50 },
});

/** Estimated cost in USD for a token count. Returns null for an unknown model. */
export function estimateCost(
  usage: { inputTokens: number; outputTokens: number },
  model: string = DEFAULT_MODEL,
): number | null {
  const price = PRICING[model];
  if (!price) return null;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}

export interface UsageRecord {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

const EMPTY_USAGE: UsageRecord = { calls: 0, inputTokens: 0, outputTokens: 0 };

/**
 * The token meter (§ Phase 8 Should).
 *
 * Counts, not content. It exists so a user can see what this feature costs
 * them before a bill does.
 */
export async function recordUsage(usage: LlmUsage): Promise<UsageRecord> {
  const area = localArea();
  const stored = (await area.get(USAGE_KEY))[USAGE_KEY];
  const previous = isUsage(stored) ? stored : EMPTY_USAGE;

  const next: UsageRecord = {
    calls: previous.calls + 1,
    inputTokens: previous.inputTokens + usage.inputTokens,
    outputTokens: previous.outputTokens + usage.outputTokens,
  };
  await area.set({ [USAGE_KEY]: next });
  return next;
}

export async function readUsage(): Promise<UsageRecord> {
  const stored = (await localArea().get(USAGE_KEY))[USAGE_KEY];
  return isUsage(stored) ? stored : { ...EMPTY_USAGE };
}

export async function resetUsage(): Promise<void> {
  await localArea().remove(USAGE_KEY);
}

function isUsage(value: unknown): value is UsageRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<UsageRecord>;
  return (
    typeof record.calls === 'number' &&
    typeof record.inputTokens === 'number' &&
    typeof record.outputTokens === 'number'
  );
}

interface LocalArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

let localOverride: LocalArea | null = null;

/** Test seam. */
export function setUsageStorage(area: LocalArea | null): void {
  localOverride = area;
}

function localArea(): LocalArea {
  if (localOverride) return localOverride;
  const local = (globalThis as { chrome?: { storage?: { local?: LocalArea } } }).chrome?.storage
    ?.local;
  if (!local) throw new Error('chrome.storage.local is unavailable.');
  return local;
}

/** Store or clear a sealed setting. Requires an unlocked vault. */
async function writeSetting(name: string, value: string | null): Promise<void> {
  await withKey(async (db, cryptoKey) => {
    if (value === null || value.trim() === '') await deleteSetting(db, name);
    else await putSetting(db, cryptoKey, name, value.trim());
  });
}

export function setApiKey(key: string | null): Promise<void> {
  return writeSetting(API_KEY_SETTING, key);
}

export function setModel(model: string | null): Promise<void> {
  return writeSetting(MODEL_SETTING, model);
}

/** Everything the settings panel needs. Never the key itself. */
export async function llmStatus(): Promise<LlmStatus> {
  const unlocked = isUnlocked();
  const usage = await readUsage();
  const learnedCount = (await loadLearned().catch(() => [])).length;

  if (!unlocked) {
    return {
      hasKey: false,
      unlocked,
      model: null,
      learnedCount,
      usage,
      estimatedCost: estimateCost(usage),
    };
  }

  const db = await openVaultDb();
  const model = await readModel();
  return {
    hasKey: await hasSetting(db, API_KEY_SETTING),
    unlocked,
    model,
    learnedCount,
    usage,
    estimatedCost: estimateCost(usage, model ?? DEFAULT_MODEL),
  };
}
