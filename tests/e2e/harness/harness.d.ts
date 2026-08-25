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

declare global {
  interface Window {
    __derive: (
      url: string,
      sourceMime: string,
      constraintText: string,
    ) => Promise<HarnessResult>;
  }
}
