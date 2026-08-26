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

**Status: built; the acceptance test is outstanding.** 903 unit tests + 54 e2e green. The Verify step
is a user-testing pass that has **not been run** — see below, and do not treat this phase as closed
until it has.

### Must Achieve

- [x] Review UI listing every field: the **portal's own label** as the primary text, the value in
      large monospace beneath it, then key, confidence, source and rationale in small print. The
      user is checking their data against a form they can see, not auditing our matcher.
- [x] Grouping by the page's own sections (`nearbyText` — a legend, a heading, a caption), in
      document order, so the review reads in the same order as the form. Click a row → the field is
      scrolled to, focused, and outlined in the page.
- [x] Explicit surfacing of low-confidence, truncated, fuzzy-select, `fillFailed`, and
      required-but-empty — each as a **sentence** saying what to do, not a colour.
- [x] Document section listing what the form asked for and what would be attached.
      **Thumbnails are not implemented** — the panel names the requirement and the state; rendering
      a preview of the derived variant is UI work left for the documents panel.
- [x] Inline edit writes back to the page through the same filler the run uses, with an opt-in
      "also save this to my vault" per correction.
- [x] Approval is a **hold**, 1.5 s, mouse or keyboard. Issues a 128-bit single-use token with a
      90-second TTL.
- [x] After approval: exactly one click on the recorded element, then `SUBMITTED`. **Token burned
      before the click.**
- [x] `runtime/audit.ts`: append-only local log — what was filled, from where, what was flagged,
      what the user edited, when they approved. Keys, not values, unless the user opts in.

### Should Achieve

- [ ] Side-by-side diff against the last submission to the same portal. **Not done.**
- [ ] Post-submission capture of the acknowledgement number and confirmation page. **Not done** —
      needs a page-capture path that does not exist yet.
- [x] "Explain this match" — every row carries its rationale, confidence and source inline. There is
      no separate disclosure because there is nothing left to disclose.

**Out of scope:** LLM matching.

### The Verify step has not been run

> "a user-testing pass — hand it to 3 people with one deliberately wrong value planted. All three
> should catch it. If they don't, the review screen has failed its only job; redesign it before
> proceeding."

That is a human test and it is outstanding. Nothing automated substitutes for it, and this document
should not pretend otherwise: the tests below hold the *mechanics* steady, not the outcome.

What is tested: that the model hoists a flagged field out of a list of forty rather than leaving it
at row 34; that the ordering is by what it costs the user to miss it; that the value shown is what
the page really holds rather than what we sent; that "show me this field" lands the outline on that
field, in a real browser, without touching it.

**To run the pass:** plant a wrong value by editing one entry in the vault, fill
`fixtures/ugly-portal/page-1.html`, and hand the panel to three people who have not seen this code.

### What makes it a review rather than a rubber stamp

**Every flagged field carries its own checkbox, and the approval control stays locked until each one
is ticked.** This is the single most important thing on the screen. It turns "I looked at it" from an
assumption into an action, and it puts the cost exactly where the uncertainty is: a form we filled
with complete confidence approves in one gesture, and a form with four doubtful fields costs four
deliberate ticks first.

Three supporting decisions:

- **The attention list is above the full list.** A flag half way down forty rows is decoration.
- **Editing a value cancels a live approval.** What the user approved is not what is on the page any
  more, so they approve again. Ninety seconds is not long enough for that to be a burden, and the
  alternative is submitting something nobody signed off.
- **The submit control names the button.** The user approves "Final Submit" — if that is not the
  word they expect, something is wrong and it is visible before anything is sent.

### Hold, not type

The plan offers type-to-confirm or hold-to-confirm. Holding for 1.5 s is short enough not to be
resented and long enough to be impossible by accident — a stray click, a double-click landing on a
re-rendered layout, a trackpad twitch. Typing a phrase reads as ceremony and mostly trains people to
type the phrase.

Space or Enter held down does the same thing, and releasing early cancels the same way. A gesture
only a mouse can perform would put the product's most important control out of reach of some of its
users. A hold interrupted by the window losing focus is cancelled, so switching apps mid-press
cannot complete an approval nobody is watching.

### The token never reaches the UI

