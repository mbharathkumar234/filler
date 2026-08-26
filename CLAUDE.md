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
- Full phase plan and definition-of-done: `IMPLEMENTATION_PLAN.md`.
- Portal in-bounds verdicts: `docs/portal-notes/`. Threat model: `docs/THREAT_MODEL.md`.
