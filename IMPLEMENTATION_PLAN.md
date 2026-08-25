# AutoFill Assistant — Implementation Plan

> Transcribed from `i.plan.af.pdf`. The PDF's text is stored as vector outlines and is not
> machine-readable by any text extractor; this file is the working copy. If the two ever
> disagree, the PDF is the source of truth.

A browser-extension–based assistant that stores a user's personal details and documents **once**,
then fills repetitive online forms (government, college, scholarship, exam, certificate portals)
on their behalf — pausing for human steps, stopping before submission, and requiring explicit approval.

Each phase has a goal, a hard "Must Achieve" definition-of-done, "Should Achieve" stretch items,
explicit out-of-scope items, and verification steps.

---

## Scope amendment — 2026-08-25: any portal

> **The product target is any portal, not three profiled ones.** This supersedes the
> three-target framing the PDF used for Phase 0 and Phase 4.

What this changes:

- **Site profiles are a cache, not a precondition.** `matching/deterministic.ts` (Phase 4) is
  built to work on a form it has never seen — synonym dictionary, `autocomplete` mapping, and
  `name`/`id` token heuristics carry the general case. A site profile is a fast path with
  recorded selectors, and the mechanism teach mode writes to.
- **Phase 8 (LLM fallback) and Phase 9 (teach mode) are core, not optional.** They are what
  makes "any portal" true for the fields rules miss. They still run *after* Phases 0–7.
- **§6.5 sequencing still holds.** Do not build the generic matcher before a working
  fill/review loop exists. Generality is the destination, not the build order.
- **Phase 0's portal gate is reframed, not deleted.** For a general-purpose tool the ToS
  question stops being a per-portal engineering gate and becomes a runtime disclosure plus
  per-site user responsibility (Phase 10). `docs/portal-notes/` remains the place to record a
  verdict for any portal you deliberately profile or ship a fixture for, and the §6.4 risk row
  is unchanged.
- **Phase 4's acceptance metric changes** from "≥70% across three fixture portals" to the same
  bar measured across a fixture corpus of *unseen* forms. See Phase 4 below.

Unaffected: Phases 1, 2, 5, 6, 7 and 10 are portal-agnostic as written.

---

## 0. Non-negotiable product principles

These are constraints, not preferences. Every phase is checked against them.

| # | Principle | Enforcement |
|---|-----------|-------------|
| P1 | **The user is present.** This assists a human at the keyboard; it is not an unattended bot. | No headless mode, no scheduled runs, no queue of accounts. |
| P2 | **Never auto-submit.** Submission happens only after an explicit approval action on a review screen. | Capture-phase submit interceptor (Phase 5), armed only by an approval token (Phase 7). |
| P3 | **Raw PII never leaves the device.** | LLM receives DOM skeletons and a field-key vocabulary — never values. Enforced by a redaction layer + test suite (Phase 8). |
| P4 | **Never defeat a security control.** No CAPTCHA solving, no OTP interception, no eSign automation. | Those states hand control back to the user (Phase 6). |
| P5 | **Every run is auditable.** | Append-only local audit log: what was filled, from where, what the user approved. |
| P6 | **One account, one user.** | No multi-profile bulk submission features. Ever. |

**Claude Code:** if a requested feature conflicts with P1–P6, stop and flag it rather than implementing it.

---

## 1. Technology decisions (locked)

| Concern | Choice | Reason |
|---------|--------|--------|
| Platform | Chrome Extension, **Manifest V3** | Runs inside the user's own authenticated session. No credential handling, no scraping infrastructure. |
| Language | TypeScript (strict) | Field mapping is schema-heavy; types catch most mapping bugs. |
| Build | Vite + `@crxjs/vite-plugin` | HMR for content scripts. |
| UI | React 18 + Tailwind | Side panel, review screen, vault editor. |
| Vault storage | IndexedDB via `idb` | Blobs (documents) + structured profile. |
| Crypto | WebCrypto, AES-GCM 256, key from PBKDF2-SHA256 (>=600k iters) | No external crypto dependency. Argon2id via WASM is a Phase 10 upgrade. |
| Run state | `chrome.storage.session` | Survives page reloads/postbacks, dies with the browser session. |
| Image pipeline | `OffscreenCanvas` + `createImageBitmap` | Client-side only; no upload of documents anywhere. |
| PDF handling | `pdf-lib` (write), `pdf.js` (render→raster) | Certificate merges, size reduction. |
| State machine | Hand-rolled reducer over a discriminated union | Auditable and serialisable. (XState is acceptable if you prefer; keep transitions declarative either way.) |
| Testing | Vitest (unit) + Playwright (e2e against fixture pages) | Fixtures are saved real portal HTML. |
| LLM | Anthropic API, `claude-sonnet-4-6`, called from the background service worker only | Single egress point → easy to audit for PII leaks. |

---

## 2. Repository layout

