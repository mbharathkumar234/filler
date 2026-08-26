# AutoFill Assistant — Completion Plan (from ~80–90% built)

Companion to `IMPLEMENTATION_PLAN.md`. That document assumed a green field. This one assumes most of the code exists and asks a different question: **which gates actually pass?**

---

## 0. Read this before planning the remaining work

The original plan's checkpoints were deliberately written as *verification* bars, not *code-existence* bars. Re-read a few:

- "zero high-confidence **mis**-mappings across three fixture portals"
- "run it 20× — flakiness here is a real defect, not test noise"
- "canary test green in CI"
- "hand it to 3 people with one deliberately wrong value planted; all three should catch it"

None of these are satisfied by a file existing. A project of this shape can genuinely be 90% *written* and 30% *verified*, and the gap is invisible from the inside because everything compiles and the happy path demos beautifully.

That is not a claim that your progress is overstated — it's a claim about which 10% is left. In this specific project, the residual work concentrates almost entirely in the safety-critical and measurement-dependent parts: the submit guard, the PII boundary, pause/resume stability, and the mismatch rate on sites you never tuned against. Those are exactly the items that get deferred while feature code races ahead.

So Phase A is an audit, and it is not optional. Everything after it is contingent on what it finds.

**One methodological note:** if Claude Code wrote the code, don't let Claude Code self-assess it by assertion. Every audit row needs an **evidence artifact** — a named test that runs, a CI link, a screenshot, a recorded run. "Implemented" is not evidence. "`tests/submit-guard.spec.ts:41` passes" is.

---

## Phase A — Audit & ground truth

**Goal:** replace estimated completion with measured completion. One to two sessions. Produce `STATUS.md`.

### A.1 Run every checklist

For each Must-Achieve item in `IMPLEMENTATION_PLAN.md` Phases 0–10, record one row:

| Phase | Item | Status | Evidence | Notes |
|---|---|---|---|---|
| 5 | Submit guard blocks unarmed clicks | 🟢/🟡/🔴 | test path or "none" | |

- 🟢 **Green** — implemented *and* an automated test proves it.
- 🟡 **Amber** — implemented, no test, or test is happy-path only.
- 🔴 **Red** — not implemented, or implemented and failing.

Amber is the dangerous colour here. Expect most of the project to land there, and treat amber on any safety/privacy row as red.

### A.2 Measure the four numbers that can't be guessed

These are the real completion metrics. Everything else is bookkeeping.

1. **Mismatch rate.** Across all fixture forms: count high-confidence (≥0.85) mappings that are *wrong*. Target is zero. Report the actual number, not a percentage — one wrong-but-confident field is a P0.
2. **Coverage on a held-out site.** Pick a form you have never tuned against, profiled, or taught. Run it. Report: % fields mapped correctly, % unmapped, % mismatched. **This number is your universal-coverage estimate.** Nothing else is.
3. **Pause/resume stability.** Run the postback + fake-CAPTCHA + regenerated-ID fixture 20 consecutive times. Report pass count. Anything below 20/20 means Phase 6 is not done.
4. **Leak status.** Seed the vault with canary strings, run a full match cycle over every fixture, grep every outbound payload. Report: clean or not clean. Binary.

### A.3 Inventory the structural rules

Fast greps that catch architectural drift:

- Hard-coded selectors outside `site-profiles/` — should be zero.
- `.click()` / `.submit()` calls outside `submit-guard.ts` — should be zero.
- Any import path where vault values could reach `llm-client.ts` — should be structurally impossible.
- `<all_urls>` in the manifest — should be absent (see Phase F).
- Master key written to `chrome.storage.*` anywhere — should be absent.

**Phase A exit gate:** `STATUS.md` committed, with the four numbers filled in. Do not start Phase B until they exist. If a number is "we haven't measured that," it is red.

---

## Phase B — Close safety-critical gaps

**Goal:** make wrong submission structurally impossible, not merely unlikely. Nothing ships before this is green.

**Must Achieve**
- [ ] Submit guard installed at `document_start`, capture phase, covering `click`, `submit`, and `Enter` keydown.
- [ ] Approval token: 128-bit random, single-use, 90-second TTL, **burned before** the click is dispatched. Test: replaying a burned token does nothing.
- [ ] Adversarial tests, all passing:
  - fixture calls `form.submit()` on load → blocked
  - fixture auto-clicks its own submit button after 2s → blocked
  - approval token reused → blocked
  - approval token expired (advance clock 91s) → blocked
  - Enter keypress inside a text field that would submit the form → blocked
