# The bench

What the extension is measured on (U0, `MASTER_PROMPT.md`), and the bar every later phase is
held to. Nothing in this folder holds a person's value: results are counts, and the mistakes
listed in `summary.md` are named by their form labels.

## Commands

| Command | What it does |
|---|---|
| `npm run bench` | Measures every corpus snapshot and made-up fixture; writes `results.json`, `summary.md`, `timing.json`; fails on a confidently wrong field in the corpus, or on accuracy below the baseline |
| `npm run bench -- --baseline` | The same, then records the numbers as the bar in `baseline.json`. Only after the human approves a phase (§5.7) |
| `npm run capture -- <url> --category <c> --name <n> --stack <s> [--login]` | Captures a real form as a snapshot (`scripts/capture-snapshot.mjs`) |
| `npm run doc-bench` | Reads your own documents on your own machine and scores them against your answer key; only counts leave `.private/` |
| `npm run scan-values` | Looks for your real values in every file and every commit |

## The corpus

`fixtures/corpus/<category>/<name>.html` — real forms, captured with every value, token, script and
URL removed (`src/corpus/snapshot.ts`). Each field carries the right answer in `data-expect`: a
field key, `unknown` for a field nothing should fill, or `ambiguous` for one even a careful person
could not decide. The product never reads `data-expect` (`src/shared/no-cheating.test.ts`).

`split.json` puts each snapshot in **tune** (60%) or **held-out** (40%) when it first joins, and
never moves it (`src/corpus/split.ts`). Held-out snapshots are only measured, never used to choose
a rule, synonym or threshold.

The made-up fixtures (`fixtures/bench`, `fixtures/heldout-*`, `fixtures/*-portal`) are measured
apart: they were written by the same hand as the synonym list, so they say whether something broke,
never how good the product is.

## What is counted

For each field, against its `data-expect` (`src/corpus/metrics.ts`), using the product's own
thresholds — at 0.85 a value fills without a flag; from 0.5 it fills with a flag; below that the
box is left empty:

| Count | Meaning |
|---|---|
| Fields with a key | `data-expect` is a field key: the denominator of accuracy |
| Correct | The right key, filled |
| Correct, unflagged | The right key, filled without a flag |
| Left empty | Should have been filled, was not |
| Wrong | A wrong key filled, or anything filled into a field nothing should fill |
| **Wrong, unflagged** | A wrong key filled without a flag — the mistake a reviewer is not prompted to catch. **Must be 0.** |
| Ambiguous / unlabelled | Set aside; unlabelled fields must be labelled before a gate |

Accuracy is *correct ÷ fields with a key*. Times are harvest plus match per form, in jsdom; the
browser fill stage (fill-stick, real timings) is the second half of U0.M5.

## Protected metrics (`MASTER_PROMPT.md` §5.7)

| Metric | Tolerance |
|---|---|
| Wrong, unflagged — on the corpus | 0, absolute |
| Accuracy, per category | no drop greater than 1 percentage point below `baseline.json` |
| Fill-stick | no drop (from the browser stage) |
| Portal errors left after filling | no rise (from U1) |
| Document field accuracy | no drop (`npm run doc-bench`) |
| Median time per form, per document page | no rise greater than 10% |
| Install size | within the budget in `GATES.md` |
