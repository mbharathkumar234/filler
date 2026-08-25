import { execFileSync } from 'node:child_process';

/**
 * Build the derivation harness before the suite runs.
 *
 * The harness bundles the real `documents/` pipeline for the browser. Building
 * it here rather than committing the output keeps the bundle from drifting out
 * of step with the source it is supposed to be testing.
 */
export default function globalSetup(): void {
  execFileSync('npm', ['run', 'harness:build'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}