The panel asks for a grant and later asks to submit; the worker holds the only token and is the only
thing that can spend it. A React bug cannot leak one and a compromised panel cannot replay one. The
content script receives it exactly once, as the argument of the single submission it is asked to
make. `approval-service.test.ts` asserts that no response to the panel contains anything token-shaped.

An approval is not a permission slip — it is a **description of one act**: this tab, this form
fingerprint, this element, for ninety seconds. The threat is not a forged token (both ends are
extension contexts); it is a token outliving the page the user looked at. Binding to the fingerprint
is what makes "approve page A, portal navigates, stale approval submits page B" impossible.

**Approval is refused outright while a CAPTCHA or OTP is outstanding** — approving *through* a
security gate is the user asking for the one thing P4 says we do not do, so no token is ever minted.

**The token is burned before the click, not after.** A click that throws, a page that navigates
mid-flight, or a worker suspended between the two lines all leave nothing reusable. A token that
survives a failed submission is a token available for a second attempt nobody approved — tested by
making the page throw and asserting the next attempt has no approval.

### The audit log is a privacy feature that could have become the opposite

Keys, never values, by default: `id.aadhaar`, not the number. A log that recorded values would be a
second, unencrypted copy of the vault sitting in `storage.local` where nothing protects it. Value
logging exists, is off by default, is the user's choice, and the *setting* decides rather than the
caller — so a future call site that passes values along cannot opt the user in.

The site is reduced to its origin. A portal URL routinely carries an application number in its query
string, and a log that kept it would be a record of which application, not merely which site.

"Append-only" is honest about its limits: there is no API to edit or remove a single entry, so
nothing can rewrite history to hide a fill. `clearAuditLog` deletes everything, visibly, because
being unable to erase your own history is not a privacy feature. A cleared log restarts its
sequence — recorded in the tests as a known property, not discovered later.

### One bug the tests caught

The field highlight was 4px wider than the field on the right and bottom: the marker's 2px border
fell outside the width it was given, because `box-sizing` defaults to `content-box`. Only visible in
a real browser — jsdom has no layout to measure. The marker is now `border-box`, and every property
is `!important` so a portal's own stylesheet cannot slide our outline off the field it is pointing
at.

The marker is a plain element in the page's document, so a page *can* still hide it. That costs the
user a visual aid and nothing more — unlike the overlay, this is not a control, so it does not earn
a shadow root.

## Phase 8 — LLM fallback matcher

**Goal:** generalise to portals with no site profile — **without** sending PII anywhere.

**Status: built; the live acceptance run is outstanding.** 1021 unit tests + 54 e2e green. The
≥85% gate makes a real API call and needs a key — see "Running the Verify" below.

### Must Achieve

- [x] `background/redaction.ts`: payloads built from `FieldDescriptor`s only, into a structurally
      narrower type (`RedactedField`) so a property added to the descriptor later cannot silently
      start being transmitted. Vault values and document bytes are unreachable — enforced by the
      lint boundary *and* asserted against the file's own source.
- [x] **Leak test suite**, in two files because the problem has two halves — see below. Runs in the
      normal `npm test`, so it is CI-blocking by construction.
- [x] Prompt contract as written in the plan: closed vocabulary, `"unknown"` permitted, `why` under
      12 words, JSON array only.
- [x] Response validation: keys outside the taxonomy discarded, invented refs discarded, confidence
      clamped, malformed JSON → one retry → fall back to unchanged deterministic results.
- [x] Merged **under** the rules and capped at `LLM_CEILING` (0.8) — below `AUTO_FILL`, so no model
      suggestion can ever auto-fill. High-sensitivity keys are capped harder still; see below.
- [x] Successful runs written into a learned `SiteProfile`, stored in `chrome.storage.local` and fed
      back into the Phase 4 profile lookup. The model is called once per form.
- [x] Graceful degradation: no key, locked vault, offline, 401, 429, 5xx, prose instead of JSON —
      each returns the deterministic results plus a notice. `enrichWithLlm` never throws.

### Should Achieve

- [x] One call per form, batched across every unmapped field.
- [x] Token **and cost** meter (`PRICING`, `estimateCost`), shown in the settings panel.
- [ ] Cache by DOM-skeleton hash. **Not done** — the learned profile keyed by form fingerprint
      subsumes it for the "once per form" requirement, and a second cache layer would be one more
      thing to invalidate wrongly.
- [ ] Ask the model to extract document constraints from instruction text. **Not done.**

