#!/usr/bin/env node
/**
 * `npm run bench` — measure the corpus (U0.M5, `MASTER_PROMPT.md`).
 * `npm run bench -- --baseline` — also record the numbers as the bar later
 * phases are held to. Only after the human approves a phase (§5.7).
 *
 * See bench/README.md for what is measured and how to read it.
 */

import { spawnSync } from 'node:child_process';

const baseline = process.argv.includes('--baseline');
const result = spawnSync('npx', ['vitest', 'run', '--config', 'vitest.bench.config.ts'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, ...(baseline ? { BENCH_WRITE_BASELINE: '1' } : {}) },
});
process.exit(result.status ?? 1);
