/**
 * LLM response validation and merging (§ Phase 8).
 *
 * The model is a *suggestion engine with no authority*. Everything it says
 * passes through this file, and this file assumes it is wrong:
 *
 *  - a key outside the taxonomy is discarded, not added;
 *  - a ref it invented is discarded;
 *  - a confidence it claims is clamped, never believed;
 *  - a field the rules already matched keeps the rule's answer.
 *
 * Pure, and deliberately in `matching/` rather than `background/`: it holds no
 * network code and needs no browser, so the interesting question — what do we
 * do when the model lies to us — is answerable in a unit test.
 */

import { CONFIDENCE, type MatchResult } from '@/shared/types';
import { isFieldKey, sensitivityOf, UNKNOWN_KEY, type FieldKey } from './taxonomy';

export interface LlmSuggestion {
  ref: string;
  key: FieldKey | typeof UNKNOWN_KEY;
  confidence: number;
  why: string;
}

/**
 * A high-sensitivity key suggested by the model is capped below the fill
 * threshold, so it is *surfaced and not written*.
 *
 * The plan says an LLM guess "never auto-fills a `sensitivity: 'high'` field
 * without user confirmation". The `LLM_CEILING` of 0.8 already keeps every
 * model suggestion out of the auto-fill band, but for an Aadhaar or a bank
 * account that is not enough: fill-and-flag still *writes the value first* and
 * asks afterwards. Below `FILL_AND_FLAG` the field is left blank and appears on
 * the review screen as a suggestion the user can accept — which is what
 * "without user confirmation" has to mean for a number that is difficult to
 * unsend.
 */
export const HIGH_SENSITIVITY_LLM_CEILING = 0.45;

/** Rationales are shown on the review screen; the prompt asks for 12 words. */
const MAX_WHY_WORDS = 12;

export class LlmResponseInvalid extends Error {
  override readonly name = 'LlmResponseInvalid';
}

/**
 * Parse the model's reply.
 *
 * Throws `LlmResponseInvalid` for anything that is not a JSON array, so the
 * caller can do the plan's "one retry, then fall back to unknown". Individual
 * bad *entries* are dropped rather than thrown on — one malformed row should
 * not discard nineteen good ones.
 */
export function parseSuggestions(
  text: string,
  allowedRefs: ReadonlySet<string>,
): LlmSuggestion[] {
  const parsed = JSON.parse(stripFences(text)) as unknown;

  if (!Array.isArray(parsed)) {
    throw new LlmResponseInvalid('The model did not return a JSON array.');
  }

  const seen = new Set<string>();
  const suggestions: LlmSuggestion[] = [];

  for (const entry of parsed) {
    const suggestion = validate(entry, allowedRefs);
    if (!suggestion) continue;
    // First answer wins: a model that names the same field twice has
    // contradicted itself, and picking the later one is not more principled
    // than picking the earlier one — but silently keeping both would be worse.
    if (seen.has(suggestion.ref)) continue;
    seen.add(suggestion.ref);
    suggestions.push(suggestion);
  }

  return suggestions;
}

/**
 * Strip a markdown fence.
 *
 * The prompt says "Return ONLY a JSON array" and models mostly comply, but
 * ```json fencing is the single most common deviation and refusing over it
 * would burn a retry on a response that is perfectly good underneath.
 */
function stripFences(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced?.[1] ?? text).trim();

  // A model that adds a sentence before the array: take the array.
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return body;
  return body.slice(start, end + 1);
}

function validate(entry: unknown, allowedRefs: ReadonlySet<string>): LlmSuggestion | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const record = entry as { ref?: unknown; key?: unknown; confidence?: unknown; why?: unknown };

  // A ref we did not send is a ref the model invented.
  if (typeof record.ref !== 'string' || !allowedRefs.has(record.ref)) return null;
  if (typeof record.key !== 'string') return null;

  // The closed vocabulary, enforced. A model that ignores the instruction
  // cannot widen the taxonomy — its invention is simply dropped.
  if (record.key !== UNKNOWN_KEY && !isFieldKey(record.key)) return null;

  const key = record.key === UNKNOWN_KEY ? UNKNOWN_KEY : (record.key as FieldKey);

  return {
    ref: record.ref,
    key,
    confidence: clamp(record.confidence, key),
    why: trimWhy(typeof record.why === 'string' ? record.why : ''),
  };
}

/**
 * Clamp a claimed confidence into the band an LLM answer is allowed to occupy.
 *
 * Not a rescale — a *ceiling*. A model claiming 0.99 is claiming more than the
 * plan permits it to claim, and the correct response is to disbelieve the
 * excess rather than to trust the ordering underneath it.
 */
export function clamp(value: unknown, key: FieldKey | typeof UNKNOWN_KEY): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const bounded = Math.min(Math.max(raw, 0), CONFIDENCE.LLM_CEILING);

  if (key !== UNKNOWN_KEY && sensitivityOf(key) === 'high') {
    return Math.min(bounded, HIGH_SENSITIVITY_LLM_CEILING);
  }
  return bounded;
}

function trimWhy(why: string): string {
  const words = why.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'Suggested by the language model.';
  return words.slice(0, MAX_WHY_WORDS).join(' ');
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/**
 * Fold suggestions in *underneath* the deterministic results.
 *
 * "Rules always win ties" is implemented as the stronger and simpler rule:
 * **rules always win.** A suggestion is used only where the deterministic
 * matcher returned `unknown`. Comparing confidences across the two would mean
 * trusting a number the model made up about itself against one our own scoring
 * table produced, and those are not the same kind of quantity.
 */
export function mergeSuggestions(
  deterministic: readonly MatchResult[],
  suggestions: readonly LlmSuggestion[],
): MatchResult[] {
  const byRef = new Map(suggestions.map((s) => [s.ref, s]));

  return deterministic.map((result) => {
    if (result.key !== UNKNOWN_KEY) return result;

    const suggestion = byRef.get(result.fieldRef);
    if (!suggestion || suggestion.key === UNKNOWN_KEY || suggestion.confidence <= 0) {
      return result;
    }

    return {
      fieldRef: result.fieldRef,
      key: suggestion.key,
      confidence: suggestion.confidence,
      rationale: suggestion.why,
      source: 'llm',
    };
  });
}

/** Which refs are still unmapped after the rules have run? */
export function unmappedRefs(results: readonly MatchResult[]): string[] {
  return results.filter((result) => result.key === UNKNOWN_KEY).map((result) => result.fieldRef);
}