**Out of scope:** sending any user value to any model, for any reason.

### The leak problem has two halves, and the plan only names one

The plan's leak test is *"seed the vault with canary strings … assert no canary appears in any
outbound payload"*. That test, written literally, passes trivially — the module boundary means vault
values cannot reach `redaction.ts` at all, so a vault canary can never appear no matter how badly
that file is written. The guarantee is real and worth asserting. It is not the interesting one.

**The page contains the user's data too.** A portal on the second visit greets them by name, prints
their Aadhaar for confirmation, and carries an application number in the surrounding text — all of
it in exactly the `labelText`, `nearbyText` and `placeholder` the plan says are safe to send. So the
canaries here are planted in the **DOM**, harvested for real, and then checked for. That version can
actually fail, and on the first run it did, twice:

1. `user_9876543210_name` survived, because the whole-token rule could not see a digit run buried
   inside one `\w` token. Fixed with a trailing `\d{4,}` sweep.
2. **A person's name survived, and no syntactic rule can catch it.** "Ravi Kumar Chandrasekaran" is
   indistinguishable from "Personal Details" or "Tamil Nadu" to any pattern. A name has no shape.

The second is why `value-guard.ts` exists.

### Two modules, because the boundary is worth keeping

`redaction.ts` removes anything *value-shaped* — Aadhaars, PANs, emails, IFSCs, dates, long
identifiers, URLs — and cannot import the vault. `value-guard.ts` removes the user's *actual
values*, and is the one module allowed to read them.

Splitting them keeps the lint boundary intact where it matters. The guard can only subtract: known
values are needles for `replace`, never copied into a payload, and it re-checks afterwards and
**refuses the whole payload** if any survived. `llm-client.ts` accepts only a `GuardedPayload`,
branded with a `unique symbol` that nothing outside the guard can construct — so skipping the check
is a type error, not a discipline anyone has to remember.

The denylist is deliberately *not* every vault value. Categorical keys — state, district, gender,
category, religion, account type — are exempt, because their values are the portal's own dropdown
vocabulary. Scrubbing "Karnataka" would protect nobody (the portal offers it to every visitor) and
would leave the model unable to match a State field at all. Everything else is scrubbed, so a key
added to the taxonomy tomorrow is protected by default; `value-guard.test.ts` asserts that
direction explicitly.

**A locked vault means no call at all.** The denylist comes from the vault, so without it there is
no way to check the page is not echoing the user's own name at the model. Fail closed.

### What is never sent, beyond the obvious

The **URL**. It is not in the plan's payload contract, and it is the most identifying thing
available: which portals a person applies to is sensitive on its own, and portal URLs routinely
carry an application number. The model gets a DOM skeleton and a closed vocabulary; it does not need
to know whose form it is.

Also never sent: option `value`s (frequently codes tied to a user's record — only the visible text
goes), and any field the rules already placed.

### An LLM guess cannot auto-fill, and cannot touch an Aadhaar at all

`LLM_CEILING` is 0.8 and `AUTO_FILL` is 0.85, so every model suggestion lands in fill-and-flag: it
is written and flagged, never written silently.

For `sensitivity: 'high'` keys that is still not enough. Fill-and-flag *writes the value first* and
asks afterwards, and "without user confirmation" cannot mean that for a number as difficult to
unsend as an Aadhaar. So a high-sensitivity suggestion is capped at
`HIGH_SENSITIVITY_LLM_CEILING = 0.45` — below `FILL_AND_FLAG` — which leaves the field blank and
surfaces it on the review screen as a suggestion the user can accept. Phase 9's teach mode is where
they do.

### Deviation from the locked table: the model

§1 locked `claude-sonnet-4-6`. That table predates the Claude 5 family; `claude-sonnet-5` is its
successor and the right default for a bounded classification against a closed vocabulary. **Verified
against the live model overview** rather than from memory: `claude-sonnet-5`, $2/MTok in, $10/MTok
out, with `claude-sonnet-4-6` now listed as legacy. Overridable in settings. The same fetch supplied
the numbers behind the cost meter, which is why it can show dollars rather than only tokens.

### The fourth portal

`fixtures/fourth-portal/` — a municipal trade-licence renewal written in register English
("Appellation of the Applicant", "Name of Progenitor", "Natal Date", "Urban Agglomeration",
"Postal Index Number"), chosen to sit outside every phrasing in `synonyms.json`. Thirty fields,
twenty-seven mappable, three traps.

