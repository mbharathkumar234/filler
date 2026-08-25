# AutoFill Assistant

A Chrome (MV3) extension that stores your personal details and documents **once**, then helps
you fill repetitive portal forms — pausing for human steps, stopping before submission, and
requiring your explicit approval.

It is an assistant for a person at the keyboard. It is not a bot.

## What it will never do

| | |
|---|---|
| **P1** | Run unattended. No headless mode, no scheduled runs, no queue of accounts. |
| **P2** | Submit a form without an explicit approval gesture on a review screen. |
| **P3** | Send your data off the device. The LLM sees form structure — never your values. |
| **P4** | Defeat a security control. No CAPTCHA solving, no OTP reading, no eSign automation. |
| **P5** | Act unaccountably. Every run is written to a local append-only audit log. |
| **P6** | Support bulk or multi-profile submission. One account, one user. |

## Status

**Phase 5 complete — it fills forms now.** Create an encrypted vault and enter your details once.
Add document masters and get portal-sized versions on demand. Press **Scan page** on any form to see
what each field maps to and why, then **Fill this form** to write the values in — with Undo, and with
a status pill and Abort button on the page itself.

**It will not submit.** A capture-phase guard blocks every submit path — button clicks, Enter,
scripted `form.submit()` — unless handed a single-use approval token, which only the Phase 7 review
screen can issue. The adversarial fixture that fights back on a timer is part of the test suite.

The product target is **any portal**, not a hand-picked shortlist: site profiles are a cache and a
repair mechanism, not a precondition. See the scope amendment at the top of the plan.

## Development

```sh
npm install
npm run dev              # build the unpacked extension into dist/
npm test                 # vitest unit tests
npm run typecheck        # tsc --noEmit
npm run lint             # eslint
npm run fixtures:serve   # serve fixtures/ on :4173
npm run e2e              # playwright against the served fixtures
```

Regenerate the oversized test photo with `node scripts/make-photo-fixture.mjs`.

Load the extension: `chrome://extensions` -> enable Developer mode -> **Load unpacked** ->
select `dist/`. Click the toolbar icon to open the side panel.

## Layout

See §2 of `IMPLEMENTATION_PLAN.md`. The short version:

- `src/matching/taxonomy.ts` — the canonical field keys everything else keys off. Append-only.
- `src/shared/types.ts` — locked type contracts (FieldDescriptor, MatchResult, RunState, FillPlan).
- `src/vault/` — encrypted storage. `session.ts` is the sole owner of the unlocked key.
- `src/documents/` — constraint parsing and the derivation pipeline. Pure logic; `raster.ts` is the
  only part that touches a canvas.
- `src/content/` — the harvester. Read-only: it never writes to the page. Injected on an explicit
  click, never declared in the manifest.
- `src/matching/` — taxonomy, synonym dictionary (`synonyms.json`, editable without code), the
  deterministic matcher, and site-profile lookup. Runs in the worker, never in the page.
- `src/background/vault-service.ts` — the only bridge between the message bus and the key.
- `site-profiles/` — versioned selector maps. Selectors only, never values.
- `fixtures/` — saved portal HTML for tests. Never a live portal.
- `docs/` — portal ToS verdicts and the threat model.

Standing instructions for Claude Code sessions live in `CLAUDE.md`.