- [ ] Exactly one programmatic click per armed run, on exactly the element recorded in the plan. Test asserts the click count.
- [ ] Re-authentication before filling any `sensitivity: 'high'` key after idle.
- [ ] Abort path: Esc / panel close / tab close leaves no armed state behind.
- [ ] Audit log writes on every run — what was filled, flagged, edited, approved, and when.

**Verify:** write the adversarial fixture *first*, watch it break the current guard, then fix. A guard that has never been attacked is untested.

---

## Phase C — Close privacy-critical gaps

**Goal:** make PII egress structurally impossible, and prove it in CI.

**Must Achieve**
- [ ] `redaction.ts` is the only path to `llm-client.ts`. Enforce with an ESLint `no-restricted-imports` rule so a future careless import fails the build, not review.
- [ ] Outbound payloads contain only: label text, name/id, type, options, nearby text, maxLength, pattern. Nothing else. Schema-validate before send.
- [ ] Canary test in CI, blocking: vault seeded with unique strings across every sensitivity tier; full match cycle over all fixtures; assert zero canary occurrences in any request body, header, or URL.
- [ ] Document bytes and filenames unreachable from the LLM path — verified by the same canary mechanism using a canary filename.
- [ ] High-sensitivity values masked in the review UI until explicitly revealed; excluded from the audit log by default.
- [ ] Offline/no-key mode degrades to deterministic matching with a visible notice — no silent failure, no retry storm.

**Verify:** CI must go red if someone adds `profile.get('id.aadhaar')` inside the LLM code path. Test that by actually adding it on a scratch branch.

---

## Phase D — Stabilise pause/resume

**Goal:** get from "works when I demo it" to 20/20.

This is the phase most likely to be amber right now, because it demos fine and fails intermittently.

**Must Achieve**
- [ ] State machine is a pure reducer, unit-tested with no DOM, covering every transition in `IMPLEMENTATION_PLAN.md` §5.
- [ ] Run state persisted to `chrome.storage.session` on **every** transition; content script rehydrates on load.
- [ ] Forced `REVERIFYING` on: navigation, `__doPostBack`, and mutations touching >20% of tracked nodes.
- [ ] `REVERIFYING` re-resolves every selector, re-reads every filled value, refills resets, escalates unresolvable selectors to `DRIFTED`.
- [ ] `DRIFTED → NEEDS_TEACHING`. Never silently skip a field.
- [ ] Blocker detection covers reCAPTCHA/hCaptcha/Turnstile, image CAPTCHAs, OTP inputs, DigiLocker/eSign redirects, payment origins.
- [ ] Resume only on user signal or observer settle — **never a bare timer**.
- [ ] The hostile fixture (postback resets values + regenerates IDs + CAPTCHA gate) passes **20/20**.

**If it's 17/20:** the three failures are the product. Log every transition with timestamps, run it 50×, and find the race. It is almost always one of: resuming before dependent dropdowns repopulate, rehydrating stale refs after ID regeneration, or a MutationObserver firing mid-fill and triggering a spurious reverify.

---

## Phase E — Prove universal coverage

**Goal:** you've now said the target is *all* sites. This phase converts that from an aspiration into a measured number.

**Must Achieve**
- [ ] Fallback chain works end-to-end and degrades cleanly at every tier:
  1. profile hit → instant, no LLM call
  2. rules → autocomplete attrs, synonym dictionary, name/id tokens, option-set fingerprints
  3. LLM → capped at 0.8 confidence, flagged in review, **never** auto-fills a high-sensitivity key
  4. unsure → blank + unmapped, teach mode offered
  5. taught → profile written, site becomes tier 1 permanently
- [ ] A successful LLM run **writes a site profile**, so the model is called once per form for all time. Verify by running the same form twice and asserting zero API calls on the second run.
- [ ] Synonym dictionary is JSON, not code — extensible without a release. English + Hindi + at least one regional language for government labels.
- [ ] Teach mode fully working from both entry points (`NEEDS_TEACHING` and `DRIFTED`), writing versioned profiles with rollback.
- [ ] Profile health check: <60% of selectors resolving → mark stale, prompt repair, don't half-fill.
- [ ] **Held-out benchmark:** assemble 10 forms across varied stacks (old ASP.NET, React SPA, PHP, a Google Form, a plain HTML form) that you have never tuned against. Report mapped / unmapped / mismatched for each.

