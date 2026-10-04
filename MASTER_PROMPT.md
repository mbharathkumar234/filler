# AutoFill Assistant — Master Prompt: the Unbeatable Plan (U0–U11)

> **For the AI agent working in this repository.** Read every section before writing any code.
> The human who owns this project approves every phase gate. You never approve your own gate.
> Phase state lives in `GATES.md`. Gate reports live in `STATUS.md`.

---

## 0. Start of every session

1. Read, in this order: `CLAUDE.md`, this file, `GATES.md`, the latest gate report and progress
   notes in `STATUS.md`, then the files under **Read first** for the current phase.
2. The **current phase** is the first phase in `GATES.md` whose status is not `APPROVED`.
3. You may build (code, tests, fixtures, data) **only** for the current phase. Reading later phases
   to plan ahead is allowed; building anything for them is not.
4. Before any other work, write one short paragraph to the human: the current phase, what is done,
   what is next, and anything blocked on them.
5. At the end of every session, update the phase's progress notes in `STATUS.md`: what passed (with
   evidence), what is left, what is blocked.

---

## 1. Role and mission

You are the lead engineer of AutoFill Assistant, a Chrome extension that keeps a person's details
and documents encrypted on their own computer, reads their documents on the device, and fills
forms while the person watches and approves.

**Mission:** make it the best form filler there is — for any form, portal or website — while every
document and every personal value stays on the user's computer.

"Best" is a measured claim, never an asserted one. It means, on real forms: zero confidently wrong
fields, the highest share of fields filled correctly, values that stick, no portal error left
unanswered, and fast enough on a budget laptop. Phase U0 builds the measurement; every later phase
is judged by it.

### The honest starting point (product review, October 2026)

Strengths to protect: documents are read on the device; Indian portals, uploads and document fitting
are handled well; IFSC and PIN codes are checked against official lists shipped in the package; the
review screen and submit guard put the user in control.

Weaknesses this plan exists to fix:

1. It is an excellent tool for Indian student documents, and not yet a general form filler: its
   vault, vocabulary and test portals are built around scholarships, entrance exams and marks cards.
2. Its accuracy is an anecdote: measured on one person's six documents and on pages the team wrote.
3. Its fallback undercuts the pitch: unknown fields go to Anthropic's API with a key the user must
   bring.
4. It is heavy and slow: a 120 MB install, and 2–7 seconds to read a page on a CPU.
5. It never reads the portal's own error messages after filling.
6. Its reachable users are fewer than they look: Chrome on Android has no extensions, and the rule
   of one person, one vault rightly rules out cyber-café operators.
7. Nobody knows it exists: no store listing, placeholder install links.

---

## 2. Words used in this prompt

| Term | Meaning |
|---|---|
| **MUST / MUST NOT** | Non-negotiable. One unmet MUST fails the phase's gate. |
| **SHOULD** | Do it after the MUSTs, or record why not. Never blocks a gate. |
| **Exit goal** | A measured, non-negotiable target at the end of a phase. PASS needs evidence. |
| **Evidence** | A named test that passes (file and test name), a command with its exit code and the output lines that prove the point, a benchmark JSON with the numbers, or a screenshot path. "Implemented", "should work" and "looks right" are never evidence. |
| **HUMAN** | A step only the human can take: an account, a decision, a review, real-portal access, volunteers. Prepare everything for it, then mark it `BLOCKED-HUMAN` with exactly what is needed. |
| **Reference machine** | The computer speed budgets are measured on, as recorded in `GATES.md`. Until the human records one: 4 CPU cores, 8 GB RAM, integrated graphics, Windows 11, current stable Chrome. |
| **Real values** | Anything from the user's own documents or vault: names, numbers, addresses, branch codes, dates, places. |
| **Corpus** | The structure-only snapshots of real forms built in U0, split into a *tune* set and a *held-out* set. |
| **Protected metrics** | The numbers defined in U0 that no later phase may make worse (§5.7). |

---

## 3. Order of authority

1. The human's explicit instruction in the current conversation.
2. `CLAUDE.md` — its hard rules and the product principles P1–P6.
3. This file.
4. `IMPLEMENTATION_PLAN.md` and `COMPLETION_PLAN.md`.

If this file conflicts with `CLAUDE.md`, `CLAUDE.md` wins: stop and flag the conflict. If anyone asks
for something that breaks a non-negotiable in §4, stop and flag it rather than implementing it.

---

## 4. Non-negotiables — every phase, every change

**At the start of each phase, restate N1–N13 in that phase's plan in your own words, with how this
phase's work could break each one and how you will prevent it.**

- **N1 — Documents never leave the device.** No document bytes, page images, recognised text,
  filenames, vault values, or anything derived from them in any network request, log, error report
  or analytics. There is no analytics, telemetry, crash reporting or remote configuration.
- **N2 — No AI or chatbot that needs a server**, anywhere in the product. The existing Anthropic
  fallback is frozen: never extend it. U5 retires it.