It lives outside the `heldout-*` glob on purpose: the Phase 4 corpus has a ≥70%-at-high-confidence
gate that this portal is *designed to fail*, and folding it in would have quietly weakened a gate
that is doing its job.

**Rules-only baseline: 17/27 = 63.0%**, printed by the test on every run. That number is the gap the
model has to close, and the baseline is asserted with an *upper* bound — if the rules ever reach 85%
here unaided, this fixture has stopped being a fourth portal and a new one is needed. Do not fix
that by raising the bound.

### Running the Verify

The ≥85% gate is a real API call and is skipped unless a key is present:

```
ANTHROPIC_API_KEY=sk-ant-... npx vitest run src/matching/eval-llm.test.ts
```

There is deliberately no recorded-response version. A canned reply would exercise this repository's
plumbing and say nothing about whether a model can read a municipal form, which is the only question
the gate exists to answer.

The other two clauses of the Verify are covered unattended: the canary suites run in `npm test`, and
"delete the API key → extension still works" is the default state of every other test in the file.

### Two matcher defects the fourth portal exposed

Both were P0-class — a *high-confidence wrong answer*, which §6.4 rates worse than a miss.

1. **"Indian Financial System Code of the Branch" → `bank.branch` at ≥0.85.** A fully-covered
   one-token synonym ("branch") scored exactly as high as a fully-covered four-token one would.
   Length is the whole difference between a phrase that happens to appear in a label and a phrase
   that *is* the label's subject, so a coverage match now earns `+0.03` per token beyond the first,
   capped at three steps to stay below `labelExact`. Plus the spelled-out IFSC synonyms.
2. **A four-character numeric box labelled "Name" → `identity.full_name`.** Nothing read
   `inputmode`, which is how a modern portal declares "digits only" — `capabilityOf` looked only at
   `type="number"` and `pattern`. The harvester now records it and the traits veto uses it, which
   is the plan's own worked example reached through the attribute portals actually use.

### Where the API key lives

Encrypted in the vault, in a new `settings` store at DB v3 — not `chrome.storage.local`, which would
leave a working credential readable by anyone with the profile directory. The threat model already
names a compromised API key as an adversary; making that adversary need the passphrase too costs one
migration.

The consequence is stated rather than hidden: **the model only works while the vault is unlocked.**
That is the right coupling — the LLM exists to help fill a form, and filling needs the vault open.

There is no message that *reads* the key back. The panel can store one, clear one, and ask whether
one exists. A UI that cannot obtain a secret cannot leak one, and a screenshot of the settings panel
cannot either.

## Phase 9 — Teach mode & profile repair

**Goal:** turn your maintenance burden into a user-driven feature. This is what makes the product survive portal redesigns.

**Status: complete.** 1090 unit tests + 63 e2e green.

### Must Achieve

- [x] `content/picker.ts`: capture-phase element picker. The user points, then names the field from
      a searchable list.
- [x] Entered from both doors: unmapped fields (`NEEDS_TEACHING`) and a stale profile (`DRIFTED`).
      Also offered unconditionally on any scanned page — a user who spots a wrong mapping should not
      have to wait for the extension to agree that it is wrong.
- [x] Taught mappings write a new profile **version**; `MAX_VERSIONS` (10) retained per form, with
      "Undo the last teach" in the panel.
- [x] Ranked, resilient selector recording — with the survival probe *measured*, not guessed. See
      below.
- [x] Health check: below 60% resolution the profile is marked stale and the panel prompts for
      repair instead of filling. **This check was inert before this phase**; see below.
- [x] Document-slot teaching: `teach:assign-document` records a `doc.*` key with its constraint
      alongside the field mappings.

### Should Achieve

- [x] Export/import profiles as JSON (`matching/profile-transfer.ts`), with the untrusted-input
      handling the plan makes a condition of ever sharing them.
- [ ] A hosted registry with signing and review. **Not built** — the plan makes it conditional
      ("if you ever host…"), and there is nothing to sign against. What *is* built is the part that
      matters without it: an imported profile is treated as untrusted.