**Gate:** ≥85% correctly mapped and **zero** high-confidence mismatches across the held-out set. If mismatches are non-zero, fix the confidence model before adding any features — a confidently wrong field on an unfamiliar site is the failure mode that ends this product.

**Should Achieve**
- [ ] LLM extracts document constraints from on-page instruction text, feeding the derivation pipeline.
- [ ] Profile export/import so users can share mappings (selectors only, never values; sign and review anything you host).

---

## Phase F — Release readiness

**Goal:** something you can responsibly hand to strangers.

**Must Achieve**
- [ ] **Permissions:** `activeTab` + `scripting` + `storage` + `sidePanel`. No `<all_urls>`. Universal coverage comes from the user clicking your icon on whatever site they're on — same reach, defensible permission, far better store-review odds.
- [ ] Strict CSP, no `eval`, no remote code. Dependency audit + licence check.
- [ ] Page-hostility review: the portal page cannot reach vault data, the approval token, or the message bus. Validate sender on every message; reject page-context messages; schema-validate payloads.
- [ ] Crash safety: kill the browser mid-run → no half-armed state resumes.
- [ ] Onboarding: vault creation → guided profile entry → document upload with quality checks → first supervised fill on a demo fixture.
- [ ] Honest disclosure in-product: what it does, what leaves the device, what the user must verify, and that they remain responsible for anything submitted.
- [ ] Privacy policy + store listing matching actual behaviour, with per-permission justification.
- [ ] **Real-portal smoke test:** one live run per supported portal, stopped at review, never submitted.
- [ ] **User test:** 3 people, one planted wrong value, all 3 catch it. If they don't, redesign the review screen — it has one job.

**Should Achieve**
- [ ] Argon2id KDF with migration from PBKDF2 vaults.
- [ ] Accessibility pass — this is an accessibility product for many of its users.
- [ ] UI localisation (Hindi + one regional language).
- [ ] Firefox port.

---

## Triage: what's usually missing at "90% built"

Check these first — in projects of this shape they're amber far more often than the owner expects.

| Likely gap | Why it hides | Phase |
|---|---|---|
| Approval token TTL / single-use not enforced | Happy path never reuses a token | B |
| `form.submit()` and Enter-key paths unguarded | Only the button click was tested | B |
| Canary/leak test doesn't exist | Nothing visibly breaks without it | C |
| Redaction is a convention, not a boundary | Works until one careless import | C |
| Pause/resume passes 17/20 | Demos fine, fails on real portals | D |
| Dependent dropdowns filled before repopulating | Only breaks on slow networks | D |
| Profile not written after LLM run | Costs are invisible until the bill | E |
| Confidence thresholds untuned on unseen sites | No held-out set was ever built | E |
| Document derivation fails the byte window silently | Only tested on one photo | E |
| `<all_urls>` still in the manifest | Nothing breaks until store review | F |

---

## Claude Code session prompts

**Session 1 — audit**
> Read `IMPLEMENTATION_PLAN.md` and `COMPLETION_PLAN.md`. Execute Phase A only. Go through every Must-Achieve item in the implementation plan and produce `STATUS.md` with the audit table. For each row, cite a specific test file and test name as evidence, or write "none" — do not mark anything green on the basis of the code existing. Then measure the four numbers in A.2 and put the actual results in the file. Do not fix anything yet; I want the true picture first.

**Session 2 — safety**
> Execute Phase B. Write the adversarial fixtures first and show me them failing against the current submit guard before you change any guard code. Then fix until all five adversarial tests pass.

**Session 3 — privacy**
> Execute Phase C. Start with the canary test and the ESLint import restriction. Prove the rule works by adding a violating import on a scratch branch and showing CI go red, then revert it.

Then D → E → F, checking the gate each time.

---

## The one-line version

You likely have most of the code and a minority of the proof. Phase A tells you which. Everything left that matters is safety, privacy, stability, and one honest number measured on a site you never tuned against.
