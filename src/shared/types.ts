/**
 * Locked contracts transcribed from the implementation plan.
 *
 * These are type declarations only — no matching, filling, or runtime logic
 * lives here. They are written in Phase 0 because every later phase codes
 * against them, and because §5 says the state machine must be *designed*
 * before Phase 5 rather than discovered during it.
 */

import type { FieldKey, UnknownKey } from '@/matching/taxonomy';

// ---------------------------------------------------------------------------
// §3 / Phase 3 — the harvester's output
// ---------------------------------------------------------------------------

export type FieldTag =
  | 'input'
  | 'select'
  | 'textarea'
  | 'radio-group'
  | 'checkbox'
  | 'file'
  | 'custom';

export interface FieldOption {
  value: string;
  text: string;
}

export interface FieldDescriptor {
  /** Stable-ish internal handle. */
  ref: string;
  /** Ranked: id -> name -> label-anchored XPath -> nth-of-type. */
  selectors: string[];
  tag: FieldTag;
  type?: string;
  /** Resolved from <label for>, aria-label, wrapping text, table cell to the left. */
  labelText: string;
  placeholder?: string;
  /**
   * The site's own `autocomplete` declaration, when present. The strongest
   * matching signal there is (§ Phase 4): the page is telling us what the
   * field holds rather than us inferring it.
   */
  autocomplete?: string;
  /**
   * The headings that govern this field — its fieldset's legend and the nearest
   * heading before it — nearest first, joined by `NEARBY_SEPARATOR`. Trimmed.
   *
   * The matcher reads it as section context: which address block, which
   * qualification, whose details. The LLM receives it as structure.
   */
  nearbyText: string;
  options?: FieldOption[];
  maxLength?: number;
  pattern?: string;
  /**
   * The field's own `inputmode`, when it declares one.
   *
   * Added in Phase 8: `inputmode="numeric"` is how a modern portal says "this
   * box takes digits", and nothing was reading it — so a four-character
   * numeric box labelled "Name" was confidently mapped to a full name. Sits
   * beside `pattern` because it serves exactly the same purpose.
   */
  inputmode?: string;
  /**
   * A file box's own `accept` list, verbatim. File boxes only.
   *
   * Added with document attachment: it is the portal's machine-readable
   * statement of which formats *this* box takes, and it narrows whatever the
   * prose around the box says (`documents/field-constraint.ts`).
   */
  accept?: string;
  /**
   * The hint beside a file box — "JPEG, 20–50 KB", "Max 10 MB" — capped at a
   * few sentences. File boxes only.
   *
   * It decides the size and format the document is derived to. Page text,
   * never a value, and deliberately absent from the LLM payload:
   * `redaction.ts` builds that from a fixed list of fields, and this is not
   * on it.
   */
  requirementText?: string;
  required: boolean;
  /** iframes are first-class. */
  frameId: number;
  visible: boolean;
  enabled: boolean;
}

/** A reference to a harvested field, used across the message bus. */
export type FieldRef = FieldDescriptor['ref'];

// ---------------------------------------------------------------------------
// §4 / Phase 4 — matcher output
// ---------------------------------------------------------------------------

export type MatchSource = 'profile' | 'rule' | 'llm';

export interface MatchResult {
  fieldRef: FieldRef;
  key: FieldKey | UnknownKey;
  /** 0.0–1.0. Thresholds: >=0.85 auto-fill, 0.5–0.85 fill+flag, <0.5 leave blank. */
  confidence: number;
  rationale: string;
  source: MatchSource;
}

/**
 * Joins the headings in `FieldDescriptor.nearbyText`, nearest first.
 *
 * A character that does not occur in form headings, so a heading that itself
 * contains a dash — "Part B — Father's Particulars" — is never split in two.
 */
export const NEARBY_SEPARATOR = ' › ';

export const CONFIDENCE = {
  /** At or above this, fill without flagging. */
  AUTO_FILL: 0.85,
  /** At or above this (and below AUTO_FILL), fill but flag for review. */
  FILL_AND_FLAG: 0.5,
  /** An LLM-sourced match is never trusted above this (§ Phase 8). */
  LLM_CEILING: 0.8,
} as const;

// ---------------------------------------------------------------------------
// §2 / Phase 2 — document constraints
// ---------------------------------------------------------------------------

export interface DocConstraint {
  mime: string[];
  minBytes?: number;
  maxBytes?: number;
  minW?: number;
  minH?: number;
  maxW?: number;
  maxH?: number;
  /** width / height, when the portal fixes it. */
  aspect?: number;
  /** [widthMm, heightMm], e.g. [35, 45] for a 3.5 x 4.5 cm photograph. */
  dimensionsMm?: [number, number];
  dpi?: number;
}

