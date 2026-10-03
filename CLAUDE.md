# Project: AutoFill Assistant

## Hard rules
1. Never write code that clicks a submit/final-action element outside `submit-guard.ts`,
   and only when `approvalToken` is present and valid.
2. Never include user profile values, document bytes, or filenames in any network request.
   All outbound LLM payloads pass through `redaction.ts` (structure and syntax) and then
   `value-guard.ts` (the user's own values, which have no syntax — a name is just words).
   `llm-client.ts` accepts only a `GuardedPayload`, so skipping the check is a type error.
   `redaction.ts`, `llm-client.ts` and `llm-matcher.ts` may not import `vault/` or `documents/`.
3. Never implement CAPTCHA solving, OTP reading, or eSign automation.
   `content/blockers.ts` may notice such a control exists and say where it is; it may never read
   one. Its test asserts that against the file's own source, so adding `.value`, a canvas read,
   `fetch(`, OCR, or `dispatchEvent` to that file fails the build. The user completes these steps.
4. All selectors live in versioned site-profile JSON. No hard-coded selectors in TS.
5. Every new field-matching rule needs a fixture test.

## Working style
- Test-first for `matching/`, `documents/`, `runtime/machine.ts`, `vault/crypto.ts`.
- One phase per branch: `phase/<n>-<slug>`.
- Do not start phase N+1 until phase N's "Must Achieve" checklist is green.
- Prefer small, pure functions in `matching/` and `documents/` — they must be unit-testable
  without a browser.

## Release gates (Phase 10)
- `npm audit` clean; runtime licences permissive.
- Bus messages are schema-validated in `shared/validate.ts` — **default-deny**, so a new
  message type must be added there too or it is refused.
- New vaults use Argon2id; PBKDF2 vaults still open. Tests that need a key must use a cheap
  explicit `TEST_KDF`, never `{ ...newKdfParams(), iterations: n }` — under Argon2id that
  means n passes over 64 MiB.
- P1/P6 caps live in `background/limits.ts`. They are not tuning knobs.
- Disclosure, privacy policy and permission justifications: `docs/PRIVACY.md`,
  `docs/STORE_LISTING.md`, `docs/ISOLATION_REVIEW.md`.

## Commands
- `npm run dev` — extension dev build
- `npm test` — vitest
- `npm run e2e` — playwright against fixtures
- `npm run fixtures:serve` — serve fixtures/ on :4173

## Product principles (P1–P6, non-negotiable)
If a requested feature conflicts with these, stop and flag it rather than implementing it.

| # | Principle | Enforcement |
|---|-----------|-------------|
| P1 | **The user is present.** This assists a human at the keyboard; it is not an unattended bot. | No headless mode, no scheduled runs, no queue of accounts. |
| P2 | **Never auto-submit.** Submission happens only after an explicit approval action on a review screen. | Capture-phase submit interceptor (Phase 5), armed only by an approval token (Phase 7). |
| P3 | **Raw PII never leaves the device.** | LLM receives DOM skeletons and a field-key vocabulary — never values. Enforced by a redaction layer + test suite (Phase 8). |
| P4 | **Never defeat a security control.** No CAPTCHA solving, no OTP interception, no eSign automation. | Those states hand control back to the user (Phase 6). |
| P5 | **Every run is auditable.** | Append-only local audit log: what was filled, from where, what the user approved. |
| P6 | **One account, one user.** | No multi-profile bulk submission features. Ever. |

## Where things live
- Canonical field keys: `src/matching/taxonomy.ts` (append-only — see §4 of the plan).
- Locked type contracts: `src/shared/types.ts`.
- Site profiles: `src/matching/profile-cache.ts` (lookup), `learned-profiles.ts` (versioned
  storage + rollback), `teach.ts` (building one from user picks), `profile-transfer.ts` (an
  imported profile is untrusted input and never enters as `taught`).
- Run state machine: `src/runtime/machine.ts` (pure reducer) + `store.ts` + `persistence.ts`.
  The behaviour that uses them — pause, resume, drift recovery — is `content/run-controller.ts`,
  which takes ports rather than reaching for `chrome.*` so it can be driven against a fixture.
- PDFs and the reader run in the offscreen page, never in the service worker: a service worker
  may not call `import()`, so pdf.js can only load there. The worker asks it
  (`background/ocr-host.ts` → `offscreenPdf`, `offscreenJobs` — one queue for everything the
  page does). A locked PDF's password is asked for once at save (`documents/pdf-lock.ts`) and
  sealed with the document (`vault/document-store.ts`); it is never derived from vault values.
  Every PDF is opened through `documents/pdfjs.ts` → `openPdf`, which points pdf.js at the image
  decoders shipped in `pdfjs/`; a scanned PDF is read page by page, up to `MAX_PDF_PAGES`.
- Other scripts: the English model reads every box; one it was guessing at is read again by the
  Devanagari, Telugu or Tamil recogniser (`paddle-reader.ts` → `chooseReading`, `isDoubtful`,
  `agreedNumber`), but only in the scripts the owner's documents can be in — Latin and Devanagari
  for everyone, then the state's (`indic.ts` → `readingScripts`; the Telugu model reads Kannada as
  confident Telugu, so Karnataka is never read in Telugu). Labels become English in
  `bilingual.ts`; a name printed only in an Indian script goes to `identity.full_name_local` and
  the parents' `*_local` keys, never the English name; a question naming a language is filled
  only in its script (`fill-service.ts` → `buildWrites`, `indic.ts` → `scriptAskedFor`).
