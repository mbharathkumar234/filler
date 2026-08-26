/**
 * Message schema validation (§ Phase 10).
 *
 *   "Message-bus hardening: validate sender, reject messages from page context,
 *    schema-validate every message."
 *
 * The first two have existed since Phase 0 (`assertSenderMayRequest`). This is
 * the third, and it is the one that matters if either of the others is ever
 * wrong.
 *
 * ## What this actually defends against
 *
 * Not a hostile web page — a page cannot post onto the extension bus at all,
 * and `sender.id` is set by Chrome. The realistic attacker is **a compromised
 * content script**: it runs in a hostile page's tab, it *is* a legitimate
 * sender, and the sender check therefore says yes to everything it sends. Two
 * of the messages it may legitimately send carry structured data —
 * `fill:refill` with a list of refs, `teach:picked` with selectors — and a
 * caller that trusts their shape is a caller that can be fed a
 * hundred-thousand-element array or an object where a string belongs.
 *
 * So this is depth, not the primary control: it turns "malformed input reaches
 * a handler" into "the message is rejected at the door with a reason".
 *
 * ## Why it is written by hand
 *
 * A schema library would be a dependency in the most security-sensitive path
 * in the product, pulled in to check about twenty message shapes. Hand-written
 * predicates are auditable in one sitting and add nothing to the bundle.
 */

import { isFieldKey } from '@/matching/taxonomy';
import { PRIVILEGED_TYPES, type ExtensionRequest, type RequestType } from './messages';

/** Caps. Anything past these is a bug or an attack; both should be refused. */
export const LIMITS = {
  /** Longest string any message field may carry. */
  string: 20_000,
  /** Longest passphrase we will even attempt to derive a key from. */
  passphrase: 1_024,
  /** Most array entries in one message. */
  array: 1_000,
  /** Most bytes in a document upload (10 MB, matching the derivation cap). */
  bytes: 10 * 1024 * 1024,
} as const;

export interface ValidationResult {
  ok: boolean;
  /** Why it was refused, for the worker's log. Never echoes the payload. */
  reason?: string;
}

const OK: ValidationResult = { ok: true };