export interface DocumentMeta {
  key: FieldKey;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  dpi?: number;
  pages?: number;
  capturedAt: string;
  /**
   * Where the ink actually sits inside the canvas, in the image's own pixels.
   *
   * Measured once at upload (`documents/trim.ts`) because the panel never sees
   * a stored document's bytes — they are decrypted in the worker and stay
   * there. Optional: documents stored before this existed have none, PDFs have
   * none, and a measurement is allowed to fail. Absent means "judge by the
   * canvas", which is what everything did before.
   */
  content?: { left: number; top: number; width: number; height: number };
}

// ---------------------------------------------------------------------------
// §4 — the shippable site profile (site-profiles/<site-id>.json)
// ---------------------------------------------------------------------------

export interface SiteProfileField {
  key: FieldKey;
  selectors: string[];
  confidence: number;
  source: MatchSource | 'taught';
}

export interface SiteProfileDocument {
  key: FieldKey;
  selectors: string[];
  constraint: DocConstraint;
}

export interface SiteProfileBlocker {
  type: 'captcha' | 'otp' | 'esign' | 'payment' | 'unknown_widget';
  selectors: string[];
}

export interface SiteProfile {
  siteId: string;
  version: number;
  matchUrl: string;
  formFingerprint: string;
  createdAt: string;
  lastVerifiedAt: string;
  fields: SiteProfileField[];
  documents: SiteProfileDocument[];
  submit: { selectors: string[]; label: string };
  blockers: SiteProfileBlocker[];
}

// ---------------------------------------------------------------------------
// §5 — the fill plan and the run state machine
// ---------------------------------------------------------------------------

export interface PlannedField {
  fieldRef: FieldRef;
  key: FieldKey;
  selectors: string[];
  confidence: number;
  source: MatchSource | 'taught';
  /** Set once the field has been written and read back successfully. */
  filledAt?: number;
  fillFailed?: boolean;
  truncated?: boolean;
}

export interface FillPlan {
  siteId: string;
  profileVersion: number | null;
  formFingerprint: string;
  tabId: number;
  fields: PlannedField[];
  documents: Array<{ fieldRef: FieldRef; key: FieldKey; constraint: DocConstraint }>;
  submit: { selectors: string[]; label: string } | null;
  createdAt: number;
}

export type BlockReason = 'captcha' | 'otp' | 'esign' | 'payment' | 'unknown_widget';

export interface ReviewDiff {
  lowConfidence: FieldRef[];
  truncated: FieldRef[];
  fuzzySelect: FieldRef[];
  fillFailed: FieldRef[];
  requiredButEmpty: FieldRef[];
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

/**
 * §5, verbatim. The run is not a linear pass: CAPTCHA/OTP hand control back to
 * the user, and ASP.NET postbacks regenerate DOM ids.
 */
export type RunState =
  | { t: 'IDLE' }
  /** Is there a form here? */
  | { t: 'DETECTING' }
  /** Match fields -> keys. */
  | { t: 'PLANNING'; fields: FieldDescriptor[] }
  | { t: 'NEEDS_TEACHING'; unmapped: FieldDescriptor[] }
  /** User sees "Fill this form". */
  | { t: 'READY'; plan: FillPlan }
  /**
   * Vault passphrase / re-auth.
   *
   * Carries the plan it interrupted. §5 wrote this state as payload-free, but
   * a re-auth gate that forgets what the user was doing forces them to start
   * the run again — which is a worse outcome than the gate prevents. `null`
   * covers an unlock that happened before there was a plan.
   */
  | { t: 'UNLOCKING'; plan: FillPlan | null }
  | { t: 'FILLING'; plan: FillPlan; cursor: number }
  | { t: 'BLOCKED'; reason: BlockReason; plan: FillPlan }
  /** After DOM churn / postback / resume. */
  | { t: 'REVERIFYING'; plan: FillPlan }
  /** Selectors no longer resolve. */
  | { t: 'DRIFTED'; plan: FillPlan; lost: FieldRef[] }
  | { t: 'REVIEW'; plan: FillPlan; diff: ReviewDiff }
  | { t: 'ARMED'; plan: FillPlan; approvalToken: string; expiresAt: number }
  | { t: 'SUBMITTED'; at: number }
  | { t: 'ABORTED'; why: string }
  | { t: 'ERROR'; err: SerializedError };

export type RunStateTag = RunState['t'];

/** §5: approvalToken is a random 128-bit value, single-use, 90-second TTL. */
export const APPROVAL_TOKEN_TTL_MS = 90_000;
export const APPROVAL_TOKEN_BYTES = 16;

/** §5: mutation touching more than this share of tracked nodes forces REVERIFYING. */
export const DRIFT_MUTATION_THRESHOLD = 0.2;

/** § Phase 9: below this selector-resolution rate a profile is stale, not usable. */
export const PROFILE_STALE_THRESHOLD = 0.6;

/** §1: run state key in chrome.storage.session. */
export function runStateKey(tabId: number, formFingerprint: string): string {
  return `run:${tabId}:${formFingerprint}`;
}