- [ ] Opt-in aggregate telemetry. **Not built.** It would be the first thing in this codebase that
      phones home, and the drift signal it would carry (which portals a user visits, and when they
      break) is exactly the shape of data P3 exists to keep on the device. Worth doing only with a
      design that survives that argument, which this is not yet.

**Out of scope:** automatic profile publishing without review.

**Verify:** rename every id, reload, detect drift, teach, fill correctly again with a bumped version.

*Done* in `tests/e2e/teach.spec.ts` against `fixtures/postback-portal/`, which renames every element
id on every render by itself — so "rename every id" is the fixture's own behaviour rather than a
test-only mutation it could quietly stop doing. The spec asserts that premise first (no id survives
a reload), then walks the whole journey: healthy profile → reload → 0/5 resolving and stale → refuse
to fill → teach → v2 → **reload again** → still 5/5 → fills correctly.

That second reload is the one that matters. A repair that only worked until the next postback would
not be a repair.

### The health check was inert until this phase

`selectProfile` has computed a resolve rate since Phase 4, but `harvest-service` passed
`resolve: () => true`. Every profile therefore scored 100%, the 60% threshold could never fire, and
a half-broken profile would have been used to fill a form — the precise outcome this phase exists to
prevent. It now resolves against the harvested fields, and `TabHarvest` carries a `profileHealth`
so the panel can say "9 of 20 fields still match" and name the ones that are lost.

### A defect the Verify exposed in the harvester

The first run of the drift spec found a freshly-recorded profile reporting 0/5 resolved *before*
anything had drifted. The cause: `buildSelectors` **dropped a generated id entirely** unless there
was almost nothing else, so a profile holding one could never be matched — and health and matching
could therefore disagree about the same page.

Generated ids are now always recorded, ranked last. Two things need them: `elementFor` re-resolving
after an in-place postback, where the id is still the one this render emitted; and profile
resolution, where a profile captured elsewhere — shipped, imported, or recorded under a different
render — may legitimately hold an id the harvester would never *prefer*. Refusing to record it made
a working profile look broken, which is the one answer a staleness check must not give.

### Selector resilience, measured rather than guessed

The plan asks for a ranking that "prefers selectors that survive across your fixture's
regenerated-ID variants". That is two different claims and `rankSelectors` treats them as such:

- **Static.** `#ctl00_x_txtName` is generated and will differ next render; `input[name="txtName"]`
  is authored and usually will not. `looksUnstable` already encoded what those look like.
- **Measured.** `saveTeaching` re-harvests at save time — which on a portal like this is a
  *different render* from the one the user picked on — and probes each selector. Measured evidence
  outranks the heuristic in both directions: a selector that demonstrably survived is promoted above
  one that merely looks stable, and one that demonstrably died is demoted below everything.

A dead selector is ranked last, not discarded. It may come back on another render, and keeping it
costs one failed lookup against losing information.

### Two rules that make repair worth doing

**A repair never loses prior work.** Re-teaching three fields on a twenty-field profile keeps the
other seventeen. Anything else would make fixing one field a reason to re-do the whole form.

**A teach outranks everything.** A human pointing at a field is the strongest signal this system
has — stronger than a rule, a model, or an older teach — so `source: 'taught'` fills at confidence 1
without flagging. That is also why the Phase 8 hand-off matters: an `llm` entry becomes `taught` the
moment a human confirms it, and stops being capped.

### An imported profile is not a taught one

This is the sharp edge of the export/import feature, and it took the most care.

An imported profile is a file from a stranger that tells this extension **where to type the user's
Aadhaar**. A bundle claiming `source: 'taught'` would be claiming a trust level the recipient never
granted — taught mappings fill at confidence 1, silently. So `importProfiles` rebuilds every field
from scratch, drops `source` and `confidence`, and re-enters each mapping at rule level, below
`AUTO_FILL`. An imported mapping is filled *and shown*, and reaches the user on the review screen.

