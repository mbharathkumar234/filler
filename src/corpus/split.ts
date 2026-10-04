/**
 * Tune and held-out (U0.M4, `MASTER_PROMPT.md`).
 *
 * The corpus is split 60/40 into snapshots the matcher may be tuned against and
 * snapshots that are only ever measured. A snapshot's side is decided when it
 * first joins — in an order fixed by a hash of its name, so nobody chooses it —
 * keeping its category nearest 60/40, and recorded in `bench/split.json`. It is
 * never decided again: `splitIsHonest` replays the rule over the recorded list,
 * so an entry moved by hand fails the bench's test. Pure.
 */

export type Side = 'tune' | 'held-out';
/** `<category>/<file name without .html>`, and its side. */
export type SplitEntry = [name: string, side: Side];

export const TUNE_SHARE = 0.6;

const categoryOf = (name: string) => name.split('/')[0] ?? '';

/** FNV-1a: a fixed, unremarkable order for snapshots that join together. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The side the next snapshot of `category` joins, given everything placed so far. */
function nextSide(placed: readonly SplitEntry[], category: string): Side {
  const mine = placed.filter(([name]) => categoryOf(name) === category);
  const tune = mine.filter(([, side]) => side === 'tune').length;
  return tune < Math.round(TUNE_SHARE * (mine.length + 1)) ? 'tune' : 'held-out';
}

/** `entries`, with every name not yet placed added after them; nothing already placed moves. */
export function extendSplit(entries: readonly SplitEntry[], names: readonly string[]): SplitEntry[] {
  const known = new Set(entries.map(([name]) => name));
  const fresh = [...new Set(names)]
    .filter((name) => !known.has(name))
    .sort((a, b) => hash(a) - hash(b) || a.localeCompare(b));
  const placed = [...entries];
  for (const name of fresh) placed.push([name, nextSide(placed, categoryOf(name))]);
  return placed;
}

/** Does every entry hold the side the rule gave it, in the order recorded? */
export function splitIsHonest(entries: readonly SplitEntry[]): boolean {
  const replayed: SplitEntry[] = [];
  for (const [name, side] of entries) {
    if (nextSide(replayed, categoryOf(name)) !== side) return false;
    replayed.push([name, side]);
  }
  return true;
}
