import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The values scan (U0.M9, `MASTER_PROMPT.md`): the user's real values must never
 * be found in the repository — not in a file, not in any commit. Run against a
 * throwaway repository, so the test needs no real values of its own.
 */

const SCRIPT = join(process.cwd(), 'scripts', 'scan-values.mjs');
const made: string[] = [];

function repository(files: Record<string, string>, commit: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'scan-values-'));
  made.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  for (const [name, text] of Object.entries(commit)) writeFileSync(join(dir, name), text);
  if (Object.keys(commit).length > 0) {
    git('add', '-A');
    git('commit', '-q', '-m', 'history');
    for (const name of Object.keys(commit)) rmSync(join(dir, name));
    git('add', '-A');
    git('commit', '-q', '-m', 'gone from the tree, still in history');
  }
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

function scan(dir: string, values: string[] | null) {
  const env = { ...process.env };
  if (values !== null) {
    const list = join(dir, '..', `${dir.split(/[\\/]/).pop()}-values.txt`);
    writeFileSync(list, `# made-up values\n${values.join('\n')}\n`);
    made.push(list);
    env.SCAN_VALUES_FILE = list;
  } else {
    env.SCAN_VALUES_FILE = join(dir, 'no-such-file.txt');
  }
  return spawnSync(process.execPath, [SCRIPT], { cwd: dir, env, encoding: 'utf8' });
}

afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('the values scan', () => {
  it('passes a repository holding none of the values', () => {
    const result = scan(repository({ 'notes.md': 'Nothing personal here.' }), ['PLANTED-VALUE-ONE']);
    expect(result.status).toBe(0);
  });

  it('fails on a value in the working tree, whatever its case', () => {
    const result = scan(repository({ 'notes.md': 'the name was planted-value-one' }), ['PLANTED-VALUE-ONE']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('working tree: notes.md');
  });

  it('fails on a value only history still holds', () => {
    const result = scan(repository({}, { 'old.md': 'PLANTED-VALUE-TWO' }), ['PLANTED-VALUE-TWO']);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/history: [0-9a-f]{7}:old\.md/);
  });

  it('never prints the value it found', () => {
    const result = scan(repository({ 'notes.md': 'PLANTED-VALUE-ONE' }), ['PLANTED-VALUE-ONE']);
    expect(`${result.stdout}${result.stderr}`).not.toContain('PLANTED-VALUE-ONE');
    expect(result.stdout).toContain('line 2 of the values file');
  });

  it('says it checked nothing when there is nothing to look for, rather than calling that clean', () => {
    const result = scan(repository({ 'notes.md': 'anything' }), null);
    expect(result.status).toBe(2);
  });
});

describe('where the values live', () => {
  it('is a folder git ignores', () => {
    expect(readFileSync(join(process.cwd(), '.gitignore'), 'utf8')).toMatch(/^\.private\/\r?$/m);
    const ignored = spawnSync('git', ['check-ignore', '-q', '.private/values.txt'], { cwd: process.cwd() });
    expect(ignored.status).toBe(0);
  });
});
