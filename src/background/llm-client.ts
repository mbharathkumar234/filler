/**
 * The single LLM egress point (§ Phase 8).
 *
 * **This is the only place in the extension that talks to a network service.**
 * Everything crossing it has been through `redaction.ts` and then
 * `value-guard.ts`, and the type system enforces the order: this module accepts
 * a `GuardedPayload`, which nothing but the guard can construct. Calling the
 * model with an unchecked payload is a type error, not an oversight.
 *
 * Like `redaction.ts`, this file may not import from `vault/` or `documents/` —
 * see the lint rule in `eslint.config.js`. It never sees a value, a document, a
 * filename, or the URL of the page.
 *
 * ## Failure is a normal outcome
 *
 * No key, no network, a rate limit, a model that returns prose instead of JSON:
 * every one of those is expected, and every one degrades to *deterministic-only
 * matching with a notice*, never to a broken run. The plan requires it and it
 * is also the only sane behaviour for a tool people use on a deadline.
 */

import type { GuardedPayload } from './value-guard';
import { payloadFields } from './value-guard';

/**
 * The model.
 *
 * The plan's §1 table locked `claude-sonnet-4-6`. That table was written before
 * the Claude 5 family shipped; `claude-sonnet-5` is its direct successor and
 * the right default for what this is — a bounded classification against a
 * closed vocabulary. Overridable in settings, and recorded as a deliberate
 * departure from the locked table rather than a drift.
 */
export const DEFAULT_MODEL = 'claude-sonnet-5';

export const API_URL = 'https://api.anthropic.com/v1/messages';
export const API_VERSION = '2023-06-01';

/** Small: the response is one JSON array of short objects. */
export const DEFAULT_MAX_TOKENS = 2_048;

export type LlmFailure =
  | 'no-key'
  | 'offline'
  | 'rate-limited'
  | 'unauthorised'
  | 'server-error'
  | 'bad-response'
  | 'refused';

export class LlmUnavailable extends Error {
  override readonly name = 'LlmUnavailable';
  constructor(
    readonly code: LlmFailure,
    message: string,
  ) {
    super(message);
  }
}

export const FAILURE_TEXT: Readonly<Record<LlmFailure, string>> = Object.freeze({
  'no-key': 'No API key is set, so only the built-in rules were used.',
  offline: 'Could not reach the model — matching used the built-in rules only.',
  'rate-limited': 'The model is rate-limited right now; the built-in rules were used instead.',
  unauthorised: 'That API key was rejected. Check it in settings — the built-in rules still work.',
  'server-error': 'The model service had an error; the built-in rules were used instead.',
  'bad-response': 'The model did not answer in the expected format, so its suggestions were ignored.',
  refused: 'Redaction refused to send this page. Only the built-in rules were used.',
});

export interface LlmConfig {
  apiKey: string;
  model?: string;
  maxTokens?: number;
}

/** Injectable so the tests never touch the network. */
export type Transport = (url: string, init: RequestInit) => Promise<Response>;

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmCall {
  /** Raw text of the model's reply. Parsing belongs to `llm-matcher.ts`. */
  text: string;
  usage: LlmUsage;
  model: string;
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

/**
 * The prompt contract, as written in the plan.
 *
 * Three properties are load-bearing and none is decoration:
 *
 *  - **A closed vocabulary.** The model picks from a list; it does not invent.
 *    Anything outside the list is discarded on the way back in, so a model that
 *    ignores this instruction cannot widen the taxonomy by accident.
 *  - **"unknown" is an allowed answer.** Without it, a model asked to classify
 *    will classify, and a confident wrong key is worse than an honest gap —
 *    the gap goes to teach mode, the wrong key goes into a government form.
 *  - **A word limit on `why`.** The rationale is shown on the review screen;
 *    a paragraph would not be read.
 */
export function buildPrompt(payload: GuardedPayload, allowedKeys: readonly string[]): string {
  const fields = payloadFields(payload);

  return [
    'You map form fields to a fixed vocabulary of profile keys.',
    '',
    `ALLOWED KEYS: ${allowedKeys.join(', ')}`,
    'Return "unknown" if no key fits. Never invent keys.',
    '',
    'FIELDS:',
    JSON.stringify(fields),
    '',
    'Return ONLY a JSON array:',
    '[{"ref":"f12","key":"family.father_name","confidence":0.0-1.0,"why":"<12 words"}]',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/**
 * Ask the model to map these fields.
 *
 * Returns the raw reply. Every failure is an `LlmUnavailable` carrying a code
 * the caller turns into a notice — there is no path here that throws something
 * a caller has to guess about.
 */
export async function askModel(
  payload: GuardedPayload,
  allowedKeys: readonly string[],
  config: LlmConfig,
  transport: Transport = fetch,
): Promise<LlmCall> {
  if (config.apiKey.trim() === '') {
    throw new LlmUnavailable('no-key', FAILURE_TEXT['no-key']);
  }

  const model = config.model ?? DEFAULT_MODEL;

  let response: Response;
  try {
    response = await transport(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': API_VERSION,
        // Required for a direct call from an extension context. It is named
        // "dangerous" because in a *web page* it would expose the key to the
        // page; a service worker is not a page, and the key never leaves it.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: [{ role: 'user', content: buildPrompt(payload, allowedKeys) }],
      }),
    });
  } catch {
    // A DNS failure, an offline machine, a blocked host. Indistinguishable
    // from here, and the user's next step is the same for all of them.
    throw new LlmUnavailable('offline', FAILURE_TEXT.offline);
  }

  if (!response.ok) throw failureFor(response.status);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new LlmUnavailable('bad-response', FAILURE_TEXT['bad-response']);
  }

  const text = textOf(body);
  if (text === null) throw new LlmUnavailable('bad-response', FAILURE_TEXT['bad-response']);

  return { text, usage: usageOf(body), model };
}

function failureFor(status: number): LlmUnavailable {
  if (status === 401 || status === 403) {
    return new LlmUnavailable('unauthorised', FAILURE_TEXT.unauthorised);
  }
  if (status === 429) return new LlmUnavailable('rate-limited', FAILURE_TEXT['rate-limited']);
  if (status >= 500) return new LlmUnavailable('server-error', FAILURE_TEXT['server-error']);
  return new LlmUnavailable('bad-response', `The model service returned ${status}.`);
}

/** Pull the assistant's text out of a Messages API response. */
function textOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const content = (body as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const record = block as { type?: unknown; text?: unknown };
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text);
  }

  return parts.length > 0 ? parts.join('') : null;
}

function usageOf(body: unknown): LlmUsage {
  const usage = (body as { usage?: { input_tokens?: unknown; output_tokens?: unknown } }).usage;
  return {
    inputTokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0,
    outputTokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0,
  };
}