- The scanner: a photo with something other than the page around it (`documents/scan.ts` →
  `hasBackground`) is flattened by UVDoc before it is read (`paddle-reader.ts` → `flattenPage`);
  a flat page never is — UVDoc stretches it and cuts its margins. The flattened page travels back
  with the reading (`pageImages`), and the pictures beside values are cut from it. A line the
  text-line classifier calls upside down is read both ways, kept turned only if it reads well.
  "Make a clean scan" (`doc:scan` → `ocr:scan`) stages the scan as if the user had chosen it;
  only their Save replaces the stored photo.
- Tables: where a table is comes from the text already read (`documents/table.ts` →
  `tableRegions`; no small layout model ships as ONNX); SLANet_plus reads its structure in the
  worker (`paddle-reader.ts` → `readTables`) and the reader's text fills the cells (`fillTable`,
  by each column's median edges — the model draws some cells badly). The grids travel with the
  reading (`tables`) to `extract-education.ts` → `coursesIn`, which reads a table of courses by
  its header: the course list, the total, each school subject's marks, and the backlogs — only
  when every grade or result was read. A PDF's text layer has no tables.
- Seals: a round seal of coloured ink is found (`documents/seal.ts` → `findSeals`), unrolled into
  two strips keeping only its own ink (`unrollSeal`), and read by the page's own reader
  (`paddle-reader.ts` → `readSeals`); PaddleOCR's seal detector has no ONNX build. Each seal is a
  line "Seal: …" placed where it is. `extract-claims.ts` files each certificate's date of issue
  and issuing authority by its kind; `frame.ts` → `headingCertificate` decides which certificate
  a bare "Date of Issue" means, and drops it when none is named. Dates are typed as the box asks
  (`matching/date-format.ts` → `dateAsAsked`).
- Documents into forms: `documents/field-constraint.ts` (which requirement a box means),
  `background/fill-service.ts` (file boxes and drop areas, during Fill),
  `content/upload-slots.ts` (upload controls that are not file boxes),
  `background/upload-window-service.ts` + `content/upload-window.ts` (a site's own upload
  window — self-contained injected functions, never click; `uploadAllToWindows` gates one hold,
  `upload-batch.ts` sequences every window through ports so e2e drives the real thing, its
  presses in `submit-guard.ts` behind per-document tokens), and
  `approval-service.ts` → `uploadWithApproval` + `content/upload-press.ts` (a portal's own
  Upload button, only with an approval token, through `submit-guard.ts`).
- What the vault holds, and how it is laid out: `src/matching/taxonomy.ts` (the keys —
  append-only), `src/ui/lib/field-groups.ts` (`DOCUMENT_GROUPS`, the folders the editor shows;
  every `doc.*` key belongs to exactly one, asserted by `field-groups.test.ts`), and
  `src/matching/frame.ts`, where a certificate issued once per qualification takes the level its
  question names (`doc.study_certificate` + "SSLC" -> `doc.study_certificate_10`).
  Nothing is entered twice: a question that names no qualification is answered from the most
  recent one the user holds (`src/matching/qualifications.ts`).
- Whose vault it is: `src/matching/pathway.ts` (the user's own board, route, stage, entrance
  exams, category and claims — pure rules, no UI import) and `src/ui/lib/vault-shape.ts`, the
  only place that decides which blocks and folders a panel renders. Two invariants hold it
  together, both tested: a key that holds a value is never hidden, and no stored path means the
  whole catalogue. The answers are sealed in the vault (`vault.path` in `settings-store.ts`,
  reached by `path:get`/`path:set`) and travel in the backup.
- Choice questions: `src/matching/choose-option.ts` decides which offered option a saved value
  means — the same words, the same meaning ("M"/Male, "GM"/General, CBSE's initials), the band a
  number falls in, a course's family, shared words, then "Other" with the value as its answer;
  `sure: false` asks the review for a look, and with no fit and no "Other" it chooses nothing.
  Native dropdowns and radios use it in `content/filler.ts`; Google Forms-style questions
  (role="listbox"/"radiogroup" divs) are found by the harvester and answered in
  `content/choice-widgets.ts`, whose `pressChoice` is the only press there and refuses buttons,
  links and anything submit-ish. `content/fill-field.ts` is the one entry for a field, and writes
  a native "Other"'s "please specify" box. Such a box is never matched as the key itself
  (`deterministic.ts` → `isOtherBoxOf`).
- Degree and branch names: `src/matching/courses.ts` — a catalogue of suggestions only. The
  fields stay free text; the setup card writes the chosen pair into
  `education.<level>.course`/`.branch`, and never over an answer the user typed.
- Full phase plan and definition-of-done: `IMPLEMENTATION_PLAN.md`.
- Portal in-bounds verdicts: `docs/portal-notes/`. Threat model: `docs/THREAT_MODEL.md`.
