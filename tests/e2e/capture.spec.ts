import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * The corpus capture tool on a live page (U0.M1, `MASTER_PROMPT.md`).
 *
 * `fixtures/corpus-check/live-values.html` types into its own form after it
 * loads, as a person or a portal's session script would. The tool, run as a
 * person runs it but without the pause, must save the form and none of it.
 */

test('captures a live form with nothing that was typed into it, and everything the matcher reads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-'));
  try {
    const out = join(dir, 'snapshot.html');
    const result = spawnSync(
      process.execPath,
      [
        'scripts/capture-snapshot.mjs',
        'http://localhost:4173/corpus-check/live-values.html',
        '--category', 'everyday',
        '--name', 'live-values',
        '--stack', 'plain',
        '--headless',
        '--out', out,
      ],
      { encoding: 'utf8', timeout: 120_000 },
    );
    expect(result.status, result.stderr).toBe(0);

    const html = readFileSync(out, 'utf8');
    expect(html).not.toMatch(/CANARY|2001-02-03/);
    expect(html).not.toMatch(/<script|\bselected\b|\bchecked\b|session=/i);
    for (const kept of [
      '<h1>Registration</h1>',
      '<label for="name">Full name</label>',
      'type="date"',
      '<option value="TN">Tamil Nadu</option>',
      'name="about"',
      '<meta name="corpus:origin" content="localhost:4173">',
    ]) {
      expect(html, kept).toContain(kept);
    }
    // Hidden by the page's own stylesheet, and marked so without it.
    expect(html).toMatch(/<div class="secret" hidden="">/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
