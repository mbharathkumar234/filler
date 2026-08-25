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

declare global {
  interface Window {
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