function bad(reason: string): ValidationResult {
  return { ok: false, reason };
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function str(value: unknown, max: number = LIMITS.string): boolean {
  return typeof value === 'string' && value.length <= max;
}

function optionalStr(value: unknown, max: number = LIMITS.string): boolean {
  return value === undefined || str(value, max);
}

function num(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function strArray(value: unknown): boolean {
  return (
    Array.isArray(value) && value.length <= LIMITS.array && value.every((item) => str(item))
  );
}

function key(value: unknown): boolean {
  return typeof value === 'string' && isFieldKey(value);
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

type Check = (request: Record<string, unknown>) => boolean;

/**
 * One predicate per message type that carries data.
 *
 * A type absent from this table carries nothing but its `type`, and is
 * accepted on that basis — which `noPayloadTypes` below asserts is true.
 */
const CHECKS: Partial<Record<RequestType, Check>> = {
  'vault:create': (r) => str(r.passphrase, LIMITS.passphrase),
  'vault:unlock': (r) => str(r.passphrase, LIMITS.passphrase),
  'vault:reauth': (r) => str(r.passphrase, LIMITS.passphrase),
  'vault:set': (r) => key(r.key) && str(r.value),
  'vault:delete': (r) => key(r.key),
  'vault:import': (r) => str(r.text, LIMITS.bytes) && str(r.passphrase, LIMITS.passphrase),

  'doc:put': (r) =>
    key(r.key) &&
    str(r.label) &&
    str(r.mime, 100) &&
    num(r.width) &&
    num(r.height) &&
    Array.isArray(r.bytes) &&
    r.bytes.length <= LIMITS.bytes &&
    r.bytes.every((byte) => typeof byte === 'number' && byte >= 0 && byte <= 255),
  'doc:delete': (r) => str(r.id, 200),
  'doc:derive': (r) => key(r.key) && typeof r.constraint === 'object' && r.constraint !== null,
  'doc:preflight': (r) => key(r.key) && typeof r.constraint === 'object' && r.constraint !== null,

  'harvest:tab': (r) => num(r.tabId),
  'fill:tab': (r) => num(r.tabId),
  'fill:undo:tab': (r) => num(r.tabId),
  'fill:apply': (r) => Array.isArray(r.writes) && r.writes.length <= LIMITS.array,
  // Content-script originated. The worker intersects these against the run's
  // own plan (`refillTab`), so this only has to stop the absurd.
  'fill:refill': (r) => strArray(r.refs),
  'fill:submit': (r) => typeof r.token === 'object' && r.token !== null,

  'review:build': (r) => num(r.tabId),
  'review:collect': (r) => strArray(r.refs),
  'field:focus': (r) => str(r.ref, 200),
  'field:apply-edit': (r) => str(r.ref, 200) && str(r.value),
  'field:highlight': (r) => num(r.tabId) && str(r.ref, 200),
  'field:edit': (r) =>
    num(r.tabId) && str(r.ref, 200) && str(r.value) && (r.saveKey === undefined || key(r.saveKey)),

  'approval:grant': (r) => num(r.tabId),
  'approval:submit': (r) => num(r.tabId),
  'approval:revoke': (r) => num(r.tabId),
  'approval:status': (r) => num(r.tabId),

  'audit:read': (r) => r.limit === undefined || num(r.limit),
  'audit:configure': (r) => typeof r.logValues === 'boolean',

  'llm:set-key': (r) => r.apiKey === null || str(r.apiKey, 500),
  'llm:set-model': (r) => r.model === null || str(r.model, 100),

  'teach:start': (r) => num(r.tabId),
  'teach:stop': (r) => num(r.tabId),
  'teach:cancel': (r) => num(r.tabId),
  'teach:session': (r) => num(r.tabId),
  // Content-script originated: this is the shape a compromised page-side
  // script could choose freely, so it is checked in full.
  'teach:picked': (r) =>
    (r.ref === null || str(r.ref, 200)) &&
    strArray(r.selectors) &&
    str(r.label, 500) &&
    str(r.tag, 50) &&
    optionalStr(r.refused, 500),
  'teach:assign': (r) =>
    num(r.tabId) &&
    key(r.key) &&
    (r.ref === null || str(r.ref, 200)) &&
    strArray(r.selectors) &&
    str(r.label, 500),
  'teach:assign-document': (r) =>
    num(r.tabId) &&
    key(r.key) &&
    (r.ref === null || str(r.ref, 200)) &&
    strArray(r.selectors) &&
    str(r.label, 500) &&
    typeof r.constraint === 'object' &&
    r.constraint !== null,
  'teach:forget': (r) => num(r.tabId) && key(r.key),
  'teach:save': (r) => num(r.tabId),

  'profile:health': (r) => num(r.tabId),
  'profile:versions': (r) => str(r.fingerprint, 200),
  'profile:rollback': (r) => str(r.fingerprint, 200),
  'profile:import': (r) => str(r.text, LIMITS.bytes),

  'guard:status': (r) => num(r.tabId),
  'guard:enable': (r) => num(r.tabId),
  'guard:disable': (r) => str(r.origin, 500),

  'run:state': (r) => typeof r.state === 'object' && r.state !== null,
  'run:abort': (r) => str(r.why, 500),
};

/** Message types that legitimately carry nothing but a `type`. */
export const NO_PAYLOAD_TYPES: readonly RequestType[] = [
  'ping',
  'vault:status',
  'vault:lock',
  'vault:list',
  'vault:completeness',
  'vault:export',
  'vault:touch',
  'doc:list',
  'harvest:request',
  'harvest:ready',
  'run:hello',
  'run:continue',
  'fill:undo',
  'audit:settings',
  'audit:clear',
  'llm:status',
  'llm:reset-usage',
  'llm:forget-learned',
  'teach:pick-start',
  'teach:pick-stop',
  'profile:export',
  'guard:origins',
];

/**
 * Is this a message we are prepared to act on?
 *
 * Unknown types are refused. That is deliberate and slightly awkward — it
 * means a new message type must be added here as well as to the union — but
 * the alternative is a default-allow bus, and a default-allow bus is one
 * forgotten entry away from being no check at all.
 */
export function validateRequest(request: unknown): ValidationResult {
  if (typeof request !== 'object' || request === null) {
    return bad('not an object');
  }

  /*
   * Own enumerable properties only.
   *
   * Found by an adversarial test: `Object.create({ type: 'vault:status' })`
   * validated, because every predicate here reads `r.field` and that walks the
   * prototype chain. A message cannot reach the bus that way — `sendMessage`
   * structured-clones, which drops the prototype — so this was never
   * exploitable. But a validator whose correctness depends on how its caller
   * happened to serialise the input is a validator holding an assumption it
   * does not state, and this is the module whose entire job is not doing that.
   *
   * The spread also means a field hidden on the prototype cannot stand in for
   * a required own property, which is the same bug in its more useful form.
   */
  const record = { ...(request as Record<string, unknown>) };
  const type = record.type;
  if (typeof type !== 'string') return bad('no type');

  const check = CHECKS[type as RequestType];
  if (check) {
    return check(record) ? OK : bad(`malformed "${type}"`);
  }

  if (NO_PAYLOAD_TYPES.includes(type as RequestType)) return OK;

  return bad(`unknown message type "${type}"`);
}

/** Every type this module knows about, for the completeness test. */
export function knownTypes(): Set<string> {
  return new Set<string>([...Object.keys(CHECKS), ...NO_PAYLOAD_TYPES]);
}

/**
 * A privileged type must never be reachable from a content script.
 *
 * Re-exported from here so the validation test can assert the two lists agree
 * — a type added to one and not the other is exactly the gap worth catching.
 */
export function isPrivileged(type: string): boolean {
  return PRIVILEGED_TYPES.has(type);
}

export type { ExtensionRequest };