```
autofill-assistant/
├── CLAUDE.md                    # standing instructions (see §3)
├── IMPLEMENTATION_PLAN.md       # this file
├── manifest.config.ts
├── vite.config.ts
├── src/
│   ├── background/              # service worker: LLM calls, run orchestration
│   │   ├── index.ts
│   │   ├── llm-client.ts
│   │   └── redaction.ts
│   ├── content/                 # injected into portal pages
│   │   ├── index.ts
│   │   ├── harvester.ts         # DOM → FieldDescriptor[]
│   │   ├── filler.ts            # write values, dispatch events
│   │   ├── submit-guard.ts      # P2 enforcement
│   │   ├── picker.ts            # teach-mode element picker
│   │   └── overlay/             # in-page status pill, pause banner
│   ├── vault/
│   │   ├── crypto.ts
│   │   ├── db.ts
│   │   ├── profile-store.ts
│   │   └── document-store.ts
│   ├── documents/
│   │   ├── derive.ts            # master → variant
│   │   ├── constraints.ts       # parse "JPEG, 20-50KB, 3.5x4.5cm"
│   │   └── raster.ts
│   ├── matching/
│   │   ├── taxonomy.ts          # canonical field keys (see §4)
│   │   ├── deterministic.ts     # rule + score matcher
│   │   ├── profile-cache.ts     # site profiles
│   │   └── llm-matcher.ts
│   ├── runtime/
│   │   ├── machine.ts           # fill run state machine (see §5)
│   │   ├── plan.ts              # FillPlan types + fingerprinting
│   │   └── audit.ts
│   ├── ui/
│   │   ├── sidepanel/
│   │   ├── review/
│   │   ├── vault-editor/
│   │   └── onboarding/
│   └── shared/
│       ├── messages.ts          # typed message bus
│       └── types.ts
├── fixtures/                    # saved portal HTML, one dir per site profile
│   └── <site-id>/page-1.html
├── site-profiles/               # versioned JSON selector maps (shippable)
│   └── <site-id>.json
└── tests/
```

---

## 3. `CLAUDE.md` — write this first

Created before any code. See `CLAUDE.md` in the repo root.

---

## 4. The canonical field taxonomy (design this before anything else)

Everything — vault schema, matcher output, site profiles, LLM vocabulary, review screen — keys off
one stable namespace. Getting this wrong is expensive later. The authoritative list lives in
`src/matching/taxonomy.ts`.

**Rules:**

- Keys are append-only. Renaming a key breaks every shipped site profile — add a new one and alias.
- `sensitivity: 'low' | 'medium' | 'high'` is attached per key; `high` keys require re-authentication
  before fill (Phase 6).
- The LLM is given this list as a closed vocabulary and may only return keys from it, plus `"unknown"`.

---

## 5. The fill-run state machine (the hard part — design before Phase 5)

Because CAPTCHA/OTP hand control back to the user, and because ASP.NET postbacks regenerate DOM IDs,
the run **cannot** be a single linear pass. Model it explicitly — the `RunState` union is declared in
`src/shared/types.ts`.

**Transition rules that must be enforced by tests:**

- `FILLING → BLOCKED` on detecting a CAPTCHA widget, OTP input, or unknown security iframe.
- `BLOCKED → REVERIFYING` only on user signal ("I've done it, continue") **or** a MutationObserver
  settling event — never on a timer alone.
- Any `document` navigation, `__doPostBack`, or mutation touching >20% of tracked nodes forces
  `→ REVERIFYING`.
- `REVERIFYING` re-resolves every field ref; if any value was reset → refill it; if a selector fails
  → `DRIFTED`.
- `DRIFTED → NEEDS_TEACHING` (invite repair) — never silently skip a field.
- `REVIEW → ARMED` requires an explicit user gesture; `approvalToken` is a random 128-bit value with a
  **90-second TTL** and is single-use.
- `ARMED → SUBMITTED` permits exactly **one** programmatic click on exactly the element recorded in the
  plan. Token is burned first.
- Any state → `ABORTED` on user Esc / panel close / tab close.

**Persistence:** the entire `RunState` + `FillPlan` is serialised to `chrome.storage.session` under key
`run:${tabId}:${formFingerprint}` after every transition. Content script re-hydrates on load. This is
what makes pause/resume survive a postback.

**Form fingerprint:** stable hash of `{origin, pathname, sorted(field name/id/label tokens), form action}`
— deliberately excludes volatile ASP.NET `__VIEWSTATE`, GUID-ish ids, and index suffixes.

---

## Phase 0 — Foundations & legal groundwork

**Goal:** repo, toolchain, target list, and a written boundary of what you will and won't automate.

### Must Achieve

- [ ] Repo scaffolded; `npm run dev` loads an unpacked MV3 extension in Chrome with a working side panel showing "Hello".
- [ ] `CLAUDE.md` committed (§3).
- [ ] `matching/taxonomy.ts` committed with the full key list and per-key sensitivity (§4).
- [ ] **Three target portals chosen** and their ToS/acceptable-use pages read and summarised in
      `docs/portal-notes/<site-id>.md`, each ending with an explicit verdict: `assistive-ok` /
      `unclear` / `prohibited`. Do not build profiles for `prohibited`.
- [ ] `docs/THREAT_MODEL.md`: what an attacker gets from a stolen laptop, a malicious portal page,
      a malicious extension update, and a compromised API key.
- [ ] Fixture corpus: for each target, save the real form pages (`Ctrl+S`, complete) into
      `fixtures/<site-id>/`. Strip any real PII from fixtures.

### Should Achieve

- [ ] `npm run fixtures:serve` serves fixtures locally so e2e tests never touch live portals.
- [ ] CI running lint + unit tests.

**Out of scope:** any real form filling.

**Verify:** `npm test` passes; extension loads; a teammate can read `docs/portal-notes/`
and understand which portals are in-bounds.

---

## Phase 1 — The vault

**Goal:** encrypted local storage for profile data. No forms yet.

**Status: complete.** 124 unit tests green.

### Must Achieve

- [x] `vault/crypto.ts`: AES-GCM 256 encrypt/decrypt; key derived from passphrase via PBKDF2-SHA256
      >=600k iterations, per-vault random salt, per-record random IV. **Unit tested**, including
      tamper-detection (flipped ciphertext byte → decrypt throws).
