// Vitest reads the `test` block from vite.config.ts. This file exists so that
// `vitest` can run without the crxjs plugin (which needs a browser build target).
import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    passWithNoTests: false,

    /*
     * Argon2id costs 64 MiB per derivation (§ Phase 10), so a suite that
     * derives real keys is genuinely slow. The timeouts are raised to allow
     * for one on a loaded machine — the shipped KDF is *supposed* to be
     * expensive, and tuning it down for the convenience of CI would be exactly
     * backwards.
     *
     * The vault suites use deliberately cheap Argon2id parameters for setup
     * (see the `TEST_KDF` note in `crypto.test.ts`); only the tests that are
     * about the KDF itself pay full price.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
