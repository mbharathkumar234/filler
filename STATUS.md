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
| 7-10 | Document section with thumbnails vs. requirement | 🔴 | `ReviewDocument` is a stub — `problem: 'Attach from the Documents panel'`. No thumbnails, no size-vs-requirement comparison. |
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
| 10-1 | Strict CSP, no eval, no remote code | 🟢 | built `manifest.json` inspected; no `.wasm` file in `dist/` |
| 10-2 | `npm audit` + licence check | 🟢 | 0 vulnerabilities; ISC/MIT/Apache-2.0 only |
| 10-3 | Isolation review | 🟡 | `docs/ISOLATION_REVIEW.md` — 8 claims each citing a test. It is a document, not a test. |
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

**Not started (Phase F Should):** UI localisation (Hindi + one regional
language) and the Firefox port. The Devanagari synonyms exist in the matcher;
the *interface* is English only.
