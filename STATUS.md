# STATUS — measured completion

Produced by **Phase A** of `COMPLETION_PLAN.md`. Measured 2026-08-26 against
commit `820e3cb` (Phase 10), and **re-measured after Phases B–F** — the
"Phase A said" sections are kept as written so the two pictures can be compared.
See *After Phases B–F* at the end for what changed and what is still open.

Phase A's rule, applied throughout: **implemented is not evidence.** Every green
row cites a test file and test name that runs. Every row without one is amber or
red, regardless of whether the code exists — and per the plan, **amber on a
safety or privacy row is treated as red.**

Nothing was fixed while producing this. One measurement artifact was added
(`src/matching/audit-metrics.test.ts`) and one existing rule was *proved* by
temporarily violating it and reverting; both are described below.

---

## The four numbers (A.2)

### 1. Mismatch rate — **0**

High-confidence (≥0.85) mappings that are wrong, across every fixture that has
ground truth.

| Fixture | Fields | Mappable | Correct (any conf.) | Correct at ≥0.85 | **High-conf. mismatches** |
|---|---|---|---|---|---|
| `fourth-portal` | 30 | 27 | 17 | 5 | **0** |
| `heldout-exam` | 27 | 23 | 23 | 23 | **0** |
| `heldout-scholarship` | 32 | 29 | 29 | 28 | **0** |
| **Total** | **89** | **79** | **69** | **56** | **0** |

Evidence: `src/matching/audit-metrics.test.ts` → "THE P0 NUMBER: zero
high-confidence mis-mappings", with the per-fixture and total figures committed
as snapshots so a regression shows as a diff rather than a judgement call.

**Honest limit on "across all fixture forms".** Four of the eight fixture pages
carry no `data-expect`: `demo-portal`, `ugly-portal`, `postback-portal`,
`hostile-portal`. They exist to exercise the filler, the submit guard and the
resume path, and were never annotated for matching. A mismatch rate cannot be
computed where there is no right answer, so those four are **named, not
silently excluded** — see the same file's "names the fixtures it cannot measure"
snapshot. Annotating them would widen this number's base and is not done.

### 2. Coverage on a site never tuned against — **63%** (17/27), 0 mismatches

> **Superseded by Phase E.** This was a sample of one form. The ten-form
> held-out benchmark now measures **96.6% (115/119), 0 high-confidence
> mismatches** — see *After Phases B–F* below. The 63% figure stands as the
> number for `fixtures/fourth-portal/` specifically, which remains the hardest
> single form in the corpus and is deliberately so.

