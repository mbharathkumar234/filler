/**
 * The surface the derivation harness exposes to Playwright.
 *
 * Declared here rather than inside `main.ts` so both TypeScript projects can
 * see it: the browser project that builds the harness, and the Node project
 * that type-checks the specs driving it.
 */
export interface HarnessResult {
  ok: boolean;
  mime?: string;
  bytes?: number;
  width?: number;
  height?: number;
  quality?: number;
  fit?: string;
  warnings?: string[];
  attempts?: number;
  reason?: string;
  code?: string;
  magic?: number[];
}

export interface HarvestedField {
  ref: string;
  tag: string;
  labelText: string;
  nearbyText: string;
  visible: boolean;
  enabled: boolean;
  required: boolean;
  selectors: string[];
  optionCount: number;
  source: string;
}

export interface HarvestSnapshot {
  fields: HarvestedField[];
  blockers: { type: string; reason: string }[];
  wizard: { step: number | null; totalSteps: number | null; evidence: string } | null;
  visibleCount: number;
  labelledCount: number;
  domUnchanged: string;
}

export interface FillRecord {
  ref: string;
  ok: boolean;
  strategy: string;
  truncated: boolean;
  fuzzy: boolean;
  attempts: number;
}

export interface GuardReport {
  blocked: number;
  armed: boolean;
  toasts: string[];
  submitAttempts: number;
  submitEventsSeen: number;
}

export interface HarnessWrite {
  ref: string;
  key: string;
  value: string;
  dependent?: boolean;
}

/** § Phase 6: the run, driven from a spec. */
export interface RunHarness {
  /** Build a plan from these `name` → value pairs and fill. Returns the state. */
  start(values: Record<string, string>): Promise<string>;
  /** Re-attach to a persisted run in a freshly loaded document. */
  resume(): Promise<string>;
  state(): string;
  /** How many fields the attached run's plan holds. */
  planSize(): number;
  blocker(): string | null;
  blockerCount(): number;
  instruction(): string;
  continue(): Promise<string>;
  reverify(): Promise<string>;
  checkPage(): void;
  values(): Record<string, string>;
  events(): string[];
  reset(): void;
}

/** § Phase 7: the review screen's page-side operations. */
export interface ReviewHarness {
  collect(refs: string[]): Record<string, string>;
  focus(ref: string): {
    marker: { top: number; left: number; width: number; height: number };
    field: { top: number; left: number; width: number; height: number };
    focused: boolean;
    fieldHtml: string;
  } | null;
  edit(ref: string, value: string): { ok: boolean; value: string; reason?: string };
}

/** § Phase 9: drift detection and repair, driven from a spec. */
export interface TeachHarness {
  /** Record a deliberately fragile id-only profile, as a pre-redesign one. */
  recordIdOnlyProfile(mapping: Record<string, string>): unknown;
  /** How much of the stored profile still resolves against this render. */
  health(): {
    resolved: number;
    total: number;
    rate: number;
    stale: boolean;
    broken: string[];
  } | null;
  /** Point at a field by `name`, as the user would point at it on screen. */
  pick(name: string): { selectors: string[]; label: string; refused?: string } | null;
  /** Teach every mapping and save the next version. */
  teachAndSave(mapping: Record<string, string>): { version: number; fields: number };
  profileVersion(): number;
  selectorsFor(key: string): string[];
  /** Fill from the stored profile; returns how many fields took a value. */
  fill(values: Record<string, string>): Promise<number>;
  resetProfile(): void;
}

declare global {
  interface Window {
    __teach: TeachHarness;
    __review: ReviewHarness;
    __run: RunHarness;
    /**
     * Provided by `fixtures/postback-portal/page-1.html` itself, not by the
     * harness — the fixture's way of letting a spec trigger the bad behaviour
     * it exists to reproduce.
     */
    __postback: () => void;
    __solveCaptcha: () => void;
    __renderCount: () => number;
    __postbackCount: () => number;
    __installGuard: () => { installed: boolean };
    __fill: (writes: HarnessWrite[]) => Promise<{ records: FillRecord[]; aborted: boolean }>;
    __guardReport: () => GuardReport;
    __arm: (token: { value: string; expiresAt: number; targetSelector: string }) => void;
    __harvest: () => HarvestSnapshot;
    __derive: (
      url: string,
      sourceMime: string,
      constraintText: string,
    ) => Promise<HarnessResult>;
  }
}