- [x] Master key held only in the service worker's memory, never persisted, never in `chrome.storage.local`.
      Key is non-extractable; `vault/session.ts` is its only owner.
- [x] Auto-lock: key zeroed after 15 min idle or on browser close. The deadline is checked on every
      key access, not only by a timer, so a suspended service worker cannot extend the window.
- [x] `vault/profile-store.ts`: CRUD over the taxonomy, with per-key `{value, verifiedAt, source}` provenance.
- [x] Vault editor UI: user can enter profile data once and see it persisted across a browser restart
      (re-entering passphrase).
- [x] Export/import of an encrypted backup file (`.afvault`), with a scary-but-clear warning.

### Should Achieve

- [x] Field-level validation: Aadhaar Verhoeff checksum, PAN regex, IFSC format, PIN code range, DOB sanity
      (plus mobile and email).
- [x] "Completeness meter" — % of taxonomy filled, so users can front-load data entry.
- [x] Passphrase strength meter; refuse anything under a reasonable floor (50 bits, 12 characters).

**Out of scope:** documents (Phase 2), cloud sync (never, or a much later deliberate decision).

**Verify:** kill the browser, reopen, unlock, data intact. Inspect IndexedDB in DevTools — you must see
only ciphertext. Wrong passphrase → clean failure, no partial decrypt.

*Automated equivalents:* `vault.test.ts` "at-rest inspection" serialises the raw profile store and
asserts no canary plaintext appears; `session.test.ts` "survives a simulated browser restart" drops the
session and re-unlocks; the wrong-passphrase path is covered in both. The DevTools inspection itself is
still worth doing by hand once.

## Phase 2 — Document vault & the derivation pipeline

**Goal:** store one high-quality master per document; generate portal-specific variants on demand.
This is the "upload once" promise and it is where a lot of the real value lives.

**Status: complete.** 252 unit tests + 13 e2e green.

### Must Achieve

- [x] Store masters as encrypted blobs with metadata `{key, mime, bytes, width, height, dpi, pages, capturedAt}`.
      DB schema v2 adds `documents` and `variants` stores. Filenames are deliberately **not** stored.
- [x] `documents/constraints.ts`: a `DocConstraint` type plus a parser that turns portal instruction
      text into one. 44 tests over a 12-string corpus.
- [x] `documents/derive.ts`: master + constraint → compliant file, via resize, binary-search JPEG
      quality, pad/letterbox, PDF↔JPEG conversion, and a loud, specific failure when unsatisfiable.
- [x] Derived variants cached, keyed by `hash(masterId + constraint)`. Evicted when the master is
      replaced or deleted.
- [x] Unit tests over ≥10 real-world constraint strings, asserting output mime/bytes/dimensions.

### Should Achieve

- [ ] In-browser crop/rotate/deskew for the master. **Not done** — deferred, see below.
- [ ] Background removal / white-background normalisation for photos. **Not done.**
- [ ] Signature cleanup (threshold to black-on-white). **Not done.**
- [x] Quality gate on upload: warns at intake when the master is too small for common constraints,
      or when a fixed aspect will crop heavily.

**Out of scope:** OCR, auto-extracting profile data from documents (tempting; defer to Phase 10+).

**Verify:** feed a 4 MB phone photo and a "20–50 KB, 3.5×4.5 cm JPEG" constraint; output must be JPEG,
within bytes, correct pixel dims, visually acceptable.

*Done, in a real browser:* `tests/e2e/derivation.spec.ts` runs the real `OffscreenCanvas` pipeline over
`fixtures/photo-4mb.jpg` (3.6 MB, 3024×4032) and asserts JPEG magic bytes, 20–50 KB, and 276×354 px.
"Visually acceptable" is the one claim a test cannot make — open the preview in the side panel.

### Architecture note

The raster operations sit behind an injected `RasterBackend`. All the decisions — target box,
format choice, the quality search — are pure TypeScript tested with a fake backend (§6.1: "no DOM"),
while `raster.ts` only pushes pixels and is covered by the Playwright spec instead.

### Deferred to a later pass

The three image-editing "Should Achieve" items (crop/rotate/deskew, background removal, signature
thresholding) are genuine UI work, not pipeline work, and none of them blocks Phase 3. They are worth
doing before release because they change what a user can salvage from a bad scan.

## Phase 3 — Extension shell & DOM harvester

**Goal:** on any page, produce a precise structured description of every fillable field. No filling.

**Status: complete.** 401 unit tests + 24 e2e green.

### Must Achieve

- [x] Content script injected on user activation (`activeTab` + explicit click), **not** broad
      `<all_urls>` auto-injection. The built manifest declares no `content_scripts` at all; the
      script is a separate Vite entry (`dist/content.js`) injected by `chrome.scripting`.
- [x] `content/harvester.ts` emits `FieldDescriptor[]`.
- [x] Label resolution handles the ugly cases: `<table>` layouts (including header-row grids),
      `<label>` siblings without `for`, floating labels, `aria-labelledby`, and text nodes
      preceding the input. Each field reports *which rule won*, for the Phase 7 rationale.
- [x] Same-origin iframe traversal (`allFrames: true`); cross-origin frames are reported as
      `unknown_widget` blockers rather than silently skipped.
- [x] Side panel shows the harvested list live for the active tab, with the labelled-percentage
      readout and the blockers it cannot handle.

### Should Achieve

- [x] Shadow DOM piercing (open roots).
- [x] Detect multi-step wizards and record the step index in the fingerprint.
- [ ] Detect dependent dropdowns (State → District → Taluk) by observing XHR/mutation after a
      select changes. **Not done** — deferred, see below.

**Out of scope:** matching, filling.

