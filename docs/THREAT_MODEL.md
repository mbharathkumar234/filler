# Threat model

Phase 0 deliverable. Revisit at every phase gate (§6.2) and before the Phase 10 external review.

This document answers one question per adversary: **what do they actually get?**

---

## Assets, ranked

| Asset | Where it lives | Worst case if lost |
|-------|----------------|--------------------|
| Vault plaintext (profile values, document bytes) | IndexedDB, encrypted at rest; plaintext only transiently in the service worker | Full identity-theft kit: Aadhaar, PAN, bank account, signature image |
| Master key | Service-worker memory only, never persisted | Equivalent to the vault |
| Vault passphrase | User's head; transiently in a UI input | Equivalent to the vault |
| `approvalToken` | Service-worker memory, 90 s TTL, single-use | One unapproved form submission |
| Site profiles | `site-profiles/*.json`, plaintext | Low — selectors only, never values |
| Audit log | Local, append-only | Reveals which portals the user applied to |
| Anthropic API key | User-supplied, extension storage | Attacker bills the user's account |

The signature image and the government-ID documents are the crown jewels. A leaked
Aadhaar *number* is bad; a leaked scanned signature plus an ID document is worse,
because it is directly usable for forgery.

---

## 1. Stolen laptop

**Attacker capability:** full disk access, offline, unlimited time. May or may not have
the OS login password.

**What they get:**

- IndexedDB contents — AES-GCM 256 ciphertext only. No plaintext values, no plaintext filenames.
- Site profiles and the audit log in plaintext: which portals the user targeted, which field
  keys were filled, and when. **Not the values.**
- Nothing from `chrome.storage.local` — the master key is never written there.

**What stands between them and the vault:** one PBKDF2-SHA256 pass at >=600k iterations over
a user-chosen passphrase. This is the weakest link in the whole design. A 6-character
passphrase falls to an offline GPU attack regardless of the iteration count.

**Mitigations:**

- Passphrase strength floor, enforced at vault creation, with an honest strength meter (Phase 1).
- Auto-lock: key zeroed after 15 minutes idle and on browser close (Phase 1).
- Argon2id migration (Phase 10) — memory-hard, which is what actually blunts GPU cracking.
- High-tier keys masked in the review UI and excluded from logs by default (§6.3).

**Residual risk (accepted):** a weak passphrase defeats everything above. The onboarding
disclosure must say so plainly rather than implying the encryption alone protects them.

---

## 2. Malicious portal page

**Attacker capability:** arbitrary JavaScript in the page the extension is about to fill.
This is the *expected* case, not the exotic one — treat every portal page as hostile (§ Phase 10).

**What they try:**

| Attack | Defence |
|--------|---------|
| Read vault values out of the extension | Content-script isolated world; vault never enters page context. Only resolved values for *this form's fields* are written, one at a time. |
| Steal the `approvalToken` | Token lives in the service worker, never in the DOM or page context, TTL 90 s, single-use. |
| Forge a message to the background worker | `assertTrustedSender` rejects anything without our extension id; Phase 10 adds schema validation. |
| Trick the extension into filling a hidden field with an ID it never asked for | The plan is built from harvested descriptors with a recorded label; the review screen shows the portal's own label per field, so a hidden `id.aadhaar` field surfaces to the user before approval. |
| Fire `form.submit()` to submit without approval | `submit-guard.ts` installs at `document_start`, capture phase, and patches `form.submit()` for the page's forms (best-effort, documented). Adversarial e2e test required (§ Phase 5 Verify). |
| Prompt-inject via label/nearby text to make the LLM mis-map a field | LLM output is a closed vocabulary, capped at 0.8 confidence, merged *under* rules, and never auto-fills a `high` key without confirmation. |

**Known limitation, stated honestly:** patching `form.submit()` is best-effort. A page that
captures a reference to the original prototype method before our `document_start` script runs
can bypass it. This is why P2's real guarantee is the *token*, not the patch: no fill run ever
reaches a submit click without an approval gesture, and a page that submits itself submits
whatever the user could already see on screen.

---

## 3. Malicious extension update

**Attacker capability:** signing key or build pipeline compromise — ships a version that
exfiltrates the vault. This is the most severe scenario in the model, because the user has
already granted the extension everything.

**What they get:** everything. The extension legitimately holds the master key in memory
while unlocked. No client-side control defends against a hostile version of yourself.

**Mitigations are all process, not code:**

- Reproducible builds; publish the build hash alongside each release.
- Two-person review on anything touching `vault/`, `redaction.ts`, or `submit-guard.ts`.
- CI-blocking canary leak test (§6.1) — catches accidental exfiltration, not deliberate.
- No auto-update of site profiles from a network source without signature verification
  (Phase 9): an unsigned profile registry is a second, softer update channel and must be
  treated as untrusted input.
- Minimal dependency surface; `npm audit` and licence check at every release (Phase 10).

**Residual risk (accepted and disclosed):** a deliberately malicious release is undetectable
from inside the product. Users' real protection is the extension's small, auditable surface
and the reproducible build.

---

## 4. Compromised Anthropic API key

**Attacker capability:** holds the user's key, can call the API as them, and can see anything
the extension has ever sent.

**What they get:**

- The ability to bill the user's account. Cost is bounded in practice by profile caching
  (one call per form lifetime, §6.4) but not bounded for the *attacker*, who can spend freely.
- **Historical payloads: DOM skeletons only.** Field labels, `name`/`id` attributes, types,
  option lists, and nearby text from portals the user visited. This reveals *which portals*
  and *what kind of form* — it does not reveal a single profile value, document byte, or
  filename (P3).

That second line is the whole reason P3 exists, and the canary leak suite is what keeps it
true. If a value ever reaches the payload, this row silently becomes "full identity theft".

**Mitigations:**

- `redaction.ts` is the only payload builder; it cannot import `vault/` or `documents/`
  (module boundary + lint rule, Phase 8).
- Canary strings seeded in the vault; CI fails if one appears in any outbound payload.
- Key stored encrypted alongside the vault; deleting it degrades to deterministic-only mode
  rather than breaking the extension (§ Phase 8 Verify).
- Token/cost meter in settings so anomalous spend is visible (Phase 8 Should Achieve).

---

## Out of scope, deliberately

- **Portal-side compromise.** If the portal itself is breached, the user's submitted data is
  gone by a route that has nothing to do with this extension.
- **Network interception.** All portal traffic is the user's own authenticated HTTPS session;
  the extension adds one egress point (the Anthropic API, over TLS).
- **Coercion / shoulder-surfing.** Out of a software threat model.
- **Defeating security controls.** By P4 the extension never reads a CAPTCHA or an OTP, so
  there is no attack surface here to model — that is the point of P4.
