// `npm run bench` (U0.M5, `MASTER_PROMPT.md`): the corpus benchmark, kept out of
// `npm test`. See bench/README.md.
import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/corpus/*.run.ts'],
    testTimeout: 600_000,
    hookTimeout: 60_000,
  },
});