**Verify:** run the harvester over every fixture page; snapshot-test the output. Manually confirm
>=95% of visible fields are captured with a non-empty `labelText`.

*Done:* `content/fixtures.test.ts` snapshots every fixture page and asserts the >=95% bar per page;
`tests/e2e/harvest.spec.ts` repeats it in a real browser, where layout-based visibility and genuine
cross-origin frames actually exist.

### Design notes

**Security fields are reported, never described as fillable.** Inputs named `captcha`/`otp`/`vcode`
and every `type="password"` are emitted as blockers. P4 says we never fill them; not describing them
as fields means no later phase can be tempted to try.

**Hidden fields are kept, marked `visible: false`.** A field hidden on step 1 may appear on step 2;
dropping it would make Phase 6's `REVERIFYING` think the form changed shape.

**Every label-anchored XPath is verified against the live DOM before being offered.** Generating one
from label text alone produces confident nonsense — a `<th>` is not a `<td>`, an aria-label matches
no element, and in a grid `following::input[1]` from the third header resolves to the *first*
column's input. A selector that silently fills the wrong field is the §6.4 Critical risk. The
structural path is always present as a fallback, so refusing a bad XPath costs nothing.

**The harvester never mutates.** No attributes, no styles, no events. Asserted in both suites by
comparing `body.innerHTML` before and after.

### Deferred to a later pass

Dependent-dropdown detection (observing XHR/mutation after a select changes) needs the fill engine
to drive a select before there is anything to observe. It is better built alongside Phase 5's
sequential filling, where the plan already requires waiting for dependent selects to repopulate.

## Phase 4 — Deterministic matcher & site profiles

**Goal:** map `FieldDescriptor → FieldKey` without any LLM, on a form the matcher has never seen.

**Status: complete.** 504 unit tests + 24 e2e green.

### Must Achieve

- [x] `matching/deterministic.ts`: scored matcher combining a synonym dictionary (Hindi included),
      `autocomplete` attribute mapping, `name`/`id` token heuristics, type/`maxLength`/`pattern`
      compatibility **as a filter**, and option-set matching for selects.
- [x] Output `MatchResult { fieldRef, key | 'unknown', confidence, rationale, source }`.
- [x] Confidence thresholds: >=0.85 auto-fill; 0.5–0.85 fill but flag; <0.5 unmapped (`bandOf`).
- [x] `site-profiles/<site-id>.json` schema, versioned — loaded by `matching/profile-cache.ts`.
- [x] Profile cache lookup precedes rules; rules precede LLM (`matching/index.ts`).

### Should Achieve

- [x] Synonym dictionary loaded from JSON (`matching/synonyms.json`) so non-developers can extend it.
- [x] Auto-detect `address.correspondence` vs `address.permanent` from section headings.
- [x] Detect a "Same as permanent address" checkbox (`detectSameAsPermanent`). Acting on it is
      Phase 5's job — there is nothing to tick until there is a filler.

**Out of scope:** LLM fallback.

**Verify** (amended for the any-portal target): across a fixture corpus of forms the matcher has **no
profile for**, deterministic matching alone maps **>=70%** of fields at >=0.85 confidence, with
**zero** high-confidence *mis*-mappings.

*Measured* by `matching/eval.test.ts` over `fixtures/heldout-*`:

| metric | result |
|---|---|
| mappable fields | 52 |
| auto-filled correctly (>=0.85) | 51 — **98.1%**, gate is 70% |
| correct at any confidence | 52 — 100% |
| **high-confidence mis-mappings** | **0** — gate is zero |