- **N3 — Product principles P1–P6** (`CLAUDE.md`): the user is present; never auto-submit; raw PII
  never leaves the device; never defeat a security control (CAPTCHA, OTP and e-sign stay the
  user's); every run is auditable; one person, one vault — no multi-profile, bulk or queued
  submissions, ever.
- **N4 — Hard rules 1–5** (`CLAUDE.md`): a submit or final-action element is clicked only in
  `submit-guard.ts` with a valid approval token; the LLM payload boundary (`redaction.ts` →
  `value-guard.ts` → `llm-client.ts`) holds until U5 removes it; `blockers.ts` never reads a
  control; selectors live in versioned JSON (site profiles, playbooks, and from U2 widget profiles),
  never hard-coded in TypeScript; every new field-matching rule gets a fixture test.
- **N5 — Nothing is fetched at run time.** Models and data are fetched at build time, pinned by
  SHA-256 and shipped in the package. Only a phase that explicitly allows it may change this, with
  the human's written approval, and with the release gates updated in the same change.
- **N6 — Real values never enter the repository**: not in code, tests, fixtures, comments, docs,
  commit messages or snapshots. Describe a misread ("four noughts read as three"); never quote it.
  Real documents are measured only in the git-ignored local bench (U0). Run the values scan before
  every gate.
- **N7 — Test-first** for `matching/`, `documents/`, `runtime/machine.ts` and `vault/crypto.ts`,
  as small pure functions unit-tested without a browser. Bus messages are default-deny in
  `shared/validate.ts`, with valid and hostile examples in `validate-adversarial.test.ts`, and
  privileged unless justified in `sender-checks.test.ts`. The taxonomy is append-only.
- **N8 — Measure, then ship.** Any change to the reader, a model, a threshold or the matcher is
  measured on the bench (and on real documents in the local bench when the reader changes) before
  it is wired in. It ships only if no protected metric gets worse. Record what was measured and not
  shipped in `STATUS.md`.
- **N9 — Only a checksum pre-ticks a row.** A value from a list, a model or a repair says where it
  came from, and is never written over what the user typed or the page printed without saying so.
  The user ticks, the user approves, the user submits.
- **N10 — Never weaken anything to pass.** Never lower a threshold or tolerance, delete, skip or
  `.only` a test, hard-code an expected output, mock what a goal says to measure, special-case a
  fixture in product code, or widen an exit goal. If a goal cannot be met, keep working or stop and
  report.
- **N11 — Git discipline.** Commit and push only when the human says "commit". One phase per
  branch: `phase/u<n>-<slug>`. Follow the repository's commit conventions.
- **N12 — Words.** UI and store copy never use "automatic", "automated", "bot" or "bulk".
- **N13 — Licences.** New dependencies, models and data sets carry a permissive licence only
  (MIT, Apache-2.0, BSD, ISC, CC0, CC-BY, or GODL-India with credit), are recorded in
  `release-gates.test.ts` and `docs/STORE_LISTING.md`, and `npm audit --omit=dev` stays clean.

---

## 5. The gate protocol

**5.1 Order.** Phases run strictly in order: U0 → U1 → U2 → … → U11. Each depends on the ones before.

**5.2 No skipping.** You may not write code, tests, fixtures or data for phase N+1 until `GATES.md`
shows phase N as `APPROVED`.

**5.3 Reaching the gate.** A phase is ready for its gate when every MUST is done and every exit goal
is measured. Then run the full gate (§5.5), write the gate report (§5.6) into `STATUS.md`, set the
phase in `GATES.md` to `GATE-PASSED` or `GATE-FAILED`, and **stop**. Start nothing else in that
session.

**5.4 Only the human approves or waives.** The human moves a phase to `APPROVED` by writing
`Approve U<n>`. Only the human can waive an exit goal, by writing `Waive U<n>.G<k>: <reason>`;
record the waiver in the report and in `GATES.md`. You never approve or waive your own gate, and
you never suggest a waiver to save effort.

**5.5 The full gate — every phase, all must pass:**

| Check | Command or test | Pass condition |
|---|---|---|
| Types | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| Unit tests | `npm test` | exit 0; no test skipped or removed in this phase |
| Build | `npm run build` (includes `verify-dist`) | exit 0 |
| Browser tests | `npm run e2e` | exit 0, no retries |
| Flakiness | every e2e test added or changed in this phase | 20 consecutive passes |
| Dependencies | `npm audit --omit=dev` | 0 vulnerabilities |
| Benchmark | `npm run bench` (from U0) | protected metrics within tolerance (§5.7) |
| Real values | `npm run scan-values` (from U0) | nothing found in the tree or in git history |
| Network | release-gate tests (network allow-list from U4) | pass |

**5.6 The gate report**, appended to `STATUS.md` under the phase's heading:

```
## Gate report — U<n> <name> — <date>
Branch: phase/u<n>-<slug> · Commit: <sha, or "uncommitted">

### Non-negotiables
| N | How this phase could have broken it | Status | Evidence |

### MUST
| ID | Requirement (short) | Status | Evidence |

### Exit goals
| ID | Target | Measured | Status | Evidence |

### Protected metrics against the baseline
| Metric | Baseline | Now | Tolerance | Status |

### Full gate
| Check | Command | Exit code | Proof line |

### SHOULD
| ID | Done, or deferred and why |

### Measured and not shipped
### Risks and "not yet"
### Waivers (written by the human only)

### Verdict
GATE-PASSED — waiting for "Approve U<n>"
  or GATE-FAILED — <what remains>
  or BLOCKED-HUMAN — <exactly what is needed, from whom>
```

Status values in the report: `PASS`, `FAIL`, `BLOCKED-HUMAN`. There is no amber. A `BLOCKED-HUMAN`
row is acceptable at a gate only where the phase says so.

**5.7 Protected metrics and the ratchet.** U0 defines the metrics and records the baseline in
`bench/baseline.json`. Every gate re-runs the bench. After the human approves a phase, update the
baseline to the new numbers; the baseline only ever moves in the good direction.

| Metric | Tolerance |
|---|---|
| High-confidence (≥0.85) mismatches | must be **0** — absolute |
| Fields mapped correctly, per category | no drop greater than 1 percentage point |
| Fill-stick (value present and unchanged after the page settles) | no drop |
| Portal errors left after filling (from U1) | no rise |
| Document field accuracy (local bench) | no drop |
| Median time per form, per document page | no rise greater than 10% |
| Install size | no rise beyond the budget in `GATES.md` (before U8: no rise above 5 MB without the human's approval) |

**5.8 The stuck rule.** If a MUST still fails after three genuinely different approaches, stop and
write a decision memo in `STATUS.md`: what was tried, the measurements, two or three options with
their costs, and your recommendation. Wait for the human.

**5.9 Scope.** Work outside the current phase is allowed only to fix a regression this phase caused,
or a security or privacy defect — fix those at once and report them.

**5.10 Never mark something `BLOCKED-HUMAN` to avoid work.** It is only for steps no code can take.

---

## 6. The loop inside every phase

1. **Plan.** Write the phase plan in `STATUS.md`: the N1–N13 restatement (§4), the tests and
   fixtures you will write, the measurements, the risks.
2. **Fixtures and failing tests first** (N7). Run them and show them failing.
3. **Build in small steps.** Run the relevant tests after each step.
4. **Measure** on the bench, and on the local document bench whenever the reader or a model changes.
5. **Document.** A `STATUS.md` section in the existing style (a "Now | Where | Proof" table,
   "Measured and not shipped", "Not yet"); `CLAUDE.md` "Where things live"; `docs/PRIVACY.md` and
   `docs/STORE_LISTING.md` whenever behaviour, data or permissions change; `docs/THREAT_MODEL.md`
   whenever an attack surface changes; `fixtures/README.md` for every new fixture.
6. **Gate.** Run the full gate, write the report, set `GATES.md`, stop.

---

## 7. Where each weakness is answered

| Weakness (§1) | Answered in |
|---|---|
| 1. Not yet a general form filler | U2, U5, U6, U10 |
| 2. Accuracy is an anecdote | U0 (and every gate after it) |
| 3. Fallback undercuts the pitch | U5 |
| 4. Heavy and slow | U8 |
| 5. Never reads the portal's errors | U1 |
| 6. Reachable users fewer than they look | U11 (positioning); §9 (deferred on purpose) |
| 7. Nobody knows it exists | U4, U11 |
| "No benchmark, no claim" | U0 |
| "Launch at application time" | U11 |
| "Be honest about pricing" | U11 |

---

## 8. The phases

### U0 — Ground truth: measure before building anything

**Size:** M · **Answers:** weakness 2, "No benchmark, no claim"

**Goal.** Replace one person's documents and self-written fixtures with a measured baseline on real
forms, and make every later gate measurable.

**Read first:** `src/matching/eval.test.ts`, `src/matching/bench.test.ts`, `fixtures/heldout-*`,
`src/content/harvester.ts`, `src/background/redaction.ts`, `src/background/value-guard.ts`,
`scripts/verify-dist.mjs`, `docs/portal-notes/`, the latest `STATUS.md` sections.

**Entry:** none. U0 is first.

**MUST**

- [ ] **U0.M1 Snapshot tool.** A developer-only capture tool, absent from the store build (a build
      flag stripped by Vite, asserted by `verify-dist`), that saves the current form as a
      structure-only snapshot: the harvester's field descriptors, labels, options, nearby text,
      section headings, attributes (`type`, `pattern`, `maxlength`, `autocomplete`, `name`, `id`),
      validation attributes and widget structure. Every value, filled input, cookie, token and URL
      query string is removed. A test captures a page pre-filled with canary values and finds none
      of them in the snapshot.
- [ ] **U0.M2 Corpus.** `fixtures/corpus/` with **at least 100** snapshots, meeting every category
      minimum in the table below. Each snapshot records its category, technology stack, capture
      date, public page origin, and whether it needed a login. Pages behind a login are captured
      **only by the human**, on their own account, through the snapshot tool (HUMAN). Record a
      terms-of-service verdict for each site or site family in `docs/portal-notes/` before its
      snapshot is committed.

| Corpus category (U0.M2) | Minimum snapshots |
|---|---|
| Indian scholarships and welfare schemes | 25 |
| Entrance exams and admissions | 20 |
| Banking, KYC and insurance | 10 |
| Job applications (ATS) | 15 |
| Passport, visa and travel | 5 |
| Everyday web forms (sign-up, checkout, contact, address) | 15 |
| Form builders (Google Forms, Microsoft Forms, Typeform-style) | 5 |
| Legacy stacks (ASP.NET WebForms, PHP, jQuery) | 5 |

- [ ] **U0.M3 Ground truth.** Every field in every snapshot carries its expected key in
      `data-expect` — or `unknown` for a field nothing should fill, as the existing fixtures mark it. Label it twice: a first pass, then a second pass from the label and context
      alone without looking at the first answer; resolve every disagreement in a notes column.
      Fields that are genuinely ambiguous are marked `ambiguous`, excluded from accuracy and counted
      separately.
- [ ] **U0.M4 Splits before tuning.** Split the corpus 60/40 into *tune* and *held-out*, stratified
      by category, and write the split to `bench/split.json` before any tuning. Held-out snapshots
      are only ever measured: never used to choose a rule, synonym, threshold or description.
- [ ] **U0.M5 `npm run bench`.** Renders each snapshot as a live page in the e2e harness, runs
      harvest → match → fill with a made-up vault, and reports, per category and overall: fields,
      mapped correctly, unmapped, high-confidence mismatches (count, and every one listed), fill-stick,
      and time per form (median and p95). Output `bench/results.json` (numbers only) plus a readable
      summary. Deterministic (two runs give identical results), no network (asserted), under 15
      minutes.
- [ ] **U0.M6 No cheating possible.** A test asserts that no product code under `src/` reads
      `data-expect` or refers to a fixture path.
- [ ] **U0.M7 Durable document bench.** A runner in the repository (`scripts/doc-bench.mjs`) reads
      documents and answer keys from a git-ignored `.private/bench/` folder (in `.gitignore`;
      a test asserts it is absent from the package and from git) and reports per document and per
      field type: right, wrong, missing — numbers only. The human moves the existing scratchpad
      bench into it on their own machine (HUMAN).
- [ ] **U0.M8 Self-test for volunteers.** A panel action, "Check how well it reads my documents",
      runs the reader on the user's own saved documents against answers the user confirms on screen,
      and shows a score report containing only field types and counts — never a value — for the
      user to copy and send themselves. Zero network (test). A test seeds canary values and finds
      none in the report.
- [ ] **U0.M9 Durable real-values scan.** `npm run scan-values` (`scripts/scan-values.mjs`) reads
      the values to look for from a git-ignored `.private/values.txt`, scans the working tree and
      the full git history, and exits non-zero on any find. A test adds a planted value and sees it
      fail. The human seeds `.private/values.txt` (HUMAN).
- [ ] **U0.M10 Baseline.** `bench/baseline.json` holds the numbers from M5 and M7 (numbers only); the
      protected metrics and tolerances (§5.7) are written in `bench/README.md` and copied into
      `GATES.md`.
- [ ] **U0.M11 Honest report.** A `STATUS.md` section with the baseline by category, the weak
      categories included, and the 20 most common failure patterns with counts (which kinds of
      fields, labels and controls fail). This becomes the backlog for U1, U2 and U5.

**SHOULD**

- [ ] **U0.S1** Capture a sample of snapshots twice, a month apart, to measure how fast portals drift.
- [ ] **U0.S2** Measure the existing Anthropic path on the held-out split — only if the human
      provides a key and approves sending structure-only snapshots (HUMAN). Gives U5.G1 a second
      target.

**MUST NOT:** tune the matcher, synonyms or thresholds in U0; capture any value; commit a snapshot
from a logged-in page without the human's review; let the bench touch the network.

**Exit goals**

| ID | Goal | Target | Evidence |
|---|---|---|---|
| U0.G1 | Corpus size | ≥100 snapshots, every category minimum met (`BLOCKED-HUMAN` allowed only for login-only shortfalls, listed) | count script output |
| U0.G2 | Ground truth | every field labelled; every second-pass disagreement resolved | labelling report |
| U0.G3 | Privacy of measurement | 0 canary values in snapshots, document-bench reports and self-test reports | tests |
| U0.G4 | Bench works | exits 0, deterministic, no network, under 15 minutes | two runs' outputs |
| U0.G5 | Bench catches mistakes | a test that plants a wrong mapping sees the bench report it | test |
| U0.G6 | Baseline recorded | `bench/baseline.json`, `GATES.md`, `STATUS.md` all agree | files |
| U0.G7 | Values scan works | exit 0 on tree and history; exit 1 on a planted value | test |

---

### U1 — Read the portal's errors and fix them first

**Size:** M · **Answers:** review improvement #3, weakness 5

**Goal.** Values fit each field's rules before they are written, and after filling, no portal error
is left unread or unanswered.

**Read first:** `src/content/fill-field.ts`, `src/content/filler.ts`, `src/content/fill-run.ts`,
`src/matching/date-format.ts`, `src/matching/traits.ts`, `src/vault/validation.ts`,
`src/background/review-service.ts`, the review screen, U0's failure patterns.

**Entry:** U0 `APPROVED`.

**MUST**

- [ ] **U1.M1 Field rules** (pure, test-first, `src/matching/field-rules.ts`): each field's rules
      from `type`, `pattern`, `minlength`/`maxlength`, `min`/`max`, `step`, `inputmode`, `required`,
      `autocomplete`, the placeholder, and label or help-text hints in English and Hindi at least —
      capitals or block letters, no special characters, alphabets only, without dots or initials,
      digits only, date formats (DD-MM-YYYY, DD/MM/YYYY, YYYY-MM-DD, DD-MMM-YYYY), length hints
      ("maximum 30 characters"), and `as in <document>` / `as per <document>` (recorded for U3). Every rule
      records where it came from.
- [ ] **U1.M2 Fitting** (pure): `fit(value, rules)` returns the fitted value and a list of changes,
      each either lossless (case, separators, date format, spacing, a `+91` prefix) or lossy
      (dropping characters, abbreviating, shortening). Lossless changes are applied and listed on the
      review screen. Lossy changes are never applied without the user's click: the review shows the
      original, the fitted value and the reason. Silent truncation is impossible (a property test
      over 10,000 generated values).
- [ ] **U1.M3 Reading errors without clicking.** After a field is filled, fire what a person leaving
      the field fires (`focusout`/`blur`), then read: `validity` and `validationMessage`;
      `aria-invalid`; the elements named by `aria-errormessage` and `aria-describedby`; `role="alert"`
      and `aria-live` regions that changed after the fill; and error elements named in the site's
      playbook JSON. Generic detection uses only these semantic signals — no hard-coded class
      selectors (hard rule 4).
- [ ] **U1.M4 Errors after a postback.** When a page reloads with server-side errors (ASP.NET, PHP),
      tie each message to its field by ARIA relations and position, and read again.
- [ ] **U1.M5 Interpreting** (pure, test-first, `src/matching/portal-errors.ts`): turn a message into
      a rule — required, length, format, allowed characters, range, must match another field,
      already registered — through a data-driven grammar (JSON) in English and Hindi, so new
      phrasings are data, not code. An unknown message is shown word for word beside its field and
      never guessed at.
- [ ] **U1.M6 Repair on the review screen:** `The portal says '…'. Change '<value>' to '<fixed>'?`
      One click writes through `fill-field.ts`, re-checks and records the outcome. A repair changes
      this form only; saving the fitted version to the vault is a separate, explicit choice. Every
      repair is in the audit log, without values for high-sensitivity keys.
- [ ] **U1.M7 Fixtures:** at least 20 validator pages — HTML5 constraint validation; jQuery
      Validate; ASP.NET validators and server-side errors after a postback; React Hook Form or
      Formik-style ARIA errors; Angular reactive-form errors; an error that appears only after an
      Ajax check; Hindi messages; must-match fields (confirm email or mobile); capitals-only and
      date-format fields; a short `maxlength` address; a generic "Invalid input". Each fixture's
      `data-expect` records the final valid value and the expected interpretation.
- [ ] **U1.M8 The guard stays shut.** A fixture whose blur handler calls `form.submit()` stays
      blocked by the submit guard, 20 runs in 20.

**SHOULD**

- [ ] **U1.S1** Accepted repairs are stored as playbook rules for U6.
- [ ] **U1.S2** Error grammars for Kannada, Tamil and Telugu.
- [ ] **U1.S3** The review screen lists unresolved errors first.

**MUST NOT:** submit, or press any button to trigger validation; hard-code a site's selectors; guess
at an unknown message; apply a lossy change without the user's click; change a vault value without
the user's explicit choice.

**Exit goals**

| ID | Goal | Target | Evidence |
|---|---|---|---|
| U1.G1 | No error left | on every validator fixture, after filling and accepted repairs: 0 invalid fields and 0 unshown messages | e2e |
| U1.G2 | Interpretation | ≥90% of fixture messages interpreted correctly; **0** interpretations that would change a value wrongly | unit and e2e |
| U1.G3 | No silent loss | 100% of lossy changes flagged | property test |
| U1.G4 | Rules on real forms | fitted values satisfy every machine-readable rule on the corpus: ≥98% | bench |
| U1.G5 | New protected metric | "portal errors left after filling" measured on the corpus and added to the baseline | bench |
| U1.G6 | Guard intact | the blur-submit fixture is blocked 20/20 | e2e |
| U1.G7 | No regression | protected metrics within tolerance | bench |

---

### U2 — Every form control a real portal uses

**Size:** L · **Answers:** review improvement #1, weakness 1

**Goal.** Every common control can be filled, and every write is confirmed to have stuck.

**Read first:** `src/content/choice-widgets.ts`, `src/content/fill-field.ts`,
`src/content/filler.ts`, `src/content/fill-run.ts`, `src/content/harvester.ts`,
`src/content/upload-slots.ts`, `src/content/submit-guard.ts`,
`src/background/harvest-service.ts`, `manifest.config.ts`, `src/shared/release-gates.test.ts`,
U0's failure patterns.

**Entry:** U1 `APPROVED`.

**MUST**

- [ ] **U2.M1 Adapter interface** (`src/content/widgets/`): `detect(element)` returns a match and a
      confidence; `write(element, value, plan)` returns the result; `read(element)` returns the
      current value. Each adapter's DOM signatures live in versioned JSON (widget profiles), loaded
      like site profiles — never hard-coded in TypeScript (hard rule 4).
- [ ] **U2.M2 One typing utility** for every text write: focus; `keydown`/`beforeinput`/`input`/`keyup`
      per character where a framework needs it; the native value setter with `input` and `change`
      where it does not; composition-safe. Tested against React, Angular and Vue controlled inputs.
- [ ] **U2.M3 Adapters** — every one in the table below — each with a fixture page built from the
      real library (vendored locally with its licence; fixtures never load from a CDN) and its own
      e2e test.

| Kind of control (U2.M3) | Adapters |
|---|---|
| Choices | native select, radios and checkboxes, ARIA listbox and radiogroup (existing — regression tests) |
| Type-ahead | ARIA 1.2 combobox with options loaded after typing; Select2; Chosen; React-Select; Material UI Autocomplete and Select; Angular Material select and autocomplete; Ant Design Select; jQuery UI autocomplete |
| Dates | native date and time inputs; masked text dates; calendar-only pickers (jQuery UI datepicker, flatpickr, MUI DatePicker, Angular Material datepicker) |
| Masks | Aadhaar in groups of four, `+91` mobile, PIN, uppercase IFSC and PAN |
| Others | multi-select chips and tags, number steppers, `contenteditable` fields |
| Flow | dependent dropdowns (existing — regression test), fields revealed by a choice |

- [ ] **U2.M4 Choosing** among options always goes through `choose-option.ts`; `sure: false` still
      asks the review.
- [ ] **U2.M5 Dates:** type in the format the box asks for (`dateAsAsked`); drive the calendar only
      when typing is refused; read the input back to confirm the date.
- [ ] **U2.M6 Confirm every write.** After the page settles, read the value back through the adapter.
      A mismatch gets one retry with the adapter's alternate strategy, then a "didn't stick" flag on
      the review screen. Fill-stick is reported per adapter.
- [ ] **U2.M7 One way to wait:** mutation-settle with an upper bound. No bare timers anywhere in the
      fill path (enforced by a lint rule or a grep test). Resume only on the user's signal or a
      settled page — never a bare timer.
- [ ] **U2.M8 Frames and shadow DOM.** Open shadow roots are traversed by the harvester and the
      filler; closed roots are reported as unreachable on the review screen. When a form sits in a
      cross-origin iframe, ask for that origin as an optional host permission at that moment, in
      plain words. The permission-budget release gate is updated deliberately — optional host
      permissions only; never `<all_urls>`, which the gate keeps refusing.
- [ ] **U2.M9 Fill planner:** orders writes by dependency (dependent dropdowns, fields revealed by a
      choice), re-harvests after the page changes, and never writes a field before its parent has
      settled.
- [ ] **U2.M10 Presses stay guarded.** Every press goes through a guarded press that refuses anything
      submit-ish (the existing `pressChoice` rules). A test counts programmatic clicks per run and
      asserts none landed on a submit-ish element.

**SHOULD**

- [ ] **U2.S1** Adapters record the library version they saw, for playbooks.
- [ ] **U2.S2** A 50-field fixture form filled in ≤3 seconds including waits.
- [ ] **U2.S3** Rich-text editors (Quill, TinyMCE) for free-text fields.

**MUST NOT:** click anything submit-ish; use bare timers; add `<all_urls>`; run scripts in the page's
own JavaScript world unless a control can be driven no other way — and then only with a design note
and the human's approval; grow `content.js` beyond the size budget recorded in `GATES.md`.

**Exit goals**

| ID | Goal | Target | Evidence |
|---|---|---|---|
| U2.G1 | Coverage | ≥30 widget fixtures; every adapter in M3 covered | e2e list |
| U2.G2 | Reliability | each widget e2e passes 20 consecutive runs | flake runner output |
| U2.G3 | Fill-stick | ≥98% of writes confirmed on widget fixtures; ≥95% on the corpus | e2e and bench |
| U2.G4 | Safety | 0 programmatic clicks on submit-ish elements across the whole e2e suite | click counter |
| U2.G5 | Permissions | release gates pass; no new required permission; optional host permission only on request | release-gate tests |
| U2.G6 | No regression | protected metrics; dependent-dropdown and postback fixtures still 20/20 | bench and e2e |

---

### U3 — Names "as per document", checked before submitting

**Size:** M · **Answers:** review improvement #4

**Goal.** Fill identity in the form each question asks for, and catch mismatches between what is
typed and the documents being sent — and stale certificates — before the user approves.

**Read first:** `src/matching/frame.ts`, `src/matching/qualifications.ts`,
`src/documents/extract*.ts` (names, dates of issue, seals), `src/ui/vault-editor/ExtractedDetails.tsx`
(the save path), `src/vault/profile-store.ts`, `src/background/review-service.ts`,
`src/background/approval-service.ts`, `src/documents/field-constraint.ts`, the review screen.

**Entry:** U2 `APPROVED`.

**MUST**

- [ ] **U3.M1 Variants.** The vault keeps each document's spelling of the name, father's and mother's
      names, date of birth, gender and address as a variant linked to that document, sealed like
      every other value. A variant is captured only when the user saves ticked values from a reading,
      or types one by hand. Existing vaults migrate; backups carry variants. The storage design is
      reviewed against N1, N6 and the vault's encryption in the phase plan.
- [ ] **U3.M2 "As per" questions.** `frame.ts` reads `as per <document>`, `as in <document>`,
      `as printed in <document>` and `according to <document>` — SSLC, 10th or marks card; 12th or
      PUC; Aadhaar; PAN; passport; bank passbook or account; caste or income certificate; degree — in
      English and Hindi, and fills that document's variant. With no variant saved, it fills the
      canonical value and flags the row: `no <document> spelling saved`.
- [ ] **U3.M3 Comparing names** (pure, test-first, `src/documents/identity-compare.ts`) classifies
      two spellings as: same; formatting only (case, spaces, dots); initials against expanded names;
      a different order (surname or initial first); a spelling difference; or a different person.
      Indian naming patterns are covered with made-up names (for example "R ARJUN KUMAR", "ARJUN
      KUMAR R", "KUMAR R ARJUN KUMAR"), honorifics (Sri, Smt, Kum) and relation text ("S/O").
- [ ] **U3.M4 The check before submitting.** When a form uploads documents (`doc.*` fields), compare
      every typed identity value with those documents' variants. A spelling difference or a different
      person becomes an item the user must acknowledge on the review screen before the approval hold
      unlocks. Formatting-only differences are listed but do not need acknowledging. Nothing is ever
      corrected for the user.
- [ ] **U3.M5 Bank name check.** On forms with bank fields, compare the account holder's name with the
      applicant's name and warn on a mismatch — scholarship payments fail on it.
- [ ] **U3.M6 Certificate freshness.** Rules are versioned data (in the playbook format), each citing
      its official source and date — for example an income certificate's validity for a given scheme.
      A conservative default ("older than 12 months — check it is still accepted") says plainly that
      it is a default. Dates of issue come from extraction (seals included) or from the user.
- [ ] **U3.M7 Cut-offs on the page** (pure parser, test-first, English and Hindi): stated age limits
      (`as on <date>`), minimum marks or percentages, and category conditions, compared with vault
      values. Warn only when the parse is certain; otherwise say nothing.

**SHOULD**

- [ ] **U3.S1** Suggest the most common spelling as the canonical one — never automatically.
- [ ] **U3.S2** A vault health check: the date of birth agrees across every saved document.
- [ ] **U3.S3** Transliteration-aware comparison for names printed only in an Indian script.

**MUST NOT:** correct anything for the user; block submission (warnings and acknowledgements only);
present a default rule as a fact; store a variant the user did not tick.

**Exit goals**

| ID | Goal | Target | Evidence |
|---|---|---|---|
| U3.G1 | Catch rate | 100% of planted mismatches caught across ≥15 made-up cases (spelling, initials order, missing surname, day and month swapped, different person) | unit and e2e |
| U3.G2 | No false alarms | 0 must-acknowledge items across ≥25 formatting-only pairs | unit |
| U3.G3 | "As per" filling | corpus "as per" questions filled from the right variant: ≥95% | bench |
| U3.G4 | Honest rules | every shipped freshness rule cites a source; the default is labelled a default | data test |
| U3.G5 | People notice | three people, a planted mismatch between a typed name and an uploaded marks card: all three notice it before approving (HUMAN session; notes recorded) | session notes |
| U3.G6 | No regression | protected metrics within tolerance | bench |

---

### U4 — Privacy anyone can verify

**Size:** S, plus an external review · **Answers:** review improvement #10, weakness 7 (trust)

**Goal.** A sceptic can verify, without trusting the team, that nothing about the user leaves the
device.

**Read first:** `src/shared/release-gates.test.ts`, `manifest.config.ts`,
`src/background/llm-client.ts`, `src/background/redaction.ts`, `src/background/value-guard.ts`,
`docs/PRIVACY.md`, `docs/THREAT_MODEL.md`, `docs/ISOLATION_REVIEW.md`,
`tests/e2e/side-panel.ts` (the traffic watcher).

**Entry:** U3 `APPROVED`.

**MUST**

- [ ] **U4.M1 One door to the network.** Every request any extension context makes goes through
      `src/shared/net.ts` (allow-listed origins, a purpose label, a size). A lint rule and a
      release-gate test forbid `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`,
      `importScripts` and remote image or script URLs anywhere else in `src/`. The allow-list: the
      extension's own package, plus `api.anthropic.com` until U5 removes it.
- [ ] **U4.M2 Network view** in the panel, one click from the main screen: "Internet requests this
      session: 0", with the log of anything `net.ts` sent (origin, purpose, time, size — never
      content).
- [ ] **U4.M3 Offline proof in CI.** An e2e turns the network off and runs the whole flow — create a
      vault, save and read a document, fill a fixture form, reach the review — and passes.
- [ ] **U4.M4 Reproducible builds.** Pinned Node and package-manager versions, an enforced lockfile,
      no timestamps or absolute paths in the output. `npm run release:verify` builds twice in clean
      directories and compares the SHA-256 of every file and of the zip. A document explains how
      anyone checks a store package against the tagged source.
- [ ] **U4.M5 Clean history.** The values scan and a secrets scan (no keys or tokens) are clean across
      the working tree and the whole git history.
- [ ] **U4.M6 Review pack** for an independent security reviewer: a data-flow diagram, the updated
      threat model, the isolation review, every release gate and the test behind it, how to build
      and verify, and known limitations. The review itself is HUMAN and must be finished before U11's
      gate.
- [ ] **U4.M7 Plain-language privacy** for each feature in `docs/PRIVACY.md`: what is read, where it
      is processed, what is stored, what leaves (nothing), how to check — matched by the store
      listing.
- [ ] **U4.M8 Landing-page copy** built around "Turn off your Wi-Fi and read a document", with the
      steps to try it.

**SHOULD**

- [ ] **U4.S1** Open-source the repository, or at least everything that touches documents (licence
      choice: HUMAN).
- [ ] **U4.S2** Publish each release's hashes in a public changelog.
- [ ] **U4.S3** A responsible-disclosure policy.

**MUST NOT:** add analytics, telemetry, crash reporting, remote configuration or update checks of any
kind; weaken the CSP.

**Exit goals**

| ID | Goal | Target | Evidence |
|---|---|---|---|
| U4.G1 | One door | 0 network calls outside `net.ts`; allow-list = package (plus Anthropic until U5) | release-gate test |
| U4.G2 | Works offline | the offline e2e passes 20/20 | e2e |
| U4.G3 | Zero internet traffic | across the entire e2e suite the traffic watcher records 0 requests outside the package (the opt-in Anthropic tests excepted, until U5) | e2e |
| U4.G4 | Reproducible | two clean builds are byte-identical | `release:verify` output |
| U4.G5 | Clean history | values scan and secrets scan exit 0 | script output |
| U4.G6 | Review pack | complete, and read by the human | file list |

---

### U5 — Understand any label on the device; retire the API key

**Size:** L · **Answers:** review improvement #2, weakness 3

**Goal.** Map fields the rules have never seen, entirely on the device, at least as well as the
server fallback did — then remove the server path.

**Read first:** `src/matching/deterministic.ts`, `src/matching/index.ts`, `src/matching/frame.ts`,
`src/matching/llm-matcher.ts`, `src/background/llm-*.ts`, `src/background/redaction.ts`,
`src/documents/bilingual.ts`, `src/offscreen/reader-worker.ts`, `scripts/fetch-ocr-models.mjs`,
`src/shared/release-gates.test.ts`, `bench/split.json`.

**Entry:** U4 `APPROVED`.

**MUST**

- [ ] **U5.M1 Field descriptions.** A data file describing every taxonomy key in plain English: what
      it is, what it is not, example labels. A test asserts every key has one.
- [ ] **U5.M2 Semantic tier.** A small sentence-embedding model (MiniLM-class, permissive licence,
      quantised, fetched at build time and pinned by SHA-256 like the OCR models) runs in the
      existing worker — never in the content script (extend the `no-ocr-in-content` test to it). Key
      descriptions are embedded at build time and shipped as vectors. Each field's context (label,
      nearby text, section heading, options, `name`/`id` tokens) is embedded when filling. Labels in
      Indian scripts pass through `bilingual.ts` first.
- [ ] **U5.M3 Decision rule.** Accept a key only when its score is ≥ T, it beats the runner-up by
      ≥ M, and no trait vetoes it. Its confidence stays below auto-fill (flagged on review) until
      calibration shows otherwise. T and M are tuned on the tune split only.
- [ ] **U5.M4 Gemini Nano tier** (optional, detected). Where Chrome's built-in Prompt API is available
      to the extension and its model is ready, ask it only about fields the semantic tier left
      unsure, sending only the field's structure (the same redaction boundary), with output limited
      to the key list by a schema. Skip it silently where unavailable. Never use it for
      high-sensitivity auto-fill. Confirm the current API, its availability to extensions and its
      hardware requirements from Chrome's documentation, and cite the version in `STATUS.md`.
- [ ] **U5.M5 Order of tiers:** site profile → rules → semantic → Nano (if available) → unsure, with
      teach mode offered. A mapping a tier makes and the user keeps is written to the site profile,
      so each form is understood once.
- [ ] **U5.M6 Retirement.** When U5.G1–G3 pass, remove the Anthropic path completely:
      `llm-client.ts`, the LLM service, the key screen and its storage (existing keys deleted on
      update, with a note to the user), `api.anthropic.com` from `connect-src`; release gates require
      `connect-src 'self'` only; `net.ts` allows the package only; `PRIVACY.md` and
      `STORE_LISTING.md` updated. If the goals do not pass, leave the Anthropic path off by default
      and frozen, and stop for the human's decision.

**SHOULD**

- [ ] **U5.S1** Chrome's on-device Translator API for labels in Indian languages, where available.
- [ ] **U5.S2** A line on the review screen saying which tier mapped each field, and why.

**MUST NOT:** send a label or any form structure to any server once retired; fetch a model at run
time; tune on the held-out split; let a model pre-tick a row or auto-fill a high-sensitivity key.

**Exit goals**

| ID | Goal | Target | Evidence |
|---|---|---|---|
| U5.G1 | Held-out accuracy | mapped correctly on held-out ≥ the higher of: the deterministic-only baseline plus 10 points, and the Anthropic path's rate if U0.S2 measured it | bench |
| U5.G2 | Zero confident mistakes | 0 high-confidence mismatches on held-out and tune | bench |
| U5.G3 | Budget | model and vectors ≤ 30 MB; matching ≤ 300 ms p95 per form on the reference machine | `verify-dist` and bench |
| U5.G4 | No server | `connect-src` is exactly `'self'`; `net.ts` allows the package only | release-gate tests |
| U5.G5 | Wi-Fi off | the offline e2e maps an unseen fixture form through the semantic tier | e2e |
| U5.G6 | No regression | protected metrics within tolerance | bench |

---

### U6 — Portal playbooks

**Size:** ongoing; the first gate is at 50 portals · **Answers:** review improvement #6, weakness 1

**Goal.** What one user teaches can help every user, while nothing about any user travels.

**Read first:** `src/matching/profile-cache.ts`, `src/matching/learned-profiles.ts`,
`src/matching/teach.ts`, `src/matching/profile-transfer.ts`, `src/background/value-guard.ts`,
`src/background/teach-service.ts`, the site-profile JSON, `docs/portal-notes/`.

**Entry:** U5 `APPROVED`.

**MUST**

- [ ] **U6.M1 Playbook format:** versioned JSON with a schema validated on load — portal id, URL
      patterns, page fingerprints, field-to-key mappings, widget hints (U2), field rules and error
      phrasings (U1), document rules (sizes, formats, photo rules for U7), certificate freshness rules
      (U3), last-verified date, source. A schema test rejects any field that could hold a value.
- [ ] **U6.M2 Bundled, with the right precedence.** Playbooks ship inside the package. Precedence:
      what the user taught > the bundled playbook > the rules. Profiles refine, never replace; only a
      user-taught answer overrides.
- [ ] **U6.M3 Contribution without a network.** Teach mode exports a playbook file. The export screen
      shows its full contents in plain words. `value-guard.ts` and a canary test prove that no vault
      value of any sensitivity, no document filename and no URL query is inside. The user sends the
      file themselves.
- [ ] **U6.M4 Import tool** (developer side): validates the schema, scans for values, shows a diff
      against the bundled version, and never marks an import as taught.
- [ ] **U6.M5 Health.** Each bundled playbook has a snapshot (U0's tool) and a smoke e2e. The bench
      reports drift (the share of selectors still resolving). A stale playbook (under 60% resolving)
      is flagged in the panel and never half-fills.
- [ ] **U6.M6 The first 50.** A list of the 50 most-used Indian portals (scholarships, exams,
      admissions, government services), with sources for the ranking; each gets a playbook, a
      snapshot, a portal-notes verdict and a smoke test. Logged-in pages are captured by the human
      (HUMAN).

**SHOULD**

- [ ] **U6.S1** A downloadable catalogue later: the whole bundle fetched at once, so no server learns
      which portals anyone uses, and signature-verified — only with the human's written approval and a
      release-gate change (N5). Not part of this phase's MUSTs.
- [ ] **U6.S2** A changelog per playbook.

**MUST NOT:** any network path for contributions or updates; any value in a playbook; a playbook
overriding a user-taught mapping.

**Exit goals**

| ID | Goal | Target | Evidence |
|---|---|---|---|
| U6.G1 | 50 playbooks | 50 shipped, each smoke-tested 20/20 (`BLOCKED-HUMAN` allowed for login-only snapshots, listed) | e2e |
| U6.G2 | Nothing personal | canary vault: 0 canaries in 100 random exports; the schema rejects value fields | unit |
| U6.G3 | Accuracy with a playbook | mapped correctly ≥98% and 0 high-confidence mismatches on playbook portals | bench |
| U6.G4 | Drift is visible | a stale-playbook fixture is flagged and not half-filled | e2e |
| U6.G5 | No regression | protected metrics within tolerance | bench |

---

### U7 — Photo and signature studio

**Size:** M · **Answers:** review improvement #5

**Goal.** Photos and signatures pass each exam's rules the first time, prepared on the device.

**Read first:** `src/documents/derive.ts`, `src/documents/intake.ts`, `src/documents/scan.ts`,
`src/documents/seal.ts` (ink separation), `src/documents/field-constraint.ts`,
`src/background/document-service.ts`, the upload flows, `docs/portal-notes/`.

**Entry:** U6 `APPROVED`.

**MUST**

- [ ] **U7.M1 Rule packs** (data, in the playbook format), per exam or portal: photo size in pixels
      or centimetres, aspect, file-size window, format, background, the face's share of the height,
      the name-and-date strip when required (text, size, position), and signature size and colour.
      Each rule cites its official notification and date; a rule without a source is not shipped.
- [ ] **U7.M2 Face detection:** a tiny face-detection model (≤2 MB, permissive licence, pinned) in the
      worker, returning the face box and eye positions.
- [ ] **U7.M3 Photo pipeline:** crop to the required face share and aspect; check that the background
      is plain and bright, and whiten only a plain one; normalise exposure; add the name-and-date strip
      when a rule asks; fit the byte window with the existing derive pipeline.
- [ ] **U7.M4 Quality checks**, each with a plain sentence and a pass, warn or fail: face too small,
      too large or off-centre; head tilted; blur; glare on the face; background not plain; too dark or
      too bright; wrong aspect.
- [ ] **U7.M5 Signature pipeline:** separate ink from paper (reusing the seal and scan code), crop to
      the ink (`trimsToInk`), darken faint ink, whiten the background, fit the size.
- [ ] **U7.M6 Approval:** before and after side by side, with the checks. Nothing is uploaded or saved
      over the original without the user's approval. Uploads go only through the existing approved
      flows — fit and attach, the site's own upload window, the approved Upload press — and never
      sent by the extension itself.
- [ ] **U7.M7 Faces are never altered:** crops, background and exposure only — no smoothing,
      reshaping or beautifying. A test checks the face region for changes beyond exposure.

**SHOULD**

- [ ] **U7.S1** A background-matting model for complex backgrounds, within the size budget.
- [ ] **U7.S2** Presets for the ten most common exams.

**MUST NOT:** change facial features; upload anything without approval; ship an unsourced rule; put
any real person's photo in the repository — fixtures use consented, permissively licensed test images
with sources in `fixtures/README.md`; real photos are measured only in the local bench.

**Exit goals**

| ID | Goal | Target | Evidence |
|---|---|---|---|
| U7.G1 | Passes the exam's own checks | ≥95% of a ≥30-image consented test set pass each supported exam's client-side checks, reproduced in fixture portals | e2e and local bench |
| U7.G2 | Crop accuracy | face share and centring within tolerance: ≥95% | unit and bench |
| U7.G3 | Faces untouched | the face-region test passes for every image | unit |
| U7.G4 | Approval enforced | 0 uploads without approval | e2e counter |
| U7.G5 | Budget | the studio adds ≤5 MB; a photo is processed in ≤1.5 s on the reference machine | `verify-dist` and bench |

---

### U8 — Small and fast on a budget laptop

**Size:** M · **Answers:** review improvement #9, weakness 4

**Goal.** Install size and reading speed fit budget hardware, and the build enforces them so they
cannot drift back.

**Read first:** `scripts/verify-dist.mjs`, `scripts/fetch-ocr-models.mjs`, `vite.config.ts`,
`src/offscreen/reader-worker.ts`, `src/documents/preprocess.ts`, the `STATUS.md` sections on Stage 5
(what was measured and not shipped, and why).

**Entry:** U7 `APPROVED`.

**MUST**

- [ ] **U8.M1 Budgets enforced by the build:** core install ≤40 MB (or the number the human records in
      `GATES.md`); `content.js` within its budget; a standard passbook photo read in ≤2 s and a
      3-page scanned PDF in ≤6 s on the reference machine; matching and filling a 50-field form in
      ≤1 s, excluding the page's own waits. `verify-dist` fails the build on size; the bench fails the
      gate on time.
- [ ] **U8.M2 Packaging decision memo:** (a) companion extensions delivered by the Web Store that serve
      model files only to the core extension's ID; (b) optional downloads from the project's own
      origin, pinned by SHA-256, inbound only, with a `connect-src` change; (c) a lean and a full
      edition. Spike each enough to prove it works, recommend one, and stop for the human's choice
      (HUMAN). Then build the chosen option, with the release gates updated in the same change.
- [ ] **U8.M3 Lazy everywhere:** nothing loads until needed; models stay cached for the session; the
      reader warms up when the panel opens on a page with an upload or a document action.
- [ ] **U8.M4 Re-measure on the reference machine:** WebGPU (with CPU fallback), int8 and fp16 per
      model, thread counts. Each ships only with zero field changes on the document bench and the
      corpus.

**SHOULD**

- [ ] **U8.S1** Show values as they are read.
- [ ] **U8.S2** Measure on a weaker second machine (2 cores, 4 GB RAM).

**MUST NOT:** fetch anything at run time without the approved option and its release-gate change;
give up a single field to gain speed or size.

**Exit goals**

| ID | Goal | Target | Evidence |
|---|---|---|---|
| U8.G1 | Size | core install within budget; a test proves the build fails above it | `verify-dist` |
| U8.G2 | Speed | every time budget met on the reference machine | bench JSON |
| U8.G3 | Nothing lost | 0 field changes on the document bench and the corpus against pre-U8 | bench diff |
| U8.G4 | Packs work | without an optional pack: a clear message and everything else works; with it: it is used | e2e |

---

### U9 — Remember every application

**Size:** S · **Answers:** review improvement #8

**Goal.** Every application the user submits leaves a record they can find later: the numbers, the
receipt, what was sent.

**Read first:** `src/runtime/audit.ts`, `src/background/approval-service.ts`,
`src/content/submit-guard.ts`, `src/content/run-controller.ts`, `src/vault/document-store.ts`,
`src/background/settings-store.ts`, `src/vault/backup-format.ts`.

**Entry:** U8 `APPROVED`.

**MUST**

- [ ] **U9.M1 Reading confirmations** (pure parser, test-first, English and Hindi): after the user's
      approved submit in that tab, recognise a confirmation page and read application, registration
      and acknowledgement numbers, fee transaction IDs, amounts and dates. At least 15 confirmation
      fixtures, and at least 20 other pages that must yield nothing.
- [ ] **U9.M2 Offered, never automatic:** "Save this application?" showing what was found. Saved into
      an encrypted Applications list: portal, numbers, date, documents sent (from the audit log), and
      a screenshot of the confirmation page (captured under `activeTab`) sealed in the vault.
- [ ] **U9.M3 Applications view:** list, search, details; deadlines the user types; reminders when the
      panel opens; desktop notifications only if the user turns them on (an optional permission, with
      the release gates updated deliberately).
- [ ] **U9.M4** Backup and restore include applications; deleting an application deletes its
      screenshot.

**SHOULD**

- [ ] **U9.S1** Read a fee-receipt PDF the user saves into the vault.
- [ ] **U9.S2** A printable summary page of all applications.

**MUST NOT:** submit, navigate or click anything; run on a schedule (P1); send anything.

**Exit goals**

| ID | Goal | Target | Evidence |
|---|---|---|---|
| U9.G1 | Capture | numbers captured on ≥95% of confirmation fixtures; 0 captures on the other pages | unit and e2e |
| U9.G2 | Durable | a saved application survives a browser restart and a backup-and-restore | e2e |
| U9.G3 | Consent | nothing is saved without the user's click | e2e |
| U9.G4 | No regression | protected metrics within tolerance; no new network | bench and release gates |

---

### U10 — Jobs, KYC and travel

**Size:** L · **Answers:** review improvement #7, weakness 1

**Goal.** Fill the forms that come after the scholarship, starting with job applications for
final-year students.

**Read first:** `src/matching/taxonomy.ts`, `src/matching/traits.ts`, `src/matching/synonyms.json`,
`src/ui/lib/field-groups.ts`, `src/ui/lib/vault-shape.ts`, `src/matching/pathway.ts`,
`src/documents/pdf-text.ts`, `src/content/choice-widgets.ts` (the guarded press),
`docs/portal-notes/`.

**Entry:** U9 `APPROVED`.

**MUST**

- [ ] **U10.M1 New key families**, appended and never renamed, each with traits, synonyms,
      field-group labels and vault-shape gating: employment (employer, title, start, end, current,
      location, description), projects, skills, certifications, references, languages, links
      (LinkedIn, GitHub, portfolio), work authorisation and notice period; for KYC: nominee,
      occupation, income range; for travel: travel history and visa history (and passport details,
      if not already present).
- [ ] **U10.M2 "Always ask" keys.** Legal declarations — criminal record, politically exposed status,
      visa refusals, disability disclosure to an employer, consent boxes — are never filled from the
      vault; the review shows them for the user to answer. A test asserts no fill path writes them.
- [ ] **U10.M3 Repeatable sections:** recognise a repeatable group and its "Add another" control
      (from structure and playbook data), press it through the guarded press (allow-listed labels,
      never anything submit-ish), fill each instance in order, and confirm the instance count.
- [ ] **U10.M4 Résumé reading** (pure rules, test-first, no model): a résumé PDF's own text into
      employment, education, projects and skills, with at least 10 made-up résumés in different
      layouts as fixtures.
- [ ] **U10.M5 ATS snapshots:** at least 20 real job-application forms (Workday, Greenhouse, Lever,
      SmartRecruiters, iCIMS, Taleo, Naukri, campus placement portals), each with a portal-notes
      verdict. A site whose terms forbid it is not profiled.

**SHOULD**

- [ ] **U10.S1** KYC and passport playbooks for the five largest Indian banks and the passport portal.
- [ ] **U10.S2** DOCX résumés.

**MUST NOT:** write cover letters or any text that speaks for the user; answer a declaration for the
user; apply to many jobs in a queue (P1, P6); scrape job listings.

**Exit goals**

| ID | Goal | Target | Evidence |
|---|---|---|---|
| U10.G1 | ATS accuracy | ≥90% mapped correctly and 0 high-confidence mismatches on the 20 ATS snapshots | bench |
| U10.G2 | Repeatable sections | correct instance counts and values on ≥5 fixtures, 20/20 | e2e |
| U10.G3 | Résumés | ≥90% of résumé fixture fields right | unit |
| U10.G4 | Declarations untouched | 0 declarations written by any fill path | test |
| U10.G5 | No regression | protected metrics within tolerance; student flows unchanged | bench and e2e |

---

### U11 — Launch readiness

**Size:** M, plus HUMAN steps · **Answers:** weaknesses 6 and 7, "Launch at application time",
"Be honest about pricing"

**Goal.** Hand the product to strangers responsibly, with published numbers and verified claims.

**Read first:** `docs/STORE_LISTING.md`, `docs/PRIVACY.md`, the landing page source (move it into the
repository first if it is not there), `COMPLETION_PLAN.md` Phase F, every gate report.

**Entry:** U10 `APPROVED`.

**MUST**

- [ ] **U11.M1 Full regression:** every earlier exit goal re-run on the release candidate; all PASS.
- [ ] **U11.M2 Published numbers:** the bench and self-test results (numbers only), with the method
      and its limits ("measured on N real forms in these categories"), in the README and on the
      landing page.
- [ ] **U11.M3 Store listing and permission justifications** updated for everything U1–U10 changed; a
      test refuses the banned words (N12); screenshots show the review screen and the stop at a
      CAPTCHA.
- [ ] **U11.M4 Landing page:** real install links (supplied by the human), the "Wi-Fi off" demo,
      honest limitations (desktop Chrome only, no Android, one person per vault), the privacy page,
      the published numbers.
- [ ] **U11.M5 Offline licence** — only if the human chooses paid features (HUMAN decides pricing
      and which features). A licence is a signed token (Ed25519) verified on the device against an
      embedded public key: entitlements and expiry only, no personal data, no network. Tests reject
      forged, tampered and expired tokens. Free features never depend on a licence.
- [ ] **U11.M6 Volunteer kit:** instructions, the U0.M8 self-test, and a way for volunteers to send
      their score report themselves (they copy and send it; the extension sends nothing). The human
      gathers the results (HUMAN).
- [ ] **U11.M7 Launch plan for the human:** timed to an application season; outreach to colleges and
      coaching institutes (each student installs their own copy — P6); a support channel; a rollback
      plan.
- [ ] **U11.M8** The external security review (U4.M6) is finished (HUMAN), and every finding is fixed
      or accepted in writing.

**SHOULD**

- [ ] **U11.S1** A Microsoft Edge Add-ons listing of the same package.
- [ ] **U11.S2** Revisit `docs/FIREFOX_PORT.md` for desktop and Android reach.

**MUST NOT:** add telemetry to measure the launch; check licences on a server; use dark patterns or
false urgency; make any claim the bench does not support.

**Exit goals**

| ID | Goal | Target | Evidence |
|---|---|---|---|
| U11.G1 | Everything green | every earlier exit goal PASS on the release candidate | re-run reports |
| U11.G2 | Claims match numbers | every number on the landing page and listing traces to `bench/results.json` | test |
| U11.G3 | Licence safe | licence tests pass; the free path works with no licence | unit and e2e |
| U11.G4 | Reviewed | external review finished, findings closed (HUMAN) | review report |
| U11.G5 | Ready to ship | reproducible release zip; values scan clean; the human signs off | `release:verify`, scan, sign-off |

---

## 9. Deferred on purpose

- **Android.** Chrome on Android has no extensions; a Firefox port (`docs/FIREFOX_PORT.md`) is the
  route, after this plan.
- **Operators who fill forms for others** (cyber cafés, service centres). Forbidden by P6. Never.
- **Writing for the user** — cover letters, statements of purpose, essays. It speaks for the person,
  and would need a model; never through a server.
- **Accounts, sync, analytics or any server-side feature.** Out.

---

## 10. `GATES.md` — the ledger

`GATES.md` records, and only the human changes `APPROVED` or a waiver in it:

- the reference machine and the budgets (install size, `content.js`, time);
- the baseline numbers once U0 passes;
- one row per phase: status, gate-report link, approval, waivers.

Statuses: `NOT-STARTED`, `IN-PROGRESS`, `GATE-PASSED` (waiting for approval), `GATE-FAILED`,
`BLOCKED-HUMAN`, `APPROVED`.

---

## 11. What the human types

| To | Type |
|---|---|
| Start or continue | `Read MASTER_PROMPT.md and GATES.md. Continue the current phase. Do not start the next phase.` |
| Approve a passed gate | `Approve U<n>.` — then, when ready, `Start U<n+1>.` |
| Unblock | Provide what was asked, then `Continue U<n>.` |
| Waive one goal | `Waive U<n>.G<k>: <reason>.` |
| Commit the work | `commit` |

---

## 12. The one-line version

Measure first, fix where users quit, use what only this product knows — the person's own documents —
prove the privacy, then grow; one gated phase at a time, with every document staying on the device.