Also stripped: any property nobody asked for, blockers (a profile that could declare "there is no
CAPTCHA here" would be a profile that could switch off a P4 control), oversized selectors, and
anything beyond the per-file caps.

There is no signing and no registry. The plan lists both as conditional on hosting one; until that
exists, "treat it as untrusted input" is the whole of the defence, and the code says so rather than
implying more.

### P4 reaches teach mode too

A CAPTCHA answer box or a one-time-code field cannot be taught, because there is no key in the
taxonomy to teach it *to* — by design. The picker refuses with a sentence rather than doing nothing,
because a user who clicks and gets no response will click again.

The picker also swallows the page's own events in the capture phase — `click`, `pointerdown`,
`mousedown` — because a portal is full of labels that focus, anchors that navigate and buttons that
submit. A picker that let one through would take the user off a form they had already filled, which
is worse than having no picker.

### What a pick carries

Selectors and a label. Never a value. Asserted in both the unit suite and the e2e, where a field is
given a value before being pointed at and the resulting pick is checked for it.

## Phase 10 — Hardening, packaging, release

**Goal:** something you can responsibly give to strangers.

**Status: built. Two Verify items are outstanding and cannot be self-performed** — see the end.

### Must Achieve

- [x] Strict CSP, no eval, no remote code. `npm audit`: **0 vulnerabilities**. Runtime licences:
      idb ISC, pdf-lib MIT, pdfjs-dist Apache-2.0, react/react-dom MIT, hash-wasm MIT — all
      permissive, none copyleft.
- [x] Content-script isolation review — `docs/ISOLATION_REVIEW.md`, eight claims, each naming the
      mechanism *and* the test that fails if the claim stops being true.
- [x] Message-bus hardening: `shared/validate.ts`, default-deny, running after the sender checks
      and before any handler.
- [x] Argon2id via WASM, with migration from PBKDF2 vaults.
- [x] Rate/scope limits enforcing P1 and P6 (`background/limits.ts`).
- [x] In-product disclosure, shown *before* the vault exists.
- [x] Privacy policy (`docs/PRIVACY.md`) and store listing draft (`docs/STORE_LISTING.md`).
- [x] Crash-safe: `runtime/crash-safety.test.ts`.
- [ ] Onboarding flow. **Partial.** The disclosure gate and vault creation are wired; the guided
      profile entry, document upload with quality checks, and a first supervised fill on the demo
      fixture are *reachable* but not sequenced into a walkthrough. Every piece exists; what is
      missing is the ribbon around them.

### Should Achieve

- [ ] Firefox port. **Not done.**
- [ ] Accessibility pass. **Not done, and this one is called out in the plan as "not optional in
      spirit" for an accessibility product.** Some of it is in place by construction — the hold-to-
      confirm has a real keyboard path, the pause panel has `role="status"`, errors have
      `role="alert"` — but nobody has run a screen reader over this, and that is not the same thing.
- [ ] Localisation (Hindi + one regional language). **Not done.** The matcher already reads
      Devanagari labels; the *interface* is English-only.
- [ ] Optional encrypted backup to user-chosen storage. **Not done** — export/import to a file
      exists (Phase 1); syncing it somewhere does not.

**Verify:** external security review of `vault/`, `submit-guard.ts` and `redaction.ts`; full e2e
suite green 20 consecutive runs.

### The CSP tension, stated rather than resolved quietly

The Must list asks for both "no eval" and "Argon2id (WASM)". Those pull against each other: Chrome
requires `'wasm-unsafe-eval'` in an extension's CSP for *any* WebAssembly.

The manifest now carries it, and nothing else. `wasm-unsafe-eval` permits WebAssembly compilation
only — not `eval`, not `new Function`, not remote script. The WASM in question is the Argon2id
implementation, **embedded as base64 inside our own JavaScript rather than fetched**, which the
build confirms: there is no `.wasm` file in `dist/`. So: no remote code, no JS eval, and a
memory-hard KDF. The alternative was PBKDF2 forever, which is the weaker trade.

### The KDF, and why the migration is deliberately timid

Argon2id at 64 MiB / 3 passes / 1 lane — above OWASP's floor, about 140 ms on a laptop. **The
memory is the point**: PBKDF2 is cheap to parallelise on a GPU because it needs almost none;
64 MiB per guess is what makes the threat model's first adversary — a stolen laptop — expensive
rather than merely slow.

A vault created before this phase still opens. It is re-keyed to Argon2id on unlock **only when the
vault is otherwise empty**, and otherwise left on PBKDF2 with the panel able to say so.

That looks over-cautious until you write out the alternative. A re-key means re-encrypting every
record under a new key, in a service worker that can be suspended at any moment, with no
transaction spanning the whole operation. A half-migrated vault is worse than a strong-but-older
KDF, and PBKDF2 at 600k iterations is not weak — only weaker.

### A unit changed underneath a number

The KDF switch broke the test suite in a way worth recording, because nothing announced it.

Three vault suites built cheap keys with `{ ...newKdfParams(), iterations: 1_000 }`. That was
correct while the default was PBKDF2, where a thousand iterations is fast. The moment `newKdfParams`
started returning Argon2id, the same expression meant **a thousand passes over 64 MiB** — minutes
per key. Workers were killed by the OS, and it surfaced as hook timeouts in tests that have nothing
to do with crypto: `document-store`, `vault`, a schema-migration check. The suite went from 9
seconds to 278.

The fix is an explicit `TEST_KDF` constant in each file with the hazard written next to it. The
shipped parameters are asserted in `kdf-migration.test.ts` and nowhere else, so the two can no
longer be confused. Suite back to ~15s.

A second, smaller one: `poolOptions` in `vitest.config.ts` was accepted by the editor and is not a
Vitest 4 option — it did nothing, and the real cause was the KDF params. It has been removed rather
than left in looking load-bearing.

### The backup format had to learn a second KDF

Export/import hard-coded `PBKDF2-SHA256`, so the first Argon2id backup failed to import. Fixed in
both directions: `kdfFromBackup` reads either shape, and a backup's *own* parameters are used
verbatim rather than being replaced with today's defaults — the ciphertext was sealed under those.

A backup that stopped opening because the application moved on would be a backup in name only. The
file is the user's last copy, and its job is to outlive the software that wrote it.

### Message-bus validation, and who it is actually for

Not a hostile web page — a page cannot post onto the extension bus at all, and `sender.id` is set by
Chrome. The realistic attacker is **a compromised content script**: it is a legitimate sender, so
every sender check says yes to it. Two of the messages it may legitimately send carry structured
data (`fill:refill`, `teach:picked`), and both are now checked in full.

Default-deny: an unrecognised type is refused. That is mildly awkward — a new message type must be
added in two places — and the alternative is a default-allow bus, which is one forgotten entry away
from being no check at all. A test diffs the validator's table against `PRIVILEGED_TYPES` and
against every `type:` literal in the source, so the gap shows up here rather than at a user.

Written by hand rather than with a schema library: this is the most security-sensitive path in the
product, and twenty message shapes do not justify a dependency in it.

### Rate limits are not abuse prevention

The user is the only person here and is not attacking themselves. `MAX_RUNS_PER_HOUR = 20` exists so
that **the product cannot become the thing it promised not to be** — by accident, or by a future
contributor's enthusiasm. A caps-off build with a scripted driver would satisfy every other test in
this repository while being exactly the unattended bulk-submitter P1 and P6 forbid.

So the cap sits where a real person will never touch it and a loop hits it immediately, and the
refusal is a statement about what this software is rather than a quota someone should tune around.
One active run per tab, with a 30-minute lease so a worker suspended mid-run does not lock its tab
out for good.

### Crash safety

"No half-filled state that resumes incorrectly" — *incorrectly* is the load-bearing word. A lost run
is a nuisance; a run that comes back believing something it should not is the failure that matters.

Tested by throwing the in-memory store away and rebuilding over the same storage, which is exactly
what a browser kill does. A resumed run never claims a field was filled that was not, never resumes
writing without re-verifying, and cannot come back armed once the ninety seconds are up. The
worker-side approval registry is in-memory by design, so a restarted worker has no grant at all —
two independent controls, and the weaker one is the one that is written down.

### Not done, and not self-performable

**An external security review of `vault/`, `submit-guard.ts` and `redaction.ts`.** Required by this
phase's Verify. It cannot be self-performed — a review by the author of the code is not a review.
`docs/ISOLATION_REVIEW.md` is written as the material to hand a reviewer, not as a substitute for
one.

**Three portals chosen, with ToS verdicts in `docs/portal-notes/`.** Still outstanding from Phase 0,
still blocked on a human decision about which portals, and still the thing that turns this from a
working extension into a shippable one. Nothing in Phases 1–10 unblocked it, because nothing could.

**The Phase 8 live LLM gate** needs an API key; `ANTHROPIC_API_KEY=... npx vitest run
src/matching/eval-llm.test.ts`.

**The Phase 7 user-testing pass** — three people, one planted wrong value — is a human activity and
has not happened.

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