**Read that 98% with suspicion.** The held-out fixtures are synthetic and were written by the same
hand as the synonym dictionary, so "held-out" here means *not tuned against*, not *independently
sourced*. Wording was deliberately varied from `synonyms.json` ("Applicant's Full Name", "Postal PIN
Code", "Permanent Account Number", "Name of School / College"), and traps were planted that the
traits veto must reject — but this is weaker evidence than captured portal HTML. Re-run this gate
against real fixtures before trusting the number.

### Design notes

**Traits are a veto, not a score.** `traits.ts` rules a key out on the structural facts of the field
— a 10-character numeric box is not a full name, a file input is not an email address. A signal that
merely lowers a score can still be outvoted; a veto cannot, and §6.4 rates a confident mis-match as
Critical.

**The scoring is deliberately timid.** Corroboration adds at most 0.08. A runner-up within 0.15 caps
the winner at 0.8 — below auto-fill — because exact-vs-coverage (0.90 vs 0.78) is the shape almost
every real near-tie takes. A single weak signal never clears 0.5. Two fields claiming one key keeps
the match but caps it, since "Confirm Email" is real and so is a mis-match.

**Generic tokens cannot carry a match alone.** "Reference Code" shares "code" with PIN Code and IFSC
Code; "Batch Number" shares "number" with half the dictionary. Partial coverage now requires a
distinctive shared token — this is what stops confident nonsense.

**Matching runs in the service worker, not the page.** Verified against `dist/content.js`: the
synonym dictionary and taxonomy do not ship into the tab.

## Phase 5 — Fill engine & the submit guard

**Goal:** actually write values into a page, robustly, and make submission structurally impossible
without approval.

**Status: complete.** 602 unit tests + 36 e2e green.

### Must Achieve

- [x] `content/filler.ts` writes values the way frameworks accept: the prototype's native value
      setter (so React's tracker does not swallow the write), `input`/`change`/`blur` plus
      `keydown`/`keyup`, selects matched by value → exact text → normalised text → fuzzy with the
      winning strategy recorded, radio/checkbox by label text, and file inputs via `DataTransfer`.
- [x] Sequential filling with a randomised 60–200 ms inter-field delay, and an explicit wait for a
      dependent select to repopulate before filling the child.
- [x] Per-field verification by read-back: mismatch ⇒ retry once ⇒ mark `fillFailed`.
- [x] `content/submit-guard.ts`: capture-phase `click`/`submit`/`keydown[Enter]`, blocks anything
      submit-ish without a valid unexpired unburned token, patches `HTMLFormElement.prototype.submit`
      (best-effort, documented), and toasts every block.
- [x] In-page overlay: status pill (filling / paused / review ready / blocked) plus Abort, in a
      closed shadow root so a hostile page cannot restyle it away.

### Should Achieve

- [x] Undo — restores the pre-fill snapshot of every touched field, including values the user had
      typed themselves.
- [x] Respect `maxLength`, truncating with a review flag rather than silently corrupting data.
- [ ] "Fill this one field" mode from the picker. **Not done** — the picker itself is Phase 9.

Also delivered here: **dependent-dropdown detection**, deferred from Phase 3 because there was
nothing to observe until something could drive a select.

**Out of scope:** review screen, approval.

**Verify:** e2e on fixtures — every mapped field ends up with the correct value; clicking the real
submit button while unarmed does nothing except show the toast. Write an adversarial test where the
fixture page calls `form.submit()` on load.

*Done* in `tests/e2e/fill.spec.ts` against `fixtures/hostile-portal/`, which fights back on a timer,
on every input event, and via a scripted click on the real submit button. The suite asserts the
premise first (the page really does try) before asserting we stop it.

### What P2 actually guarantees — stated precisely

The guarantee is **not** "this page can never submit". It is: *no value the extension filled reaches
a submit without an explicit approval gesture.* Three limits make that distinction real, and each is
tested rather than assumed:

1. **The prototype patch is best-effort.** Code that captured `form.submit` before we installed
   keeps a working reference.
2. **We install on a user gesture, not at `document_start`.** A page that submits itself during load
   does so before we exist — `fixtures/hostile-portal/page-onload.html` proves it navigates, and the
   test asserts that outcome rather than pretending otherwise. P2 still holds there: nothing of ours
   had been filled.
3. **The token is the real control**; the patch is defence in depth. It names one element, carries a
   90-second expiry, and is burned on the submission — not on the click that starts it, since a
   click's default action *is* the submit and burning early would block the very activation it just
   authorised.

### Design notes

**Two bugs the tests caught, both about the shape of a submission.** Burning the token at click time
unarmed the guard before the resulting `submit` event arrived. And repeated `installSubmitGuard`
calls left stale capture listeners attached, so a second copy blocked what the first had just
permitted — fixed with a real `uninstallSubmitGuard`, which Abort wants anyway.

**A jsdom artifact worth knowing about.** jsdom implements a submit button's default action by
calling `HTMLFormElement.prototype.submit()` internally; Chrome does not. Guard tests therefore
`preventDefault()` in a submit listener to model a real page — see the comment in
`submit-guard.test.ts` before "fixing" it.

**Only this form's values cross into the page.** Filling requires putting a value in the DOM; that is
inherent. Shipping the whole vault into a hostile tab is not, so `fill-service.ts` sends one value
per matched field and nothing below the fill threshold at all.

## Phase 6 — Pause, resume, and drift recovery

**Goal:** survive CAPTCHAs, OTPs, and postbacks. This is the hardest phase — budget accordingly.

**Status: complete.** 792 unit tests + 46 e2e green, including the 20x flakiness gate.

### Must Achieve

- [x] `runtime/machine.ts` implementing §5 exactly, as a pure reducer, **fully unit-tested** with no
      DOM. `now` is a parameter, so the 90-second TTL is testable without waiting ninety seconds.
      An event the machine refuses returns the state object *by identity*, so callers can assert
      `reduce(s, e) === s` and an unanticipated event can never advance a run.
- [x] Blocker detection (`content/blockers.ts`): reCAPTCHA/hCaptcha/Turnstile/Arkose iframes and
      vendor containers, `img` elements marked as a captcha, one-time-code inputs (by `name`, `id`,
      `placeholder`, `aria-label`, or `autocomplete="one-time-code"`), DigiLocker/eSign hand-offs,
      and payment gateway origins.
- [x] On block: the overlay explains *what is needed* in our words, the extension stops touching the
      page, and an "I have completed this — continue" button appears.
- [x] MutationObserver forces `REVERIFYING` on churn; navigation is detected on the far side of the
      reload. **Deviation from the plan text — `webNavigation` is not used**; see below.
- [x] `REVERIFYING` re-resolves every selector, re-reads every filled value, refills what was reset,
      and escalates to `DRIFTED` when a selector no longer resolves.
- [x] Full run state persisted to `chrome.storage.session` on every transition; rehydrated on load
      and continued without data loss.
- [x] Re-authentication gate: any `sensitivity: 'high'` key after an idle period requires the
      passphrase again (`runtime/reauth.ts`, `REAUTH_IDLE_MS` = 3 min).

### Should Achieve

- [x] Multi-step wizard support — the harvester now reads "Step 2 of 3" out of a heading, which for
      many portals is the only place it appears, and the step folds into the form fingerprint so a
      resumed run cannot mistake step 3 for step 1.
- [x] Session-expiry detection (`looksLikeSessionExpiry`) — a password field on what should be an
      application form. The run cannot log in for the user (we hold no portal credentials, by
      design), so the path offered is "log in, then press resume".
- [x] Draft-save detection (`findDraftControl`) — **surfaced, never pressed.** CLAUDE.md rule 1
      reserves activating a final-action control to the submit guard, and saving a draft changes
      state on the user's account. The panel offers it; the user decides.

**Out of scope:** anything that reads, solves, or bypasses a challenge.

**Verify:** a fixture that (a) resets all field values on a simulated postback, (b) regenerates
element IDs each load, (c) contains a fake CAPTCHA gate. Run it 20x.

*Done* in `fixtures/postback-portal/` and `tests/e2e/resume.spec.ts`. The fixture regenerates every
element id on each render and wipes every value on a postback — asserted by two tests of their own,
so the scenario cannot silently stop being adversarial. The 20x gate runs twenty full journeys
(pause → solve → resume → detect the reset → refill → REVIEW) with `retries: 0`.

### P4, made mechanical rather than intended

`blockers.ts` may notice that a security control exists and say where it is. It may not read one.
There is no code path in it that touches an input's `value`, rasterises an image, fetches a
resource, or ships anything from a widget anywhere — and `blockers.test.ts` asserts that **against
the file's own source text**, failing if a future edit introduces `.value`, `createImageBitmap`,
`toDataURL`, `getImageData`, `fetch(`, OCR, `.click()`, or `dispatchEvent`. "We intended not to" is
not a control; a test that reads the file is.

Every sentence the user sees while blocked comes from the frozen `INSTRUCTIONS` table, never from
page text — a portal that could write the words in our own overlay could tell the user "AutoFill
will now complete this for you", and the one thing that panel exists to say is the opposite.

Two supporting tests: the run's entire output is checked for the fixture CAPTCHA's answer (`X7KQ9`)
and for anything typed into an OTP box, and the harvester is re-checked to confirm it never
described those fields as fillable in the first place.

### Deviation: no `webNavigation`

The plan names `webNavigation` listeners. They are not used, and the reason is permission
minimisation: `webNavigation` events are filtered by host permissions, and this extension
deliberately declares none (`host_permissions: []`, injection on an explicit gesture via
`activeTab`). Asking for it would widen the manifest to buy a signal we already have — a closed tab
via `chrome.tabs.onRemoved`, and a reload detected by the content script itself, which knows the
document is new because its `window.__autofillContentReady` marker is gone.

Nothing is written to storage during `pagehide` either. An async write during unload is not
reliable; the run state was already persisted at its last transition, and the reload is detected on
the far side instead.

### The refill boundary — the one new attack surface

A postback wipes the form, so the run has to be able to put values back without marching the user to
the side panel again. That means honouring `fill:refill`, a request that **originates inside the
page** — the one message that does. It is deliberately not in `PRIVILEGED_TYPES`, because the sender
check cannot express what is actually wanted here.

What contains it is a run authorisation held by the worker: a refill may only ask for refs that were
part of a run *the user themselves started on that tab*, and only for ten minutes. The requested
refs are intersected with that plan — the page asks, the plan decides — and the re-auth gate applies
again on the way through, because time has passed since the gesture. A compromised content script
gains the ability to re-request values the user already agreed to put on that form. It does not gain
the vault. `fill-service.test.ts` asserts each of those.

### Design notes

**Only `FILLING` may write to the page.** One predicate, `mayWritePage`, asked in one place. That is
the mechanical meaning of "the extension stops touching the page" when a security control appears —
otherwise it is a habit that five call sites have to remember.

**`BLOCKED` never resumes on a timer** (§5 says so explicitly), and a settle event alone is not
enough either: `DOM_SETTLED` carries whether the blocker has actually gone. A CAPTCHA widget mutates
constantly while it is being solved, and resuming on a quiet moment would mean filling over the
user's hands. Pressing "I have completed this" does not resume the fill either — it moves to
re-verification, which walks the page as it now stands and blocks again immediately if the gate is
still up.

**An approval does not survive the page changing.** `ARMED` + churn → `REVERIFYING`, token dropped.
The user approved a page; a postback means that page is gone, so the approval no longer describes
anything they agreed to. Likewise a run restored from storage is normalised through the reducer on
the way in, so a tab reopened two minutes later cannot come back one click from submitting.

**Values are never persisted.** The run state holds keys, selectors and confidences; the map of what
was actually written lives in memory in the content script and dies with the document. After a
navigation, re-verification falls back to "is this field empty", which is enough to notice a reset.
A test walks the persisted object graph and fails on any property named `value`/`bytes`/`filename`,
or any string shaped like an Aadhaar or PAN.

**Comparison is lenient on purpose.** Portals trim, upper-case a PAN, reformat a date, and strip the
spaces out of an account number. Treating any of those as "the page reset my value" would refill in
a loop forever.

### Four bugs the tests caught

1. **A blocker found before the first write did not stop the run.** `READY` did not accept
   `BLOCKER_SEEN`, so a page whose CAPTCHA was visible from the start got the whole form filled and
   *then* blocked — the exact opposite of what P4 promises. Caught by the e2e; fixed in the reducer
   with a unit test naming the case.
2. **`reverifyNow` called from `FILLING` did its work and had the result thrown away.** The reducer
   only accepts `REVERIFIED` from `REVERIFYING`, so the refill was requested but the transition was
   silently refused, leaving the run claiming to be mid-fill forever.
3. **The OTP regex could not match `txtOTP`.** `[^a-z]` under the `i` flag also excludes uppercase,
   because case-insensitive matching folds `T` into the excluded range. A bare `/otp/` is no good
   either — it matches inside `footprint` and `hotpoint` — so identifiers are tokenised first.
4. **The wizard step was invisible when it lived in an `<h1>`.** Found via this phase's own fixture
   snapshot; the detector's candidate list did not include headings.

**A test that passed for the wrong reason.** The mutation-storm e2e polled for the refill *event*,
which is emitted when the refill starts — then read the field values while the run was still writing
them one at a time. It now polls the values themselves.

### A documented amendment to a locked type

§5 wrote `UNLOCKING` as payload-free. It now carries `plan: FillPlan | null`. A re-auth gate that
forgets what the user was doing forces them to restart the run, which is a worse outcome than the
gate prevents.

## Phase 7 — Review screen & approval

**Goal:** the user's last line of defence. Make it genuinely reviewable, not a rubber stamp.

### Must Achieve

- [ ] Review UI (side panel) listing every field: **label as shown on the portal**, value filled, source key,
      confidence, and match rationale.
- [ ] Visual grouping by form section; click a row → scroll to and highlight the field in the page.
- [ ] Explicit surfacing of: low-confidence matches, truncated values, fuzzy select matches, `fillFailed` fields,
      and **fields the portal requires that are still empty**.
- [ ] Document section: thumbnail of each derived variant, plus its byte size and dimensions vs. the stated requirement.
- [ ] Inline edit — corrections write back to the page **and** offer "save this correction to my vault".
- [ ] Approval requires a deliberate gesture (type-to-confirm or hold-to-confirm), not a single stray click.
      Issues a 90-second single-use `approvalToken`.
- [ ] After approval: exactly one click on the recorded submit element, then `SUBMITTED`. Token burned before the click.
- [ ] `runtime/audit.ts`: append-only local log — timestamp, site, fields filled (keys, not values, unless the
      user opts into value logging), what was flagged, what the user edited, approval time.

### Should Achieve

- [ ] Side-by-side diff against the last submission to the same portal.
- [ ] Post-submission capture: store the acknowledgement/reference number and a PDF/screenshot of the
      confirmation page into the vault, linked to the run.
- [ ] "Explain this match" — show the rationale chain for any field.

**Out of scope:** LLM matching.

**Verify:** a user-testing pass — hand it to 3 people with one deliberately wrong value planted. All three
should catch it. If they don't, the review screen has failed its only job; redesign it before proceeding.

---

## Phase 8 — LLM fallback matcher

**Goal:** generalise to portals with no site profile — **without** sending PII anywhere.

### Must Achieve

- [ ] `background/redaction.ts`: builds the LLM payload from `FieldDescriptor`s only — label text, name/id, type,
      options, nearby text. Vault values, document bytes, and filenames are structurally unreachable from this
      code path (enforce with a module boundary + lint rule).
- [ ] **Leak test suite:** seed the vault with canary strings; run the matcher over all fixtures; assert no canary
      appears in any outbound payload. This test is mandatory in CI.
- [ ] Prompt contract — model returns strict JSON, closed vocabulary:

```text
You map form fields to a fixed vocabulary of profile keys.

ALLOWED KEYS: <FIELD_KEYS list>
Return "unknown" if no key fits. Never invent keys.

FIELDS:
[{"ref":"f12","label":"पिता का नाम / Father's Name","name":"txtFName",
  "type":"text","maxLength":50,"nearby":"Personal Details"}, ...]

Return ONLY a JSON array:
[{"ref":"f12","key":"family.father_name","confidence":0.0-1.0,"why":"<12 words"}]
```

- [ ] Response validation: unknown keys rejected, confidence clamped, refs matched back; malformed JSON → one
      retry → fall back to `unknown`.
- [ ] Results merged **under** deterministic results (rules always win ties) and capped at 0.8 confidence — an LLM
      guess never auto-fills a `sensitivity: 'high'` field without user confirmation.
- [ ] Successful runs are written into a new site profile so the LLM is called **once per form, ever**.
- [ ] Graceful degradation: no API key / offline / rate-limited ⇒ deterministic-only mode with a clear notice.

### Should Achieve

- [ ] Batch fields into one call; cache by DOM-skeleton hash.
- [ ] Ask the model to extract document constraints from instruction text on the page (feeds Phase 2's parser).
- [ ] Token/cost meter in settings.

**Out of scope:** sending any user value to any model, for any reason, including "verification".

**Verify:** on a *fourth* portal with no profile, LLM + rules maps >=85% of fields correctly. Canary test green.
Delete the API key → extension still works on profiled sites.

---

## Phase 9 — Teach mode & profile repair

**Goal:** turn your maintenance burden into a user-driven feature. This is what makes the product survive portal redesigns.

### Must Achieve

- [ ] `content/picker.ts`: element picker overlay — user clicks a field, chooses a `FieldKey` from a searchable
      list, mapping is recorded.
- [ ] Entered from two places: `NEEDS_TEACHING` (unmapped fields) and `DRIFTED` (broken selectors).
- [ ] Taught mappings write a new site-profile **version**; old versions retained for rollback.
- [ ] Selector recording generates a ranked, resilient list (id → name → label-anchored XPath → structural path),
      and prefers selectors that survive across your fixture's regenerated-ID variants.
- [ ] Health check: on load, if <60% of a profile's selectors resolve, mark it stale and prompt for repair rather
      than filling a half-broken form.
- [ ] Document-slot teaching: user points at a file input, picks a document key, and either types the constraint
      or lets the parser read it from the page.

### Should Achieve

- [ ] Export/import site profiles as JSON so users can share them (community profile repo).
- [ ] If you ever host a shared profile registry: profiles contain **selectors only, never values**; review
      submissions before publishing; sign them. Treat an untrusted profile as untrusted input.
- [ ] Telemetry (strictly opt-in, aggregate only): which profiles are drifting, so you know what to fix.

**Out of scope:** automatic profile publishing without review.

**Verify:** take a fixture, rename every `id`, reload. The extension must detect drift, enter teach mode, and after
~2 minutes of user clicking, fill correctly again — with a bumped profile version.

---

## Phase 10 — Hardening, packaging, release

**Goal:** something you can responsibly give to strangers.

### Must Achieve

- [ ] Strict CSP; no `eval`; no remote code. Audit every dependency (`npm audit`, licence check).
- [ ] Content-script isolation review: the page must not be able to reach vault data, the approval token, or the
      message bus. Treat every portal page as hostile.
- [ ] Message-bus hardening: validate sender, reject messages from page context, schema-validate every message.
- [ ] Upgrade KDF to Argon2id (WASM) with migration from PBKDF2 vaults.
- [ ] Rate/scope limits enforcing P1 and P6: one active run per tab, hard cap on runs per hour, no headless entry point.
- [ ] Onboarding flow: vault creation → guided profile entry → document upload with quality checks → first
      supervised fill on a demo fixture form.
- [ ] Clear in-product disclosure: what the extension does, what leaves the device, what the user is responsible for
      verifying, and that they remain responsible for the accuracy of anything submitted.
- [ ] Privacy policy + Chrome Web Store listing that honestly matches behaviour (store review will check permission
      justification — `activeTab`, `storage`, `sidePanel`, `scripting`, host permissions per profile).
- [ ] Crash-safe: killing the browser mid-run leaves no half-filled state that resumes incorrectly.

### Should Achieve

- [ ] Firefox port (MV3 differences in service workers / `browser.*` namespace).
- [ ] Accessibility pass on all extension UI (this is an accessibility product for many users — screen-reader
      support is not optional in spirit).
- [ ] Localisation of the extension UI (Hindi + one regional language to start).
- [ ] Optional encrypted backup to user-chosen storage, key never leaving the device.

**Verify:** external security review of `vault/`, `submit-guard.ts`, and `redaction.ts` at minimum. Full e2e suite
green 20 consecutive runs.

---

## 6. Cross-cutting requirements

### 6.1 Testing strategy

- **Unit (Vitest):** crypto, taxonomy, deterministic matcher, constraint parser, image derivation, state machine
  reducer. No DOM.
- **Fixture snapshot:** harvester output per fixture page, committed and diffed.
- **E2E (Playwright):** full runs against served fixtures, including hostile variants — regenerated IDs, postback
  resets, fake CAPTCHA, `form.submit()` on load, cross-origin iframe.
- **Leak tests:** canary values in vault; assert absence in all outbound payloads. **CI-blocking.**
- **Manual portal smoke tests:** before each release, one real run per supported portal, stopped at review, never
  submitted (use a scratch/dummy application where the portal permits one).

### 6.2 Definition of "done" for any phase

- Must-Achieve checklist fully green.
- Tests written *and* failing-before/passing-after for every new rule.
- No new hard-coded selectors outside `site-profiles/`.
- Leak test suite green.
- `docs/` updated — especially portal notes and the threat model.

### 6.3 Sensitivity tiers

| Tier | Examples | Rule |
|------|----------|------|
| high | Aadhaar, PAN, bank account, passport | Re-auth before fill; never auto-filled from an LLM-only match; masked in the review UI until revealed; excluded from any log by default. |
| medium | DOB, address, mobile, marks | Normal fill; shown in review. |
| low | Name, gender, state | Normal fill. |

### 6.4 Risk register

| Risk | Severity | Mitigation |
|------|----------|------------|
| High-confidence **mis**-match submits wrong data | Critical | Rationale in review UI; type-to-confirm; mis-match treated as P0 defect class; zero-mismatch gate in Phase 4. |
| Portal ToS prohibits automation | High | Phase 0 verdicts; assistive-with-human-approval framing; drop `prohibited` portals. |
| Vault compromise on stolen device | High | Strong KDF, memory-only key, auto-lock, high-tier masking. |
| Portal redesign breaks everything | Medium | Versioned profiles + drift detection + teach mode (Phase 9). |
| Store rejection over permissions | Medium | `activeTab` + per-profile host permissions, never `<all_urls>`; honest listing. |
| LLM cost blowup | Low | Profile caching means one call per form lifetime. |

### 6.5 Suggested sequencing

Phases 0→7 are the true MVP and are strictly ordered. Phase 8 (LLM) and Phase 9 (teach mode) can run in parallel
afterwards. **Do not build Phase 8 first** — a generic matcher with no working fill/review loop is the classic way
to spend six months and fill zero forms.

---

## 7. First three Claude Code sessions

**Session 1 — scaffold.** Read `IMPLEMENTATION_PLAN.md` and `CLAUDE.md`. Execute Phase 0 only. Scaffold the
MV3 + Vite + TS + React extension, create `matching/taxonomy.ts` with the full key list and sensitivity tiers
from §4, set up Vitest and Playwright, and add `npm run fixtures:serve`. Stop and show me the Phase 0 checklist
status. Do not write any matching or filling code.

**Session 2 — vault.** Execute Phase 1. Test-first: write `vault/crypto.test.ts` before `vault/crypto.ts`,
including a tamper-detection test. Then the profile store and the vault editor UI. Report against the Phase 1
Must Achieve checklist.

**Session 3 — documents.** Execute Phase 2. Start with `documents/constraints.ts` and its parser tests using
10 real constraint strings. Then `derive.ts` with the binary-search quality loop. Prove it with a test that takes
`fixtures/photo-4mb.jpg` to a 20-50 KB, 3.5x4.5 cm JPEG.

Then continue one phase per session, checking the gate each time.
