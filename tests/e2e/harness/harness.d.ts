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

export interface DocumentRecord {
  ref: string;
  ok: boolean;
  strategy: string;
  reason: string;
}

/** § document attachment: documents into a real page, through the content script's own code. */
export interface DocumentsHarness {
  /** Attach bytes to a box (by id or name) or drop them on an area (by id). */
  attach(ref: string, base64: string, mime: string, filename: string): Promise<DocumentRecord[]>;
  /** Read the box's requirement, derive the photo at `url` to it, attach the result. */
  deriveAndAttach(
    ref: string,
    url: string,
    sourceMime: string,
  ): Promise<{ ok: boolean; reason: string; minBytes: number; maxBytes: number }>;
  undo(): number;
  file(ref: string): { name: string; type: string; size: number } | null;
  harvest(): { id: string; name: string; labelText: string; accept: string; requirementText: string }[];
  slots(): { ref: string; kind: string; label: string; requirementText: string }[];
  uploadButton(ref: string): { selector: string; label: string } | null;
  /** The page's half of an approved upload, exactly as the content script runs it. */
  pressUpload(targetSelector: string, approvedRef: string): boolean;
  /** Fill's own document decisions and the real filler; returns what each box now holds. */
  fillLikeFill(): Promise<{ label: string; filename: string | null }[]>;
  /** The real one-hold batch against this page; returns its per-document results. */
  uploadAll(keysByLabel: Record<string, string>): Promise<
    { ref: string; label: string; uploaded: boolean; why?: string; trace?: string[] }[]
  >;
  /** The upload-window functions' own source, to run in a frame as `executeScript` would. */
  windowFunctions(): { probe: string; place: string; open: string; press: string; shows: string };
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
    __documents: DocumentsHarness;
    /** Set by `fixtures/documents-portal/page-1.html`: what its drop widget received. */
    __dropped?: { name: string; type: string; size: number }[];
    /** Set by `fixtures/documents-portal/upload-window.html`. */
    __received?: { name: string; type: string; size: number; via: string }[];
    __uploadPresses?: number;
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
    /** Set by `fixtures/hostile-portal/two-submits.html`: which button submitted. */
    __lastSubmitter?: string;
    __submitOtherFormFromScript?: () => void;
    __submitOwnFormFromScript?: () => void;
    __harvest: () => HarvestSnapshot;
    __derive: (
      url: string,
      sourceMime: string,
      constraintText: string,
    ) => Promise<HarnessResult>;
    __pdf: PdfHarness;
  }
}

/** A locked PDF, opened by the real pdf.js the extension ships (`documents/pdf-lock.ts`). */
interface PdfHarness {
  lock(url: string, password?: string): Promise<'open' | 'needs-password' | 'wrong-password'>;
  /** The values the rules find in the text layer, read with `password`. */
  read(url: string, password?: string): Promise<Array<{ key: string; value: string; verified: boolean }>>;
  raster(url: string, password?: string): Promise<{ width: number; height: number }>;
  /** A portal copy made with `password`, and whether that copy opens without one. */
  derive(
    url: string,
    password: string,
    constraintText: string,
  ): Promise<{ ok: boolean; mime?: string; opensWithoutPassword?: boolean; reason?: string }>;
}