`fixtures/fourth-portal/` is a municipal trade-licence renewal written in
register English ("Appellation of the Applicant", "Name of Progenitor", "Natal
Date", "Urban Agglomeration"), deliberately outside every phrase in
`synonyms.json`. It has never been profiled or taught.

**This is the universal-coverage estimate, and it is 63% on rules alone.**
Only 5 of 27 reach the auto-fill band; the rest land in fill-and-flag or blank.

Evidence: `src/matching/audit-metrics.test.ts` → "reports the fourth portal on
its own, which is the universal-coverage estimate".

The plan's ≥85% gate is a *rules + LLM* number. That measurement **has not been
taken** — it needs a live API call. See row E-6 below.

### 3. Pause/resume stability — **20/20**

The postback + fake-CAPTCHA + regenerated-ID fixture, run 20 consecutive times.

Two independent measurements agree:

- `tests/e2e/resume.spec.ts:230` → "twenty consecutive runs › every one of them
  reaches REVIEW with the right data" — twenty full journeys inside one test,
  with `retries: 0`.
- The whole e2e suite was then run 20 consecutive times end-to-end: 63 tests
  each, **20/20 clean**, 15.1–17.8s per run. So the internal gate itself
  executed 20 times over.

### 4. Leak status — **clean**

Binary, as the plan requires.

Evidence: `src/background/redaction.test.ts` (35 tests) and
`src/background/value-guard.test.ts` (18 tests), 53 passing.

Two canary mechanisms, because the problem has two halves:

- **Syntactic** — canaries planted in a *real harvested page* (not a synthetic
  payload): Aadhaar, PAN, email, mobile, account number, IFSC, DOB, application
  number. Also swept across every fixture in the corpus.
- **Semantic** — vault canaries with no syntax at all, principally a person's
  name, which no pattern can catch. `value-guard.test.ts` → "lets no canary
  through — including the ones with no shape".

A canary filename is **not** separately tested (plan C asks for one); document
bytes are unreachable by module boundary rather than by canary. Recorded as
amber in row C-4.

---

## A.3 — Structural rules

| Rule | Expected | Measured | Verdict |
|---|---|---|---|
| Hard-coded page selectors outside `site-profiles/` | 0 | 0 | 🟢 |
| `.click()` / `.submit()` outside `submit-guard.ts` | 0 | 2 | 🟡 — see below |
| Vault/document imports reachable from `llm-client.ts` | impossible | none, **and proved** | 🟢 |
| `<all_urls>` in the manifest | absent | absent (appears only in a comment saying it is never used) | 🟢 |
| Master key written to `chrome.storage.*` | absent | absent | 🟢 |

**The two `.click()` hits, examined rather than waved through:**

1. `src/content/overlay/index.ts:262` — `__pressContinue()`, a test seam that
   clicks **our own** button inside **our own closed shadow root**. Never a page
   element.
2. `src/ui/vault-editor/BackupPanel.tsx:41` — an `<a download>` the side panel
   creates and clicks to save a backup file. An extension page, not a portal.

Neither activates a portal control, so CLAUDE.md rule 1 ("never click a
submit/final-action element outside `submit-guard.ts`") is **not** violated —
the grep is simply broader than the rule. Left amber rather than green because
the grep as written in the completion plan does not come back zero, and a future
reader running it deserves this note rather than a surprise.

**The import boundary was proved, not asserted.** A `import { getAllFields }
from '@/vault/profile-store'` was temporarily added to `redaction.ts`; ESLint
failed with the P3 message (`no-restricted-imports`), and the file was reverted
to a clean lint. This is the Phase C verify step, executed.

---

## A.1 — Must-Achieve audit

🟢 implemented *and* an automated test proves it · 🟡 implemented, no test or
happy-path only · 🔴 not implemented, or failing, or amber on a safety/privacy row

### Phase 0 — Foundations

| # | Item | Status | Evidence |
|---|---|---|---|
| 0-1 | Repo scaffolded, MV3 side panel loads | 🟡 | `npm run build` green; no automated load test |
| 0-2 | `CLAUDE.md` committed | 🟢 | file present, 5 hard rules |
| 0-3 | `taxonomy.ts` with full key list + sensitivity | 🟢 | `taxonomy.test.ts` — every key has a sensitivity tier |
| 0-4 | **Three target portals + ToS verdicts** | 🔴 | `docs/portal-notes/` contains only `README.md` + `TEMPLATE.md`. **No portal has been assessed.** |
| 0-5 | `docs/THREAT_MODEL.md` | 🟢 | present, four adversaries |
| 0-6 | Fixture corpus from real portal pages | 🔴 | all 8 fixtures are **synthetic and author-written**. No captured portal HTML exists. |

### Phase 1 — Vault

| # | Item | Status | Evidence |
|---|---|---|---|
| 1-1 | AES-GCM 256, strong KDF, non-extractable key | 🟢 | `kdf-migration.test.ts` → "produces a non-extractable key" |
| 1-2 | Auto-lock, key memory-only | 🟢 | `session.test.ts` (25 KDF-touching tests); `crypto.test.ts` |
| 1-3 | Tamper detection | 🟢 | `crypto.test.ts` → AES-GCM tag tests |
| 1-4 | Encrypted export/import | 🟢 | `vault.test.ts` → "round-trips a vault through export and import" |
| 1-5 | Field validation (Aadhaar Verhoeff, PAN, IFSC…) | 🟢 | `validation.test.ts` |

### Phase 2 — Documents

| # | Item | Status | Evidence |
|---|---|---|---|
| 2-1 | Constraint parser | 🟢 | `constraints.test.ts` |
| 2-2 | Derivation hits a byte window | 🟢 | `derivation.spec.ts` → "derives the plan's worked example: 20–50 KB, 3.5×4.5 cm JPEG"; "honours a bare maximum with no minimum" |
| 2-3 | Fails loudly on an impossible window | 🟢 | `derivation.spec.ts` → "fails loudly, and readably, on an impossible window" |
| 2-4 | Warns on upscale | 🟢 | `derivation.spec.ts` → "warns rather than silently shipping a blurry upscale" |
| 2-5 | In-browser crop/rotate/deskew, signature thresholding | 🔴 | not implemented (deferred since Phase 2) |

### Phase 3 — Harvester

| # | Item | Status | Evidence |
|---|---|---|---|
| 3-1 | DOM → `FieldDescriptor[]`, 10 label strategies | 🟢 | `labels.test.ts`, `harvester.test.ts` |
| 3-2 | Ranked selectors, XPath verified against live DOM | 🟢 | `harvest.spec.ts` → "label-anchored XPath selectors actually resolve" |
| 3-3 | Harvester never mutates | 🟢 | `harvest.spec.ts` → "leaves the page byte-identical — a portal cannot tell it was read" |
| 3-4 | Cross-origin frames reported as blockers | 🟢 | `harvest.spec.ts` → "reports a genuinely cross-origin iframe as a blocker" |
| 3-5 | Never harvests passwords / security fields | 🟢 | `harvest.spec.ts` → "never harvests a password field"; "reports the CAPTCHA field without harvesting it" |

### Phase 4 — Matcher

| # | Item | Status | Evidence |
|---|---|---|---|
| 4-1 | Profile → rules → LLM precedence | 🟢 | `profile-cache.test.ts`; `llm-matcher.test.ts` → "fills only what the rules left unknown" |
| 4-2 | Traits veto | 🟢 | `eval.test.ts` → "respects the traits veto on the trap fields" |
| 4-3 | **Zero high-confidence mis-mappings** | 🟢 | measured above: **0**. `eval.test.ts` + `audit-metrics.test.ts` |
| 4-4 | ≥70% coverage on held-out corpus | 🟢 | `eval.test.ts` → "meets the bar across the whole held-out corpus" |
| 4-5 | Synonyms as JSON, extensible without a release | 🟢 | `synonyms.json`; English + Devanagari |

### Phase 5 — Fill engine & submit guard

| # | Item | Status | Evidence |
|---|---|---|---|
| 5-1 | Native value setter; real events | 🟢 | `fill.spec.ts` → "fires real input and change events, as a framework would need" |
| 5-2 | Sequential fill, waits for dependent selects | 🟢 | `fill-run.test.ts` → "waits for options to arrive before filling"; "gives up rather than hanging when options never arrive" |
| 5-3 | maxLength truncation flagged, not silent | 🟢 | `fill.spec.ts` → "truncates to maxLength and flags it" |
| 5-4 | Guard blocks click / submit / Enter | 🟢 | `fill.spec.ts` → "blocks a click on the real submit button"; "blocks a scripted form.submit() once installed"; "blocks Enter pressed inside the form" |
| 5-5 | Guard installed at `document_start` | 🟢 *(opt-in, per origin)* | **Closed in Phase B.** `early-guard.test.ts` (27 tests) → "registers at document_start, which is the entire point"; "refuses to register an origin the user has not granted". The Phase 5 reasoning that dismissed this was wrong — see the finding below. |
| 5-6 | Undo restores pre-fill snapshot | 🟢 | `fill-run.test.ts` → undo tests |
| 5-7 | Overlay in closed shadow root | 🟡 | implemented; no test that a hostile stylesheet cannot reach it |

### Phase 6 — Pause, resume, drift

| # | Item | Status | Evidence |
|---|---|---|---|
| 6-1 | Pure reducer, every §5 transition | 🟢 | `machine.test.ts` (49 tests, one per rule) |
| 6-2 | Persisted every transition; rehydrates | 🟢 | `persistence.test.ts` → "writes on each accepted transition"; "rehydrates a paused run in a fresh store" |
| 6-3 | Forced REVERIFYING on navigation / postback / >20% mutation | 🟢 | `machine.test.ts` → "§5: navigation, postback, or >20% mutation forces REVERIFYING" |
| 6-4 | REVERIFYING refills resets, escalates to DRIFTED | 🟢 | `run-controller.test.ts` → "asks for a refill of exactly what was reset"; "escalates to DRIFTED when a field is gone entirely" |
| 6-5 | DRIFTED → NEEDS_TEACHING, never a silent skip | 🟢 | `machine.test.ts` → "refuses to walk to REVIEW while a field is lost" |
| 6-6 | Blocker detection (reCAPTCHA/hCaptcha/Turnstile/image/OTP/eSign/payment) | 🟢 | `blockers.test.ts` (35 tests) |
| 6-7 | Resume on user signal or settle, **never a bare timer** | 🟢 | `machine.test.ts` → "never resumes on a timer, however many tick" |
| 6-8 | Re-auth before high-sensitivity fill | 🟢 | `reauth.test.ts` → "for a high-sensitivity key once the window has passed" |
| 6-9 | Hostile fixture 20/20 | 🟢 | measured above: **20/20** |
| 6-10 | `__doPostBack` hook | 🔴 | **Not implemented and not implementable** — a content script runs in an isolated world and cannot see the page's functions. Covered indirectly (a postback navigates or trips the churn threshold). Documented in `watcher.ts`. |

### Phase 7 — Review & approval

| # | Item | Status | Evidence |
|---|---|---|---|
| 7-1 | Review model: label, value, key, confidence, rationale | 🟢 | `review.test.ts` (31 tests) |
| 7-2 | Flags surfaced: low-conf, truncated, fuzzy, failed, required-empty | 🟢 | `review.test.ts` → "hoists the flagged rows out of a long form" |
| 7-3 | High-sensitivity masked until revealed | 🟢 | `review.test.ts` → "never leaks the leading digits of an Aadhaar"; `ReviewScreen.test.tsx` → "shows the value that is actually in the field" |
| 7-4 | Approval needs a deliberate gesture | 🟢 | **Closed in Phase B.** `HoldToConfirm.test.tsx` (22 tests) → "ignores a plain click entirely"; "does not carry progress over into the next attempt"; "cancels when the window loses focus mid-hold" |
| 7-5 | 128-bit token, single-use, 90s TTL, burned before the click | 🟢 | `approval.test.ts` → "refuses after ninety seconds"; "spends the token"; `approval-service.test.ts` → "burns the token even when talking to the page throws" |
| 7-6 | Exactly one click on the recorded element | 🟢 | `approval-service.test.ts` → "sends exactly one submission, naming the approved element"; `fill.spec.ts` → "an armed token permits exactly one submission" |
| 7-7 | Append-only audit log | 🟢 | `audit.test.ts` → "exposes no way to change or remove one entry" |
| 7-8 | Click a row → scroll to and highlight the field | 🟢 | `review-bridge.test.ts` → "marks it with our own element, never by restyling the page's" |
| 7-9 | Inline edit writes back + optional save to vault | 🟡 | `review-bridge.test.ts` covers the page write; the *save-to-vault* branch has no test |
| 7-10 | Document section with thumbnails vs. requirement | 🟡 | **Requirement vs. attached now shown** — `review-documents.test.ts` (7 tests) → "shows what went in beside what was asked". Still no thumbnails. See *Documents were never attached* below. |
| 7-11 | **User test: 3 people, 1 planted wrong value** | 🔴 | not done — human activity |

### Phase 8 — LLM fallback

| # | Item | Status | Evidence |
|---|---|---|---|
| 8-1 | Payload from `FieldDescriptor`s only | 🟢 | `redaction.test.ts` → "the payload type has no property that could hold a value" |
| 8-2 | Module boundary enforced by lint | 🟢 | **proved** by adding a violating import (above) |
| 8-3 | Canary leak suite, CI-blocking | 🟢 | runs in `npm test`; 53 tests |
| 8-4 | Closed-vocabulary prompt | 🟢 | `llm-service.test.ts` → "sends the closed vocabulary, so the model has a list to choose from" |
| 8-5 | Response validation, one retry, fall back to unknown | 🟢 | `llm-matcher.test.ts` (30 tests); `llm-service.test.ts` → "retries exactly once on a malformed reply" |
| 8-6 | Merged under rules, capped at 0.8 | 🟢 | `llm-matcher.test.ts` → "rules win even when the rule was the less confident one"; "caps an ordinary key at the LLM ceiling" |
| 8-7 | Never auto-fills a high-sensitivity key | 🟢 | `llm-matcher.test.ts` → "caps id.aadhaar below the fill threshold, so it is suggested and not written" |
| 8-8 | Writes a profile → one call per form ever | 🟢 | `llm-service.test.ts` → "writes a profile, so the same form never needs the model again"; "does not call when this form was already learned" |
| 8-9 | Graceful degradation (no key / offline / 429) | 🟢 | `llm-service.test.ts` → "degrades on HTTP %i with a notice"; "never throws, whatever the transport does" |
| 8-10 | **≥85% on a fourth portal, rules + LLM** | 🔴 | **not measured.** `eval-llm.test.ts` skips without `ANTHROPIC_API_KEY`. Rules-only is 63%. |

### Phase 9 — Teach mode

| # | Item | Status | Evidence |
|---|---|---|---|
| 9-1 | Element picker | 🟢 | `picker.test.ts` (20 tests) → "swallows the click instead of letting the form navigate" |
| 9-2 | Entered from NEEDS_TEACHING and DRIFTED | 🟢 | `teach.spec.ts` → "the whole journey: drift, teach, fill again, bumped version" |
| 9-3 | Versioned profiles with rollback | 🟢 | `teach.test.ts` → "bumps the version"; "keeps every field the user did not re-teach" |
| 9-4 | Resilient selector recording | 🟢 | `teach.spec.ts` → "records a selector that survived the rename, not the id that did not" |
| 9-5 | Health check <60% → stale, prompt repair | 🟢 | `teach.spec.ts` → "a stale profile is not used to fill a half-broken form" |
| 9-6 | Document-slot teaching | 🟡 | `teach.test.ts` → "records the constraint alongside the selectors" covers the model; **no UI path** — `TeachPanel` has no document mode |
| 9-7 | Profile export/import as untrusted input | 🟢 | `profile-transfer.test.ts` → "refuses to inherit 'taught', however the file is labelled" |

### Phase 10 — Hardening

| # | Item | Status | Evidence |
|---|---|---|---|
| 10-1 | Strict CSP, no eval, no remote code | 🟢 | built `manifest.json` inspected; two `.wasm` files in `dist/` — Argon2id and ONNX Runtime (the document reader) — both bundled, neither fetched: `release-gates.test.ts` → "points the document reader at this package, never at a CDN"; `e2e/ocr.spec.ts` → "reads the words off a rendered page, under the extension’s CSP, with nothing fetched" |
| 10-2 | `npm audit` + licence check | 🟢 | 0 vulnerabilities; ISC/MIT/Apache-2.0 only |
| 10-3 | Isolation review | 🟡 | `docs/ISOLATION_REVIEW.md` — 9 claims each citing a test. It is a document, not a test. |
| 10-4 | Message-bus schema validation | 🟢 | `validate.test.ts` (35 tests) → "refuses a type nobody declared"; "knows every privileged type" |
| 10-5 | Argon2id + PBKDF2 migration | 🟢 | `kdf-migration.test.ts` (19 tests) → "still opens"; "is LEFT ALONE when the vault holds data" |
| 10-6 | P1/P6 rate & scope limits | 🟢 | `limits.test.ts` (15 tests) → "admits exactly the cap, then stops" |
| 10-7 | Crash safety | 🟢 | `crash-safety.test.ts` (13 tests) → "does not come back armed once the ninety seconds are up" |
| 10-8 | Onboarding flow | 🔴 | disclosure gate only. Guided profile entry, document upload with quality checks, and first supervised fill are **not sequenced**. No tests. |
| 10-9 | In-product disclosure | 🟡 | `Disclosure.tsx` implemented; still no test |
| 10-10 | Privacy policy + store listing | 🟢 | `docs/PRIVACY.md`, `docs/STORE_LISTING.md` |
| 10-11 | **External security review** | 🔴 | not done — cannot be self-performed |
| 10-12 | **Real-portal smoke test** | 🔴 | not done — depends on 0-4 |
| 10-13 | Full e2e green 20 consecutive runs | 🟢 | measured above: **20/20** |

---

## Tally

| | Count | After Phase B |
|---|---|---|
| 🟢 Green | 54 | **58** |
| 🟡 Amber | 8 | 8 |
| 🔴 Red | 14 | **10** |

**1,251 unit tests, 69 e2e tests.** typecheck, lint, build clean.

Phase B moved 5-5, 7-3, 7-4 and the abort row to green, and closed a P2 hole
that no row had been tracking at all.

---

## Phase B — what the attack-first pass found

Written after the audit, following the plan's instruction to attack the guard
before touching it.

### A P2 hole no row was tracking

Phase 5 recorded the pre-injection window as acceptable because *"nothing of
ours had been filled"*. That covers a **first** page load and nothing else.
After a fill, an ASP.NET postback preserves field values, so the page returns
**carrying the extension's own data** — and a portal that submits during `load`
sends it before a gesture-injected script can exist.

`fixtures/hostile-portal/reload-submit.html` and
`tests/e2e/guard-adversarial.spec.ts` demonstrate it: the URL the browser lands
on carries `candidateName=Ravi+Kumar&uid=234567890123`. Those were filled
values, submitted without approval. That is a P2 violation, not a documented
limit, and the Phase A audit inherited the wrong reasoning and marked it
"architecturally impossible" rather than "unclosed".

**Closed by** an opt-in, per-origin `document_start` registration
(`background/early-guard.ts`). Two Must-Achieve items in the completion plan
pull against each other here — Phase B wants `document_start`, Phase F says no
`<all_urls>` — and the resolution is `optional_host_permissions`: the user
grants **one origin at a time**, in context, and can revoke it from the panel.
Standing `host_permissions` stays empty.

### An approval that could outlive its own failure

`submitWithApproval` had three early returns that left `state.armed` set. The
consequence is narrow but real: the recorded element goes missing — a postback
re-rendering the form is the ordinary way that happens — we bail out, and the
guard stays armed for the rest of the ninety seconds. If the element comes back
under the same selector, a page-initiated click on it would be **permitted**.

Found by writing the attack first (`submit-guard.test.ts` → "does not permit a
page click once the missing element comes back"), watching all four new tests
fail, then fixing. Every exit path now disarms, and abort disarms the page-side
guard as well as revoking the worker's grant.

## The finding that most changes the picture

*(Recorded at Phase A; the two safety-critical components below now have tests —
`HoldToConfirm.test.tsx` and `ReviewScreen.test.tsx`. The general point stands
for the rest of `src/ui/`.)*

**There was not a single React component test in the project.** `find src/ui
-name "*.test.tsx"` returns zero.

Every model behind the UI is well covered — `runtime/review.ts` has 31 tests,
`runtime/approval.ts` has 22 — but the components that render them have none.
That includes the two pieces of UI the plan is most emphatic about:

- **`HoldToConfirm.tsx`** — the deliberate approval gesture. The entire P2
  promise narrows to this component behaving correctly, and nothing checks that
  a single click does not trigger it, that releasing early cancels, or that the
  keyboard path works.
- **`ReviewScreen.tsx`** — "the user's last line of defence… it has one job."
  Its attention-hoisting and per-row tick-off logic, which is what makes the
  screen more than a rubber stamp, is untested.

This is why rows 7-3, 7-4 and 10-9 are red or split rather than green. The
plan's own instruction — *treat amber on a safety row as red* — applies squarely.

---

## What Phase A says to do next

The completion plan gates everything on these numbers. Reading them:

1. **Phase B (safety) is mostly green already** — the guard's adversarial suite
   passes, the token is proved single-use and expiring, and 20/20 holds. The
   exceptions are 5-5 (`document_start`, architecturally impossible under
   `activeTab`, documented) and the untested approval *component*.
2. **Phase C (privacy) is green**, including the boundary proof the plan asks
   for. One gap: no canary *filename* test (C-4).
3. **Phase D (pause/resume) is green at 20/20.** Nothing to stabilise.
4. **Phase E (universal coverage) is the real gap.** 63% on the one site never
   tuned against, and the ≥85% rules+LLM gate has never been run. There is also
   no 10-form held-out benchmark — there is one form.
5. **Phase F (release) is blocked on 0-4**, which has been open since the first
   session and is a human decision about which portals to support.

The two highest-value pieces of work, in order:

- **Component tests for `HoldToConfirm` and `ReviewScreen`.** Cheap, and they
  close the only red rows that are within reach without external input.
- **Run the ≥85% gate** with an API key, and build out the held-out set from one
  form to the ten the plan asks for. Until then, "works on any portal" is a 63%
  claim with a sample size of one.


---

# After Phases B–F

Re-measured 2026-08-26 at commit `d345df5`+. Same rule as Phase A: a row is
green only if a named test asserts it.

## The four numbers, re-measured

| # | Number | Phase A | Now | Evidence |
|---|--------|---------|-----|----------|
| 1 | High-confidence mismatches | 0 | **0**, now across 3 corpora | `bench.test.ts` → "never auto-fills a wrong key, on any of the ten"; `eval.test.ts`; `audit-metrics.test.ts` |
| 2 | Coverage, never tuned against | 63% (1 form) | **96.6%** (115/119, 10 forms) | `bench.test.ts` → "records the total" |
| 3 | Pause/resume | 20/20 | **20/20** | unchanged |
| 4 | Leak status | clean | **clean**, plus a filename canary | `value-guard.test.ts` → "THE FILENAME CANARY (§ Phase C-4)" |

Number 2 is the one that moved, and the honest reading of it is narrower than
the headline. It is a **rules-only** number over ten forms that vary by
*labelling mechanism* — table cells, aria-label, bare text nodes,
aria-labelledby, autocomplete, placeholder-only, `<legend>`, Devanagari, `<th>`
grids, shadow roots. It is not ten portals' worth of vocabulary. The forms and
the synonym dictionary still share an author, which is the standing caveat from
Phase A and is not fixed by having ten of them instead of one.

## What Phase E found, which is the part worth keeping

The benchmark's value was not the percentage. On its first run it caught a
confident mis-map: a Google Form gives every question its own heading, so
"Current address" labelled the street field while City, PIN and State carried no
adjective — matched one at a time they split across two address sections and
assembled a **mixed address at 0.90**.

The first fix was wrong, and the older corpus said so: gating the retarget on a
form carrying *both* adjectives broke `heldout-exam`, which says "Present
Address" once and means it. Two of my own fixtures disagreed about what a lone
"Current address" block means. The rule that replaced it carries a section
heading forward over the run of address fields beneath it and stops at the first
field that is not one. Evidence: `deterministic.test.ts` → "address sections
carry across the block beneath the heading" (6 tests).

## Phase C — closed

| Row | Status | Evidence |
|-----|--------|----------|
| C-2 outbound schema validated before send | **green** | `value-guard.test.ts` → "the outbound schema (§ Phase C)" |
| C-4 document filename unreachable | **green** | `value-guard.test.ts` → "THE FILENAME CANARY (§ Phase C-4)" |

## Phase F — what is now green

| Row | Status | Evidence |
|-----|--------|----------|
| Permissions: 4 only, no `<all_urls>` | **green** | `release-gates.test.ts` → "asks for exactly the four permissions the plan allows", "never says `<all_urls>`, anywhere" |
| Strict CSP, no eval, no remote code | **green** | `release-gates.test.ts` → "permits no JavaScript eval and no remote script" |
| Dependency audit + licence check | **green** | `npm audit` 0 vulnerabilities; `release-gates.test.ts` → "are all permissive, transitively" (13 packages, MIT/ISC/0BSD/Apache-2.0) |
| Onboarding walkthrough | **green** | `GettingStarted.test.tsx` (12 tests), `steps.test.ts` (14 tests), `fixtures/practice/first-fill.html` |
| Document upload quality checks | **green** | `intake.test.ts` (15 tests) |
| Honest in-product disclosure | **green** | `Disclosure.tsx`, gated before vault creation in `App.tsx` |
| Privacy policy + store listing | **green** | `docs/PRIVACY.md`, `docs/STORE_LISTING.md`, both covering the optional host permission |
| Accessibility pass | **green, partial** | `a11y.test.tsx` (28 tests) over 5 screens — see the limit below |
| Crash safety | **green** | `crash-safety.test.ts` |

Both release-gate families were **proved to bite**, not just observed passing:
adding `<all_urls>` and swapping `wasm-unsafe-eval` for `unsafe-eval` turns five
tests red; stripping `aria-hidden`, the screen-reader text and a button's label
turns three a11y tests red. Both were reverted.

The a11y sweep also carries a guard against itself — "actually rendered — every
check below is vacuous otherwise" — which immediately caught one screen being
swept in a state with no controls in it at all.

## Still open, and why

**Human activities, not code.** These cannot be closed from this machine and
should not be marked green by anyone who has not done them:

- **Real-portal smoke test** — one live run per portal, stopped at review. Also
  blocked on row 0-4 (which portals), a decision open since the first session.
- **User test: 3 people, one planted wrong value, all 3 catch it.** The review
  screen's *logic* is well covered now; whether the screen actually causes a
  person to notice a wrong value is not something a test can answer. The plan is
  right that if they miss it, the screen needs redesigning.
- **External security review** of the isolation boundary.
- **Portal ToS verdicts** — `docs/portal-notes/` is a template, not a verdict.

**Measurable but not measured:**

- **The ≥85% rules + LLM gate.** Needs `ANTHROPIC_API_KEY`. `eval-llm.test.ts`
  is written and skips without one. The 96.6% above is rules only, so this gate
  is not "probably fine" — it is unmeasured, and the LLM tier's contribution to
  coverage is currently an assumption.
- **LLM document-constraint extraction** (Phase E Should).

**Accessibility, honestly.** The 28 invariants cover names, heading order, tab
order, labels, and state not carried by colour alone, across five screens. What
they cannot cover is what an automated check never can: whether the wording
makes sense, whether focus order matches reading order on a real screen, and
whether a screen reader announces the review screen usefully. This is an
accessibility product for many of its users, and that part still needs a person.

**Localisation — shipped, and needing a native reviewer.** English, Hindi and
Tamil, chosen with a labelled picker at the top of the panel rather than hidden
in a settings screen (somebody who cannot read the panel cannot find the
settings screen). Deliberately *not* `chrome.i18n`, which resolves against the
browser's UI language — for most of this product's users that is English
regardless of what they read most comfortably.

| Row | Status | Evidence |
|-----|--------|----------|
| Catalogues complete, no blanks, no stray keys | **green** | `i18n.test.ts` → "every locale is complete" (6 tests) |
| Placeholders survive translation, and may reorder | **green** | `i18n.test.ts` → "placeholders survive translation" |
| A missing key degrades to English, never to a blank control | **green** | `i18n.test.ts` → "falling back" |
| Every control keeps its accessible name in hi and ta | **green** | `a11y.test.tsx` → "in hi / in ta … keeps every control named" |
| Screens do not silently fall back wholesale | **green** | `a11y.test.tsx` → "is actually in that language" |

**The honest limit: these translations have not been reviewed by a native
speaker.** They were produced during development. A consent screen or an
approval button that reads oddly is worse than one in a language the reader
merely finds harder, so this is a real caveat and not a formality — the
`i18n.ts` header says the same thing where a future editor will see it.

Screens translated: disclosure, vault gate, getting-started checklist, language
picker. **Still English:** the vault editor, documents panel, backup panel,
audit panel, LLM panel, teach panel and fields panel. The split is principled —
consent, setup and the review path first, administration after — but it is a
split, and the remaining screens are the larger half by line count.

Portal field labels are deliberately never translated. A review screen showing
different words from the form behind it is the one thing it must never do.

**Firefox port — assessed, not built.** `docs/FIREFOX_PORT.md` is the audit:
what the codebase actually uses, the two real blockers (`chrome.sidePanel` has
no Firefox equivalent; `background.service_worker` is an event page there), and
the three things that would need re-verifying rather than re-compiling —
Argon2id under Firefox's WASM handling, the capture-phase submit guard's event
ordering, and the optional-permission prompt flow.

Deliberately not shimmed. A compatibility layer would compile and would be
untestable here, and an extension that has never been loaded into the browser
it claims to support is not ported. The gap is honest; a shim would not be.

---

# A bug that shipped, and what it says about the tests

Found by running the extension, not by any test: **creating a vault failed with
`window is not defined`.**

`vault/crypto.ts` used `await import('hash-wasm')` to keep Argon2id out of code
paths that never open a vault. Vite compiles every dynamic import into a
`__vitePreload` wrapper which injects `<link rel="modulepreload">` into
`document.head` and reports failures through `window.dispatchEvent`. A service
worker has neither global.

The masking was the worse half. The wrapper ends with
`baseModule().catch(handlePreloadError)`, so *every* dynamic-import failure —
whatever the real cause — was rewritten into that one sentence before it reached
the user.

**Not a regression.** The same dynamic import is in the previous commit's build,
byte for byte. Vault creation with Argon2id had never worked in a real browser.

## Why 1,847 tests missed it

Every layer of the suite ran the code somewhere it could not fail:

- Unit tests run in **Node and jsdom** — dynamic import works, both globals exist.
- The Playwright suite drives a **harness page**, which is a page: it has a
  `window` and a `document`.
- The bundle-boundary tests only ever examined **`dist/content.js`**. There was
  no test anywhere that looked at the service worker bundle *as a worker*.

The gap was not subtle in hindsight. The one execution context with the most
restrictions was the only one nothing tested.

## The fix

| Change | Effect |
|--------|--------|
| `import { argon2id } from 'hash-wasm'` in `crypto.ts` | The vault path no longer goes through the wrapper at all |
| `build.modulePreload: false` | Empties every dependency array, so the `document.head` branch is dead code everywhere |

`worker-bundle.test.ts` now asserts both, and was verified against the original
bug: restoring the dynamic import and removing the config turns three tests red.
The content-script boundary is unchanged — `content.js` still carries no
`hash-wasm`, no `argon2`, and no `__vitePreload`.

## What is still open

`documents/` imports pdf.js and pdf-lib dynamically, and that stays. Bundling
them statically drags ~1.6 MB **and two hundred real `document.` references**
into the worker, which is a worse problem than the one it solves. With empty
dependency arrays those imports no longer touch the DOM — but if one of them
fails, the wrapper still masks the reason.

The proper fix is an **offscreen document** for PDF work, which is the MV3
answer for DOM-dependent processing and is a piece of work in its own right.
Until then, PDF rasterisation and PDF text extraction in the worker are the
untested-in-a-real-worker paths, and should be treated as such.

---

# The content script never ran

Found by using the extension, after four earlier rounds chasing the error
messages it produced. `dist/content.js` was an **ES module** — it began
`import { … } from "./assets/…"`, because Rollup split shared code into chunks
when it was an entry in the main build.

`chrome.scripting.executeScript({ files })` injects a **classic** script. A
classic script with a top-level `import` is a syntax error. The file never
parsed, so nothing ran, no message listener was registered, and every scan on
every real page ended with "nothing on this page answered".

## Why 1,895 tests and 76 e2e runs missed it

The Playwright suite loads the content script with
`addScriptTag({ type: 'module' })`. That exercises the **code** thoroughly — the
whole submit guard, the fill engine, drift recovery, 20/20 resume — and does not
exercise the **injection** at all. The one step that only exists in a loaded
extension was the one step nothing tested.

This is the third bug of exactly that shape:

| Bug | Ran the code where | Real context |
|-----|--------------------|--------------|
| `window is not defined` | Node, jsdom, a harness page | service worker: no `window` |
| Toolbar click granted nothing | no test has a real `chrome.action` | a loaded extension |
| Content script never parsed | a page, as a module | `executeScript`, as a classic script |

Every one ran in a context **more permissive than production**. A suite can be
large, adversarial and mutation-tested and still never put the code where it has
to run. Coverage and mutation score say nothing about this class, and neither
did they here.

## The fix

The content script has its own build: `vite.content.config.ts`, `lib` mode,
`iife` format, self-contained. `npm run build` runs it after the main build.
`content-script-format.test.ts` asserts the output has no top-level import, no
export, no reference to another chunk — verified against the bug.

## The gap itself, now closed

`tests/e2e/extension.spec.ts` loads `dist/` as an unpacked extension in a real
Chromium and drives the actual service worker. Five tests, and between them they
cover all three bugs above:

| Test | The bug it would have caught |
|------|------------------------------|
| the service worker starts without throwing | `window is not defined` at module scope |
| an action handler is registered | the toolbar click granting no `activeTab` |
| the content script parses as a classic script | the ES-module content script |
| the content script finishes wiring itself | the self-locking ready flag |
| the submit guard is live in the real bundle | P2, in the artefact that ships |

Verified against the real bug: restoring the ES-module form turns two of them
red. And the guard test was vacuous in its first version — the practice form has
three required fields, and an empty one makes the browser refuse the submit on
its own, so it passed against a content script that could not even parse. It now
demonstrates the submit succeeding *first*, then blocks it.

**What still is not reachable.** `chrome.scripting.executeScript` needs
`activeTab` or a host permission even for the extension's own pages, and
`activeTab` needs a real toolbar click, which Playwright cannot perform. So the
injection *call* on a user-granted page remains untested; what is tested is that
the file it injects parses, runs, and wires itself. Closing the last step would
need a driver that can operate browser chrome.

---

# Documents were never attached

Found by using the extension on a Google Form: pressing **Fill this form**
uploaded nothing, on any site. Five causes, found in the order they were hit.

| # | Cause | Where |
|---|-------|-------|
| 1 | The fill skipped every `doc.*` match, pointing at an `attachDocuments` that did not exist. `planFrom` hard-coded `documents: []`, the review showed a stub, and the panel never mentioned the skip. | `fill-service.ts` |
| 2 | A Google Form has no file box. "Add file" opens the site's own upload window, a same-origin frame; the harvester only reads `input, select, textarea`. | `harvester.ts` |
| 3 | The submit guard blocked a portal's own submit-type Upload button — even the user's own press. | `submit-guard.ts` |
| 4 | The guard was injected into every frame, so inside a site's upload window it could block the user's press on Upload. Nothing is ever written to a sub-frame. | `content/index.ts` |
| 5 | The traits veto returned early for any key without a traits entry — every composed key — so a *file* box labelled "Upload your 10th marks card" was mapped to `education.class_10.marks_obtained`. | `traits.ts` |

## What now happens

- **File boxes, during Fill.** The requirement is read off the page — label,
  the hint beside the box, its `accept` list; a taught constraint wins
  (`documents/field-constraint.ts`, test-first, 23 tests). The stored master is
  fitted by the existing pipeline, or attached untouched when it already fits.
  Documents go after every text field, over the bus as base64, inside a
  per-fill budget. The re-auth gate covers documents, before decryption.
- **Drag-and-drop areas** get a synthetic drop, and the widget's own answer
  (a cancelled `drop`) decides success.
- **Upload windows** (Google Forms): the user opens it; "Put … in the upload
  window" runs two self-contained functions in that frame; the user presses
  Upload (`upload-window-service.ts`, `content/upload-window.ts`).
- **A portal's Upload button**: hold-to-approve one document; a token naming
  that button, burned before the press; the form's other file boxes emptied
  first (`uploadWithApproval`, `content/upload-press.ts`).
- **The guard is top-frame only**, matching the `document_start` guard.
- **A re-auth prompt** now exists. The worker had refused high-sensitivity
  fills after three minutes since Phase 6, and no screen could answer it.

## Evidence

| Claim | Test |
|-------|------|
| A document lands in a real file box and the page hears it | `documents.spec.ts` → "a document lands in the box" |
| The real photo is fitted to the box's own words | `documents.spec.ts` → "the real pipeline fits the real photo" (3.6 MB → 20–50 KB) |
| Undo restores the user's own pick | `documents.spec.ts` → "Undo gives back a file the user had chosen" |
| Unapproved Upload is blocked; approved posts once, one document | `documents.spec.ts` → "is blocked unapproved … approved" |
| The window functions work from their own source and press nothing | `documents.spec.ts` → "the file goes into the window … nothing is pressed" |
| The guard stays out of sub-frames | `extension.spec.ts` → "the guard stays out of sub-frames" — proved to fail with the old behaviour |
| Gate before decryption; refills never carry a document | `fill-service.test.ts` → "asks for the passphrase before decrypting…", "never lets a refill…" |
| Document wordings, from a fixture (rule 5) | `matching/documents.test.ts` over `fixtures/documents-portal/` |

`fixtures/documents-portal/page-1.html` joins the measured corpus: 6/6
mappable correct, **0 high-confidence mismatches**; every other fixture's
numbers are unchanged.

# The vault, laid out as a student's folders

The vault held twelve document slots, named for what a national form tends to
ask for. A Karnataka student applying through KEA keeps about forty: a study
certificate and a transfer certificate for *each* of Class 10 and PUC, the
371(J) Annexure-A, and eleven KCET papers from the application form to the
admission order.

| Change | Where |
|--------|-------|
| 32 document slots appended, 12 kept as they were (keys are append-only) | `taxonomy.ts` |
| A certificate that exists per qualification is retargeted by the level its question names, the way `education[]` fields already were | `frame.ts` |
| The slots are grouped into the folders they are kept in; optional folders start collapsed | `ui/lib/field-groups.ts` |
| An RD number is a text field, not a document: it is printed on a certificate but a portal asks for it in a text box | `taxonomy.ts`, `traits.ts` |
| A thumb impression is judged by its own rules — a thumbprint is square, and the signature window rejected every correct one | `documents/intake.ts` |

| Claim | Test |
|-------|------|
| Every document a student keeps is matched from a fixture, in the words portals use (rule 5) | `matching/documents.test.ts` over `fixtures/documents-portal/student-documents.html` (35 questions) |
| Every slot has exactly one folder, and two of a kind are never labelled alike | `ui/lib/field-groups.test.ts` |
| A closed folder still holds its slots in the page | `DocumentsPanel.test.tsx` |
| A thumb impression is not held to the signature rules | `intake.test.ts` |

**Not slots, on purpose:** printed passport photographs (the digital original
is the slot), and bank account details, which are the existing `bank.*` text
fields.

# Restoring a vault had never once worked

Reported in use: importing a real backup — 9.6 MB, 110 fields, nine documents,
one setting — failed with **"Maximum call stack size exceeded"** after the last
piece was read, and nothing was restored.

**Cause.** `fromBase64` checked that a string was base64 with
`/^(?:[A-Za-z0-9+\/]{4})*…$/`. V8 recurses on a quantified group like that:
past a few megabytes it throws rather than answering. Every value in a backup
is such a string, and the file's largest was 5.7 MB, so the import died on the
first document it reached — every time, for any vault holding a document of
real size.

**Fix.** The check is a character scan: the alphabet, a length that is a
multiple of four, padding only at the end. O(n), no stack.

**Why no test caught it.** The six-megabyte case existed, and only *exported*.
`backup-transfer.test.ts` now restores one too, and fails with the old regex in
place.

| Claim | Test |
|-------|------|
| A four-megabyte string decodes | `crypto.test.ts` → "reads a document-sized string" |
| Padding is still rejected where it does not belong | `crypto.test.ts` → "rejects padding that is not at the end" |
| A vault whose documents are megabytes restores, fields and documents both | `backup-transfer.test.ts` → "restores a vault whose documents are megabytes" |
| The reported file itself parses and unseals, all 120 sealed values | checked directly against `autofill-2026-09-21.afvault` |

# The guard blocked sites it had never filled

Reported in use: the login of an unrelated local project (DBARS) and a
government hostel portal refused the user's own **Sign In** with "Submission
blocked", on pages the extension had not been opened on.

| Cause | Fix |
|-------|-----|
| The guard switched on the moment the content script loaded, and refused every submit until an approval — so a scan, or any load of the script, locked the page. | Dormant by default. It **engages** at the first write of a fill, on a review edit, or on adopting a live run, and disengages when the run ends. |
| The per-origin `document_start` script, registered when a fill started, was never removed: it loaded on every page of that host for the rest of the session. An origin pattern covers every port, so a fill on `localhost:5173` guarded every localhost app. | Unregistered when the run ends — approved, aborted, expired or its tab closed (`onRunEnded`) — unless another tab is mid-run on the same site. Loaded before the page, it starts engaged and asks the worker (`run:active`); with no live run for its tab it stands down. |

| Claim | Test |
|-------|------|
| A page the extension has not filled submits normally, with the shipped bundle loaded | `extension.spec.ts` → "leaves the user's own submit alone" |
| A document_start copy with no live run hands the page back — **fails with the stand-down removed**, reproducing the report | `extension.spec.ts` → "hands the page back" |
| Engaged, the guard still blocks: every adversarial guard spec passes | `guard-adversarial.spec.ts`, `fill.spec.ts`, `submit-guard.test.ts` |
| Every way a run ends releases it, including expiry | `fill-service.test.ts` → "a run ending hands the page back" |

# What a test portal found

A separate test portal's `/documents` page reported five extension faults.
It was captured as it renders (`scripts/capture-page.mjs` →
`fixtures/test-portal/documents.html`) and every fault was reproduced there
before it was fixed.

| Reported | Cause | Fix |
|----------|-------|-----|
| An income certificate in the photo box | A header link, "Upload Documents", was read as an upload control; its "question" was **Home**. A document assigned to that slot went to "the window" — and `placeFileInWindow`, run in the page itself, took the **first file box on the page** that accepted a JPEG: the photo's. | Navigation links are never upload controls (`navigates`, `PAGE_CHROME`); in the page itself, "the window" is the open dialog and only that. |
| The photo cropped, top of the head gone | Every derivation trimmed to the ink box measured at upload. A photograph has no blank paper: the background above the head is part of it. | `trimsToInk(role)` — false for a photo. |
| "Class X Academic Record" not filled | Roman X was not Class 10, and the matcher never read the page's own "Also known as: 10th Marks Card / SSLC Marks Card" line. | `class\s*x` is Class 10; `aliasesOf` scores an alias list just below the label. |
| "ST Category Certificate" not filled | A certificate named by the category it proves had no phrasing; the alias "Caste certificate" was not read. | Category-certificate phrasings, and the alias list. |
| A JPG for a PDF-only box, skipped silently | Never matched (above), so never attempted and never reported. Once matched, the JPEG is wrapped in a one-page PDF inside the 50 KB – 2 MB window. | Proved in a real browser against the portal's own rule text. |
| "3 of 3 filled" on a page with five uploads | Upload boxes the matcher could not name were dropped from the report. | `unrecognisedUploads` in the fill report; the panel counts and names them. |

| Claim | Test |
|-------|------|
| Every requirement on the captured page reaches its key, with no confident mistake | `matching/test-portal.test.ts` |
| No navigation link becomes an upload slot | `test-portal.test.ts` → "takes no navigation link" |
| Filled the way Fill fills, each box holds its own document, and nothing is named "income" | `documents.spec.ts` → "puts each document in its own box" |
| A window placement cannot reach the page's own boxes — proved to fail with the old whole-page search, reproducing the report | `documents.spec.ts` → "never reaches the page's own file boxes" |
| The photo keeps its shape under "20 KB – 200 KB"; a JPEG becomes a PDF under "PDF, 50 KB – 2 MB" | `derivation.spec.ts` |
| A photo is never trimmed; paper documents still are | `intake.test.ts` |

**One thing not proved:** the user's own run cannot be replayed, so it is not
certain the income certificate took the route above rather than, say, a vault
Photo slot holding the wrong file. The route above produces that exact refusal,
and it is closed. The portal now shows the size and pixels of a refused file,
which settles it if it recurs.

# One vault per person, not one vault for everybody

Every user got the same vault: seven qualification blocks of fifteen identical
fields, and every document folder the taxonomy has. A Karnataka student who
went CBSE Class 10 → PUC → B.Tech through KCET scrolled past Diploma,
Postgraduate, Professional degree and Doctorate to reach their bank details.
The "+ Add a qualification" control that preceded this kept its answer in React
state, so a block added by accident could not be removed and one added on
purpose vanished on reload.

| Change | Where |
|--------|-------|
| The user answers, once, what they studied — board, state, route after Class 10, stream, where they are now, entrance exams, category, claims | `ui/onboarding/PathSetup.tsx`, a card at the top of the panel |
| Those answers decide which blocks and folders exist | `matching/pathway.ts` (rules) + `ui/lib/vault-shape.ts` (groups) |
| The answers are sealed in the vault, not in `chrome.storage.local`: they name a reservation category | `vault.path` via `path:get` / `path:set` |
| A backup carries the settings, so a restored vault is laid out as it was left | `vault/backup.ts` |
| Folder and block titles follow the person's own board: "Class 10 (CBSE)", "PUC (Class 12)" | `vault-shape.ts` |
| The session-only "claimed" set is gone | `VaultEditor.tsx` |

For the path this was designed against — CBSE Class 10 in Karnataka, PUC
Science PCMB, B.Tech through KCET, fourth year, ST, 371(J) — the editor shows
Class 10, PUC, Undergraduate, the KCET folder, and three reservation questions
in place of twenty-one. Diploma, ITI, Postgraduate, Professional degree and
Doctorate are not there.

**Two rules make a wrong answer cheap.** A key that already holds a value is
always shown, whatever the path says; and each panel has a control that shows
the whole catalogue. The path decides what is *offered*, never what is
possible — the matcher still knows every key, and a form asking for a document
the path did not offer still names it and still reports "no master saved".

| Claim | Test |
|-------|------|
| The example student gets school, PUC and the degree, and not the four they never took | `matching/pathway.test.ts`, `ui/lib/vault-shape.test.ts` |
| Reservation narrows to the claims actually made | `pathway.test.ts` → "narrows reservation to the claims actually made" |
| Nothing invented: every key offered is in the taxonomy | `pathway.test.ts` → "invents no key" |
| A filled block is never hidden | `vault-shape.test.ts`, `VaultEditor.test.tsx` |
| A path that is not one reads as no path, rather than shaping the editor | `pathway.test.ts`, `background/path-service.test.ts` |
| Stored sealed: the category is not readable from the record | `path-service.test.ts` → "is stored sealed" |
| A restored vault keeps its layout | `vault.test.ts` → "carries the settings" |

## Which degree, in the words the university prints

`education.*.course` and `.branch` were free text with no vocabulary, so the
same degree became "btech", "B-Tech", "B.E CSE" and "comp sci" across four
applications — and the setup card could say somebody was reading Engineering
without recording *what*.

`matching/courses.ts` is a catalogue of about fifty degrees with their
branches, drawn from the user's own tree: B.E. / B.Tech with 36 branches, the
medical and AYUSH degrees, B.Sc with its sciences, B.Com / BBA / BMS, BA and
its humanities, the five-year law degrees, B.Des / B.Arch / B.Plan, and a short
postgraduate set.

| Change | Where |
|--------|-------|
| The setup card asks which degree and which branch, as dropdowns rather than forty buttons | `PathSetup.tsx` |
| The chosen pair is written into `education.<level>.course` / `.branch` — a value a form fills from | `VaultEditor.writeDegree` |
| Every course and branch box in the editor offers the same names through a `datalist` | `FieldRow.tsx`, `suggestionsFor` |
| The path carries `course` / `branch`; a path stored before this reads back with both null | `pathway.ts` |

**It suggests; it never restricts.** The boxes stay free text, because no list
of Indian degree titles is complete — "Not listed — I will type it" is the
first option in both dropdowns. A value the user typed themselves is never
written over: `writeDegree` skips a box that already holds something.

**Never on a masked field.** `FieldRow` drops suggestions for a high-sensitivity
key: a dropdown of values beside a password-type box is a way to read one
without revealing it.

| Claim | Test |
|-------|------|
| An engineering student is offered B.E. / B.Tech and its branches, not MBBS | `courses.test.ts` |
| A postgraduate is offered M.Tech, not B.Tech | `courses.test.ts` |
| The chosen degree reaches the block a form fills from | `VaultEditor.test.tsx` |
| A typed answer is never overwritten | `VaultEditor.test.tsx` |
| A course the catalogue lacks answers with no branches rather than a guess | `courses.test.ts` |

## The slots a student mid-degree actually holds

The taxonomy had no key for anything issued *during* a course, so a fourth-year
student had nowhere to put the papers a scholarship or an internship asks for.
Thirty-one document keys and fifteen field keys were appended:

| Folder | Slots |
|--------|-------|
| College (the course you are on) | semester marks card, consolidated marks card, bonafide certificate, college ID card, admission letter |
| Caste and reservation | Form-D caste certificate, OBC certificate, EWS certificate |
| Work and internships | resume, internship offer letter, internship certificate, experience certificate, letter of recommendation |
| Courses and training | course, training, workshop, professional certification |
| Achievements and projects | hackathon, competition, merit, project report, project certificate, published paper, patent |
| Sports and service | sports, NCC, NSS, volunteering |
| ITI | ITI marks card, national trade certificate |

Text fields: `entrance.*` (which exam, registration number, roll number, rank,
score, year), `semester` and `year_of_study` on the generic block and on
diploma / undergraduate / postgraduate, and `eligibility.article_371j` — the
claim itself, which previously existed only as the RD number on its
certificate.

Each one carries a label, exactly one folder, its portal phrasings, and a
question in `fixtures/documents-portal/student-documents.html` matched by
`matching/documents.test.ts` (rule 5) — 92 questions there now.

Two judgements worth recording:

- **"Bonafide certificate" moved.** It was a phrasing of `doc.study_certificate`;
  it is now its own slot, because a bonafide is issued by the institution a
  student is *at* and a study certificate proves where they studied before.
- **A semester and a year of study have no traits entry on purpose.** The
  general rule vetoes any key for a field capped under three characters, on the
  reasoning that nothing meaningful fits in two — and "7" does.

**Folded rather than shown:** the four portfolio folders (work, courses,
achievements, sports) are offered to every student past school, since nobody is
asked whether they have been to a hackathon. They render one line each until
opened. Folders the path kept because of an *answer* — the KCET papers, the
caste certificates, the college's own documents — are open.

# A backup of the easy half

Export wrote the text fields and nothing else. The photo, the signature and
forty scans — the part that takes an afternoon and a scanner to replace — were
not in the file, and a restore on a new machine left every document slot empty.

| Change | Where |
|--------|-------|
| The backup carries the documents, sealed exactly as the vault holds them; export still decrypts nothing | `vault/backup.ts`, format version 2 |
| A version 1 file still restores, as a backup that had no documents in it | `parseBackup` |
| The file moves over the bus a piece at a time: a vault of scans is far past one message | `vault:export-begin/-chunk`, `vault:import-chunk/-commit` |
| An imported document entry is untrusted input and is dropped unless it is shaped like one | `looksLikeDocument` |
| Variants (portal-sized copies) stay out: a cache that rebuilds | `exportVault` |

| Claim | Test |
|-------|------|
| A document round-trips byte for byte, and its bytes appear in the file only as ciphertext | `vault.test.ts` → "carries the file, still sealed", "round-trips the file itself" |
| A six-megabyte vault splits and joins back to the same file | `backup-transfer.test.ts` → "splits a vault too big for one message" |
| A wrong passphrase keeps the pieces, so nothing is uploaded twice | `backup-transfer.test.ts` |
| Out-of-order pieces are refused rather than stitched | `backup-transfer.test.ts` |
| A cut never lands inside a character | `vault.test.ts` → "never cuts a character in half" |

## The same field, seven times

The editor showed all seven qualification blocks at once — fifteen identical
fields each — plus a generic "any qualification" block of sixteen. 121
education boxes, of which a school leaver fills about thirty, and the same
marks were typed twice: once under Class 12 and once under the generic block.

| Change | Where |
|--------|-------|
| Class 10 and Class 12 are shown; the other five are offered by name and appear when claimed, or when they already hold a value | `VaultEditor.tsx`, `conditional` groups in `field-groups.ts` |
| A question that names no qualification is answered from the most recent one held — whole record from one block, never a mixture | `matching/qualifications.ts` (test-first, 9 tests) |
| The generic block left the meter's denominator, since nobody fills it now | `vault/profile-store.ts` |
| The document folder "Identity" became "Identity documents"; the profile block above it is also called Identity | `field-groups.ts` |

| Claim | Test |
|-------|------|
| School shows, the rest are offered, a claimed block appears, a filled one is never hidden | `VaultEditor.test.tsx` |
| One qualification answers a level-less question, and a hand-typed value still wins | `matching/qualifications.test.ts` |
| An older vault's generic values still show, and still count | `VaultEditor.test.tsx`, `vault.test.ts` |

## Still open

- **Google's real upload window is unverified.** Whether it accepts a file
  placed this way can only be checked on a live form. The panel's fallbacks,
  in order: drop instead, then a copy to choose by hand.
- **PDF → JPEG in the worker** still runs pdf.js where STATUS already calls it
  untested; pass-through avoids it whenever the form accepts PDF.
- **A typeless `<button>Browse</button>`** inside a form is still blocked by the
  top-frame guard when the user presses it — the guard's existing rule, and it
  protects SPA submit buttons of the same shape.
- **File boxes inside a form's own iframes** are still not filled; nothing is.

# A reader that could not read

"Read details from this" answered **"Nothing could be read from this document.
Reading text from photographs is not available in this build."** — for every
photograph, and for every PDF that was a scan rather than a document with a text
layer. Which is nearly every document a student holds: a marks card is a
photograph of a marks card. The seam had been there since Phase 4 and had never
been filled in: `readDocumentText` took an optional `OcrEngine`,
`document-service.ts` held a `setOcrEngine` nothing called, and `extract.ts`'s
own header referred to an `ocr.ts` that did not exist.

## The engine, and where it is allowed to run

| Change | Where |
|--------|-------|
| Text recognition, bundled: `tesseract.js` with the SIMD-LSTM core and the English `best_int` pack. Every path it is given is a `chrome-extension://` one; `workerBlobURL` off, cache off | `src/offscreen/ocr.ts`, `vite.config.ts` → `ocrAssets()` |
| It runs in an **offscreen document** — recognition needs a Web Worker and a service worker cannot start one — opened on demand and closed when the reading is done | `src/background/ocr-host.ts`, `src/offscreen/ocr.html` |
| Before recognition: a scanned PDF is rasterised, an image decoded, and either upscaled to 2000 px wide and re-encoded, because a phone photo at 700 px reads as noise | `ocr-host.ts` → `renderForReading` |
| `offscreen` added to the manifest's permissions, with the reason written down in three places a reviewer reads | `manifest.config.ts`, `STORE_LISTING.md`, `PRIVACY.md` |
| A build that lost its model fails the build rather than shipping a reader that cannot read | `scripts/verify-dist.mjs` (4 entries, two with a 1 MB floor) |
| Which languages exist is a table, so a second one is a data change | `src/documents/ocr.ts` → `BUNDLED_MODELS`, `modelsFor` |

About **9.2 MB** of wasm and models in `dist/ocr/`, copied from `node_modules` at
build time. That is the honest cost of reading a document without sending it
anywhere.

## Knowing what it is reading

Text alone is not an answer: "1234567" beside "REGISTER NUMBER" means one thing
on a Class 10 card and another on a degree transcript. The vault has always known
which slot the user filed a document under — it was simply never passed to
the reader.

| Change | Where |
|--------|-------|
| The slot travels with the read, as a hint. The bus is unchanged: `doc:extract` still carries only an id | `extract.ts` → `ExtractionHint`, `document-service.ts` |
| Marks cards: board, school, register **or** roll number, year, subjects, marks, max, percentage, result — filed under the qualification the slot names (`doc.marksheet_10` → `education.class_10.*`). Transfer, study and migration certificates land in the same block when the slot names a level, and in none when it does not | `documents/extract-education.ts` (test-first, 23 tests) |
| Certificates: the **RD number** into the box for *that kind* of certificate, plus community, category, income, domicile state, and the 371(J) claim itself | `documents/extract-claims.ts` (test-first, 11 tests) |
| An address, from the one document that carries the holder's own | `documents/extract-address.ts` (test-first, 5 tests) |
| Entrance papers: the exam's own name beside its CET/application number, hall-ticket number, rank, score and year | `documents/extract-entrance.ts` (test-first, 10 tests) |
| A passbook's words, which a scholarship form asks for: bank, branch, the name the account is held in, the kind of account. Plus a labelled driving-licence number | `documents/extract-bank.ts` (test-first, 10 tests) |
| A third channel beside candidates and warnings: **notes** — what was read and deliberately not offered | `extract.ts` → `ctx.note` |
| A dozen rows at once are grouped under the vault editor's own headings, in its order, each group with a tick-all | `ui/vault-editor/ExtractedDetails.tsx`, `groupFor`/`groupOrder` in `field-groups.ts` |
| No offer to read a face photograph, a signature or a thumb impression: nothing is printed on one | `DocumentsPanel.tsx`, gated on `roleFor` |

| Claim | Test |
|-------|------|
| The bundled wasm and model actually recognise text, in a real browser | `e2e/ocr.spec.ts` → "reads the words off a rendered page, with nothing fetched" |
| Nothing is fetched while reading: no request leaves the extension's own origin | same test, asserting on every request the page made |
| The reader's page is opened on demand and closed again | `e2e/ocr.spec.ts` → "the worker can open the reader’s page, and closes it again" |
| The engine never reaches a page | `no-ocr-in-content.test.ts`, unchanged and still passing |
| A caste certificate's number never lands in the income certificate's box | `extract-claims.test.ts` |
| A school's address never becomes the applicant's | `extract-education.test.ts`, `extract-address.test.ts` |
| A marks card pre-ticks nothing: it carries no checksum | `extract-education.test.ts`, `ExtractedDetails.test.tsx` |
| Ticking a group writes nothing until Save, and then only that group | `ExtractedDetails.test.tsx` → "saves only the group the user ticked" |
| A level is never guessed for a certificate whose slot names none | `extract-education.test.ts` → "guesses no level for a certificate whose slot names none" |
| A photograph is offered no reading, and a marks card is | `DocumentsPanel.test.tsx` |

## What it will not do, said on the screen rather than left silent

A user holding the card can see what is missing, and silence reads as a misread.
So the reader says it: **the individual subject marks have no box** (the subject
names are one list; the total and the percentage are saved), and **the school's
address is not saved as your address** (only an Aadhaar card carries the holder's
own). Both appear only when the card actually had them.

## Still open

- **Three alphabets: English, Kannada, Devanagari.** The other eight Tesseract
  models remain one table entry and one file away. A Tamil or Bengali document
  still gets the honest message it got before.
- **Handwriting is not read.** Tesseract is a print engine. A handwritten
  register number will come back wrong or not at all, which is why nothing from a
  card is ever pre-ticked.
- **The rules are proved against realistic OCR text, not against scans.** Every
  parser test is a fixture of what recognition gives back for a card of that
  shape. The one thing no test can stand in for is the user's own marks card,
  read by hand against the card itself.
- **PUC and degree cards beyond the shapes tested.** Each new card shape is a
  fixture and, at most, a label; the machinery does not change.

# What the reader actually returned, on real documents

The reader shipped and was then pointed at the user's own vault. Five documents,
four bad outcomes, and none of them the kind of failure a fixture test can have:

| What they saw | What it was |
|---------------|-------------|
| PAN card: **"A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received"** | The sizing step only ever scaled pictures *up*. A 2944 × 4224 photo — 12.4 megapixels — went to the engine untouched, recognising it outlived the thirty seconds MV3 gives an idle service worker, and the worker was collected with the panel still waiting. |
| 2nd PUC card: board read as **"a. E Shb zn DEPARTMENT OF PRE-UNIVERSITY EDUCATION fe” |"**, subjects as "Bl oor wx ori) Sr, lin" | Only English was bundled. Every Karnataka document prints each heading in Kannada *and* English on one line; read with English alone the Kannada half does not disappear, it comes back as broken Latin spliced into the English — and then lands in the vault. |
| Aadhaar: "a number … fails its check digit" | A photograph lit from one side, thresholded as one page. The Verhoeff check did its job — it refused a misread rather than storing it — but the misread was avoidable. |
| Cancelled cheque: nothing at all | Every rule was label-anchored, and a cheque labels nothing. The image was also 780 × 716, which is below what any engine can read. |

## The picture, before the engine sees it

| Change | Where |
|--------|-------|
| A page is scaled **both ways** now, to a 2400-pixel long edge and at most 6 megapixels | `documents/preprocess.ts` → `readingScale` |
| The lighting is taken out of the picture: the paper is modelled from the brightest pixel in each of 16 × 16 blocks, the page is divided by that model, and one Otsu threshold then fits the whole page | `preprocess.ts` → `prepareForReading` |
| A guard against making things worse: a result that is nearly all ink, or nearly none, is thrown away and the plain greyscale used instead — speckle reads as words that were never there | same, `MIN_INK`/`MAX_INK` |
| The engine is handed a **PNG**, not a JPEG: JPEG's artefacts sit exactly where text does | `ocr-host.ts` → `renderForReading` |
| A scan too small to read says so, instead of offering values read off it | `tooSmallToRead` — the user's cheque and certificates are all under it |
| The worker is kept alive for the length of a reading, and a reading that runs past 150 seconds is called off in our own words | `ocr-host.ts` → `keepAlive`, `READ_TIMEOUT_MS` |

Sauvola's local threshold was tried first and dropped: it keeps thin strokes
beautifully and hollows out anything thicker than its window, which on a marks
card means the headings.

## Two alphabets, because the documents have two

| Change | Where |
|--------|-------|
| Kannada and Devanagari packs ship beside English (+3.3 MB) | `vite.config.ts` → `ocrAssets()`, `verify-dist.mjs` |
| Which alphabets to expect comes from **the user's own path** — the state they set up with — so nobody is asked a question about scripts | `documents/ocr.ts` → `scriptsForState`, read in `document-service.ts` |
| English is read first; the local script is a second reading, paid for only by the documents that need it | `ocr-host.ts`, `readWrongAlphabet` |
| The two readings are **merged, not chosen**: a second alphabet costs a little English accuracy (measured: `PRIYA S` → `PRIYA 5`), and English is what every rule reads, so the bilingual page is kept with each line's English taken from the English-only pass | `ocr.ts` → `mergeReadings` |
| Rules read one alphabet still: a line is reduced to what it says in English, with a Kannada-only label translated and a value printed in one script left alone | `documents/bilingual.ts` → `latinise` |
| The fragments a misread leaves at the ends of a line are stripped — never the value side of a label | `bilingual.ts` → `trimNoise` |
| A cheque's unlabelled account number is offered, at a confidence that says nothing on the page confirmed it | `extract-bank.ts` |
| The text the engine produced is shown on request, with an honest word about how sure it was | `ExtractedDetails.tsx` |

| Claim | Test |
|-------|------|
| A huge photograph is shrunk, a small one enlarged, and neither exceeds what the engine can read in a sitting | `preprocess.test.ts` → "shrinks a 12-megapixel photograph…" |
| Ink survives in the bright half *and* in the shadow, which one threshold cannot manage | `preprocess.test.ts` → "keeps the ink in the bright half and in the shadow" |
| A picture with no text in it is not thresholded into speckle | `preprocess.test.ts` → "when thresholding would make things worse" |
| The worker is kept alive, the wait is bounded, and the page goes over losslessly | `ocr-host.test.ts` → "a reading that takes a long time" |
| The Kannada pack in this package really reads Kannada, in a real browser, fetching nothing | `e2e/ocr.spec.ts` → "reads a bilingual card in both alphabets" |
| A bilingual PUC card yields its register number, parents, college, totals and six subjects | `extract-education.test.ts` → "a card printed in Kannada and English" |
| A value printed in one script only is never deleted — an Aadhaar name in Devanagari still reads | `bilingual.test.ts`, `extract.test.ts` |
| "Father's Name" is a label, not a misread | `bilingual.test.ts` → "never eats a value" |

## Still open, honestly

- **A second alphabet costs some English accuracy.** The merge above recovers
  most of it, and it cannot recover a line the English pass never read.
- **Handwriting is not read.** Tesseract is a print engine.
- **The user's own certificates are 904 × 1280 and the cheque 780 × 716.**
  Enlarging does not put back detail the camera never captured; the reader now
  says so rather than offering values it misread. Re-photographing those at about
  2000 pixels is the single biggest thing left, and it is not code.
- **Nothing here is proved against the user's actual scans** — only against
  fixtures of what recognition returns for cards of that shape, and against a
  real browser reading a rendered bilingual line.

# One suggestion from the richest document in the vault

Pressed on an e-Aadhaar letter, the reader returned a page of recognised text,
**one** saveable detail, and a warning that the photograph was bad. The letter
carries an addressed block of labelled lines — S/O, VTC, PO, Sub District,
District, State, PIN Code, Mobile — and none of it was read.

| Change | Where |
|--------|-------|
| The e-Aadhaar block is read: village (VTC), taluk (Sub District), district, state, PIN, post office, mobile, and S/O as the father's name | `documents/extract-aadhaar.ts` |
| **A VID is no longer read as an Aadhaar number.** Sixteen digits in four groups: the first twelve are a 4-4-4 run followed by a *space*, so the "not part of a longer run" guard never fired, the checksum failed on a number read perfectly, and the user was told to retake the photo | `extract.ts` → `extractAadhaar` |
| The masked number says it is masked — every downloaded e-Aadhaar prints `XXXX XXXX 5521`, so there is nothing to read and nothing to blame | `extract-aadhaar.ts` |
| The enrolment number and the VID are reported as read and not saved, rather than filed somewhere they do not belong | same, as notes |
| `address.permanent.taluk` / `address.correspondence.taluk` appended to the taxonomy, with synonyms | `matching/taxonomy.ts`, `synonyms.json` |
| Labels are matched as the engine *actually returned them*: "S/O:" as `5/ಲಿ:`, "District," as "Destict," — the guard is the value (a place name, six digits, a person's name), not the spelling of the label | `extract-aadhaar.ts` |
| The suggestion screen is a table: detail, value read, and the tick at the end of the pair | `ui/vault-editor/ExtractedDetails.tsx` |

| Claim | Test |
|-------|------|
| The addressed block yields nine or more details, each a key the taxonomy has | `extract-aadhaar.test.ts` |
| The taluk is not filed under city or district | `extract-aadhaar.test.ts`, `deterministic.test.ts` |
| A VID never becomes an Aadhaar number, and raises no warning | `extract-aadhaar.test.ts` |
| The same letter read as recognition actually returned it still yields seven or more | `extract-aadhaar.test.ts` → "the same letter, as recognition actually returned it" |
| These labels read no address off a marks card that names a district | `extract-aadhaar.test.ts` |
| A form's "Taluk" fills from the new key, above the auto-fill band | `deterministic.test.ts` |
| The label comes first, the value next, the tick last | `ExtractedDetails.test.tsx` |

**Still not saved, and said so on the screen:** the enrolment number (no box in
the taxonomy) and the VID (temporary by design). The Aadhaar number itself
cannot be read from any downloaded letter — it is masked on the document.

# The channel closed again, on a small picture

After the Aadhaar work the same error came back — "A listener indicated an
asynchronous response by returning true, but the message channel closed before
a response was received" — on a 1080 × 1615 letter, so size was not the
cause this time. Two reads were running at once, and each killed the other.

**Why two.** The side panel mounts under React's StrictMode, which runs an
effect twice in development, so one press of "Read details from this" sent
`doc:extract` twice. Harmless while a read took a few seconds; the two-pass
bilingual read made the overlap certain.

**Two ways they killed each other**, both fixed, both proved to fail first:

| Mechanism | Fix | Proof it bit |
|-----------|-----|--------------|
| Every read closed the one offscreen reader on its way out, so the first to finish shut it under the second | Reads are queued; the page is closed only by the last read out | `ocr-reads.test.ts` — with the old per-read close restored, three of its tests fail on `CLOSED-MID-READ` |
| The reader page kept one engine and **terminated** it whenever a reading wanted other alphabets — the second pass (`eng+kan`) killed the engine the first (`eng`) was still using | One engine per alphabet set, never replaced while in use; readings run one at a time | `e2e/ocr.spec.ts` → "answers two overlapping readings that want different alphabets" failed in a real browser with the user's exact message, and passes now |

And the cheapest fix of the three: a second request for a document already being
read shares the first one's answer (`document-service.ts` → `readsUnderWay`), so
one press is one read.

# Phase 1: PaddleOCR reads the documents

Tesseract is gone. The reader is PaddleOCR — its PP-OCRv5 text detector and its
English recogniser — running on ONNX Runtime in a dedicated Web Worker, started
by the offscreen page. It was chosen by measurement (Phase 0, on the user's own
five documents): Tesseract read 91 of 120 printed phrases, PaddleOCR 114.

## Why a port, not PaddleOCR's SDK

PaddleOCR ships a browser SDK (`@paddleocr/paddleocr-js`). It cannot run in an
extension page: its OpenCV.js builds functions with `new Function`, which the
extension's CSP (no `unsafe-eval`, by MV3 rule and by choice) refuses. ONNX
Runtime itself needs only `wasm-unsafe-eval`, which was already granted for
Argon2id. So PaddleOCR's models run on ONNX Runtime directly, and the steps
around them are ported from PaddleOCR's own code as pure functions:

| Step | Where |
|------|-------|
| Scale for detection — at the page's own resolution, as PaddleOCR's **pipeline** does (the detector's own file says "long side 960", and following it lost small print) | `documents/paddle.ts` → `detectionSize`, `PIPELINE_DETECTION` |
| Find the text boxes — threshold, a **rotated** rectangle per region (convex hull, rotating calipers: OpenCV's `minAreaRect`), score inside the rectangle, unclip | `paddle.ts` → `findTextBoxes` |
| Warp each box upright, 48 pixels tall, padded to 320 | `paddle.ts` → `cropForRecognition` |
| CTC decoding against the model's own character list | `paddle.ts` → `decodeCtc` |
| The reading loop, batched by width | `documents/paddle-reader.ts` → `readPage` |
| Boxes back into lines, each value paired with the label beside it; the English model's guesses at Kannada dropped by score | `documents/layout.ts` |

Two measured corrections shaped the port. An upright box around a slanted line
is mostly background: its score fell below 0.6 and every long line of the
Form-D paragraph vanished, until the rectangle was allowed to rotate. And
detecting at 960 pixels instead of the page's own size cost small print and
merged words into long lines.

The models are fetched **at build time** from PaddleOCR's model host and pinned
by SHA-256 (`scripts/fetch-ocr-models.mjs`); a changed archive fails the build.
Their YAML settings are converted to JSON at build time by a real parser, so the
extension ships no YAML parser; the recogniser's 436 characters were checked
identical, in order, to PaddleOCR's own dictionary file.

## On the user's five documents

The extension's own pipeline code (same modules, same models, same runtime), in a
real Chromium, against the answer key from Phase 0:

| | Phase 0 Tesseract | Phase 1 |
|---|---|---|
| Printed phrases read | 91 / 120 | **114 / 120** — the same as PaddleOCR's own SDK |
| Fields the vault gets | 5 / 34 | **33 / 34**, none wrong |
| Time per document (one CPU thread) | 1–10 s | 4–12 s — the same as the SDK, measured side by side |
| Requests off the machine | none | none |

Field rules closed on the way, each test-first against the reader's real output
shapes (values changed): a name certified in a sentence ("This is to certify
that …", with the parents on the certificates); CBSE's seven-column rows behind
a subject code; the PUC's rows with the register number and exam month
repeated; a totals line's maximum; "Month/Year"; "College" but never "College
Code No."; the Aadhaar name under "To"; a certificate number printed twice; the
income certificate's own sentence; a zero read as the letter O. And a
better-evidenced reading of a field now replaces a weaker one, whichever rule
spoke first.

## What went, and why

Tesseract and its three language packs; the two-pass English-then-Kannada
reading and its merge; the lighting-flattening pass (it suited Tesseract, which
thresholds a page whole; PaddleOCR's models were trained on photographs and
read them better untouched); choosing alphabets from the user's state. A
Devanagari recogniser of the same generation exists; adding it is one pinned
archive and a per-box choice between recognisers.

## Still open

- ~~**The income figure on the user's own certificate.**~~ Closed in Phase 2,
  from the words the certificate spells the amount in. (The English recogniser
  still drops the bold figure; PaddleOCR's own two-step crop was tried and read
  slightly worse overall — 112 phrases, 32 fields — so it was not adopted.)
- **Kannada text is not read**, deliberately: no vault field on these
  documents needs it, and PaddleOCR's only Kannada model read worse than none.
- ~~**One CPU thread.**~~ Closed in Phase 2: the extension's pages are
  cross-origin isolated and the reader uses up to four.
- **Handwriting** is still not read.

# Phase 2: what the reader learned next

Five things, each measured on the user's own five documents with the
extension's own modules in a real Chromium. The sixth — documents not yet
measured — waits on pictures.

| | Phase 1 | Phase 2 |
|---|---|---|
| Fields the vault gets | 33 / 34 | **34 / 34**, none wrong |
| Printed phrases read | 114 / 120 | 114 / 120 |
| The same, with every document handed over sideways or upside down | nothing read | **34 / 34 and 114 / 120**, each of the three ways |
| Per-subject marks (CBSE Class 10, 2nd PUC) | not saved | all five, and all six; each card's subjects sum to its printed total |
| Five documents, read one after another | 70 s and 77 s on one thread | **33 s and 32 s** on four, same text, same fields |
| Requests off the machine | none | none |

## The piece of the card beside each value

The suggestion screen has always quoted the line a value came from. But the
value and the quoted line come from the same reading: a "3" misread as an "8" is
an "8" in both, and they agree perfectly. So each value is now shown beside the
piece of the document it was read from — the one thing on that screen the reader
did not produce.

Boxes travel as shares of the page (`documents/evidence-region.ts`), since a
photograph may be shrunk before it is read; the piece is cut from the document
**as stored**, in the service worker (`document-service.ts` → `evidenceCrops`),
and reaches the panel as a data URI. Boxes are passed on only when they are,
line for line, the text being returned (`read-document.ts`) — the wrong piece
would be worse than none. Looked at, not just asserted: the name and totals
crops off the real PUC card are the right pieces.

## The income figure, from the words

The one field Phase 1 missed. The recogniser drops the bold figure on that
line and reads the words after it, so the amount is taken from the
words when the figure is absent (`documents/number-words.ts`, Indian
counting, tolerant of a clipped word, and silent when two readings tie). It is
offered at lower confidence than a figure, and a figure and words that disagree
raise a warning rather than a value.

## Each subject's own marks

An entrance form asks for Physics, Chemistry and Mathematics by name. The vault
now has a box for each: 21 keys appended to the taxonomy (`marks_physics` …
`marks_social_science`, generic and at Class 10 and 12), with the user's stream
deciding which Class 12 boxes are shown (`matching/pathway.ts` →
`SUBJECTS_FOR_STREAM`; no stream, or "other", shows all of them, and the total
is never hidden — `markSubjectOf` tells a subject from `marks_obtained` by name).

| What | Where |
|------|-------|
| Each row's marks into its subject's box, never pre-ticked; subjects with no box are named on the screen as read and kept only in the list | `extract-education.ts` |
| A name the reader damaged is mended: **MAT JEMATICS** and **MAT!JEMATICS**, both read off the user's card, where the H is broken in print. One wrong letter, in a name of seven letters or more, compared as a whole word — Physical Education is not Physics, Geology is not Biology | `extract-education.ts` → `mended`, `undamaged` |
| A long word with a stray mark inside it is a damaged word, not noise to strip from the line | `bilingual.ts` → `DAMAGED_WORD_LETTERS` |
| A form's "Physics Marks" / "Marks obtained in Chemistry" finds the box, and takes the level the form names | `synonyms.json`, `deterministic.test.ts` → "each subject’s own marks" |
| One language box, and it is the **first** language: "Second Language", "Third Language", plain "Language" and a named language are left for the user | same |
| A box labelled only "Physics" is not filled | same |

**A matcher rule changed with it**, and is recorded here because it touches
every form, not just marks. Several phrases of one key partly matching a label
through the *same word* used to count as corroboration, which lifted a key past
the single-weak-signal cap on nothing but how many ways the dictionary says it —
and would have filled "Physics" with the Physics marks the day that key had five
phrases. A key with nothing but partial matches now keeps one per distinct set
of shared words (`deterministic.ts` → `distinct`); a key the label names
outright is scored exactly as before. Measured on all 349 fixture fields before
and after: three flagged fills that were wrong are gone ("Licence Serial
(allotted by this office)" as a driving licence, "Ward Inspector's Remarks" as a
defence ward, a "same as permanent" tick box as a taluk); one flagged fill that
was right is lost (a column the jsdom harvest labels just "Marks"); nothing
auto-filled changed, and the A.2.1 record is byte-identical.

## Sideways photographs

The recogniser reads upright text and nothing else, so a page photographed
sideways read as nothing. PaddleOCR's page-orientation classifier
(`PP-LCNet_x1_0_doc_ori`, 6.8 MB, fetched at build time and pinned by SHA-256
like the other two) now runs first, in about 15 ms.

- Twenty of twenty right on the five documents turned all four ways, never less
  sure than 0.86. A page is turned only above 0.7 (`paddle-reader.ts` →
  `ORIENTATION_MIN_CONFIDENCE`): a sideways page left sideways reads as badly as
  it did before, and an upright page turned on a guess loses a good reading.
- Turned by moving whole pixels (`paddle.ts` → `rotateQuarter`), so nothing is
  resampled.
- The user is told ("This picture was sideways, so it was turned upright before
  it was read"), and the pieces shown beside each value are cut from the stored
  picture and turned upright (`evidence-region.ts` → `unturnBox`, `raster.ts` →
  `turn`). Looked at for all three turnings.
- In the built extension, under its CSP: `e2e/ocr.spec.ts` → "stands a page
  photographed … upright, and reads it", three ways.

## More than one thread

Reading is now on up to four CPU threads: half the machine's cores, so the
browser the user is sitting at stays usable (`preprocess.ts` → `readerThreads`).

Threads share memory, and Chrome allows that only on a cross-origin isolated
page, so the manifest now carries `cross_origin_embedder_policy: require-corp`
and `cross_origin_opener_policy: same-origin`. **That isolates every page of the
extension**, not only the reader's. It grants nothing and reaches no site; it
narrows what these pages may embed, and none of them embeds anything from
another origin. The full browser suite — 119 tests across every page — passes
with it on.

Two things that fail silently are pinned. ONNX Runtime starts each thread by
loading the file it lives in, so it is loaded as a file of its own; bundled into
the reader, every thread would have started a second reader (the bench did
exactly that, and hung). And the thread count is taken from
`crossOriginIsolated` rather than assumed, so a page that is not isolated reads
on one thread, as before.

| Claim | Evidence |
|-------|----------|
| The built manifest isolates the pages; the runtime is one file of its own and is not inside the reader | `scripts/verify-dist.mjs` |
| The same, in the source, and the worker is listening before it loads anything | `release-gates.test.ts` → "the reader’s threads" |
| In the built extension the reader's page is isolated, and the runtime's file is loaded once per thread — from the package, with no CSP violation and nothing fetched | `e2e/ocr.spec.ts` → "reads on more than one CPU thread, because its page is isolated" |

## Still open

- **PAN, passbook and cheque, and the KCET papers are not measured.** The
  rules for them are tested against fixtures of what a reading looks like, not
  against the user's own documents. It needs pictures.
- **Not yet pressed in the installed extension.** Every number above is from
  the extension's own modules and its built package driven by tests; nobody has
  yet reloaded it and pressed "Read details from this" on a saved document.
- **One language box.** An SSLC card has three languages; the second and third
  are read and kept in the subject list only.
- **Kannada text is not read**, and **handwriting** is not read.
