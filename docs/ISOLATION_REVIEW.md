# Content-script isolation review (§ Phase 10)

> "Content-script isolation review: the page must not be able to reach vault
> data, the approval token, or the message bus. Treat every portal page as
> hostile."

This is the review. Each claim names the mechanism and the test that would fail
if the claim stopped being true, because a review that is only prose ages badly.

## The threat

A portal page is hostile. Two distinct attackers:

1. **The page itself.** Runs in the page's world. Can rewrite the DOM, patch
   globals, and see anything the content script writes into the page.
2. **A compromised content script.** Runs in the extension's isolated world in
   that tab. This one is *a legitimate sender* on the extension bus, so every
   sender check says yes to it. It is the more interesting attacker and the one
   most of the design is aimed at.

## Claim 1 — the page cannot read the vault

**Mechanism.** The vault key exists only in the background service worker.
Vault records are read there, and only the values needed for *this form* cross
into the tab (`buildWrites`). The content script never holds the key, never
opens the vault database, and cannot ask for a value that is not part of a run
the user started.

**Bundle evidence.** `dist/content.js` is checked after every build for
`PBKDF2`, `deriveKey`, `autofill-vault`, and the matching dictionary. All zero.
The vault code is only in the worker chunk.

**Tests.** `fill-service.test.ts` — "sends one value per matched field, and
nothing else from the vault"; "ignores refs that were never part of the run".

**Residual.** Filling a field puts its value in the DOM. That is inherent — it
is what filling *is*. A page can read what we typed into it, exactly as it could
read what the user typed. The mitigation is scope: only this form's values, only
during a run the user started.

## Claim 2 — the page cannot reach the message bus

**Mechanism.** `chrome.runtime.sendMessage` from a page's own scripts does not
reach an extension that has not declared `externally_connectable`. This
extension has not. Every inbound message additionally passes
`assertTrustedSender` (`sender.id === chrome.runtime.id`), which Chrome sets and
a page cannot forge.

**Tests.** `messages.test.ts` — sender checks. `validate.test.ts` — the bus
refuses any message it does not recognise, by default.

## Claim 3 — a compromised content script cannot reach the vault

**Mechanism.** `isPrivilegedSender` distinguishes an extension page from a
content script by `sender.tab`, which Chrome sets for content scripts and never
for the panel. Every vault, document, teach, approval and audit message is in
`PRIVILEGED_TYPES` and is refused outright from a tab.

**The one exception, deliberately.** `fill:refill` originates in the page side,
because a postback that wipes a form has to be recoverable without sending the
user back to the panel. It is contained by a worker-held run authorisation: only
refs from a run *the user started on that tab*, only for ten minutes, and the
requested refs are intersected with that run's plan. The page asks; the plan
decides.

**Tests.** `fill-service.test.ts` — "refuses outright when no run is in
progress"; "ignores refs that were never part of the run"; "applies the re-auth
gate again".

## Claim 4 — the page cannot obtain the approval token

**Mechanism.** The token is minted in the worker and lives in an in-memory
registry there. **There is no message that returns it.** The panel asks for a
grant and later asks to submit; it never sees the value. The content script
receives the token exactly once, as the argument of the single submission it is
asked to perform.

**Tests.** `approval-service.test.ts` — "never hands the token to the caller"
(asserts no 32-hex-character string appears in the grant response).

**Residual.** The content script holds the token for the duration of one
`submitWithApproval` call. During that window a compromised content script could
use it — to perform the submission the user just approved, on the element the
user just approved, once. The token names the tab, the form fingerprint, and the
element, and it is burned before the click.

## Claim 5 — the page cannot restyle or spoof our own UI

**Mechanism.** The status overlay, the pause panel and the teach picker each
live in a **closed** shadow root with `all: initial`. A page cannot reach into a
closed root, and the reset stops a portal's global stylesheet from making our
controls invisible or making its own controls look like ours.

Every sentence shown while a run is blocked comes from the frozen `INSTRUCTIONS`
table in `blockers.ts`, never from page text — so a portal cannot write the
words in our overlay.

**Tests.** `blockers.test.ts` — "shows the user our words, never the page's".
`resume.spec.ts` — "tells the user what to do in our words, not the page's".

## Claim 6 — the page cannot make us defeat a security control

**Mechanism.** `blockers.ts` may notice that a CAPTCHA, OTP, eSign or payment
control exists and where it is. It cannot read one: the file contains no
`.value`, no canvas read, no `fetch`, no OCR, no `dispatchEvent`.

**Test.** `blockers.test.ts` asserts that **against the file's own source text**,
so adding any of those fails the build. Teach mode refuses those fields too —
there is no key in the taxonomy to teach them to.

## Claim 7 — the page cannot cause a submission

**Mechanism.** `submit-guard.ts` is the only module permitted to activate a
submit control, and only with a valid, unexpired, unburned token. Capture-phase
listeners on `click`, `submit` and `keydown[Enter]`, plus a best-effort patch of
`HTMLFormElement.prototype.submit`.

**Stated limit, tested rather than hidden.** The guard protects from the moment
it installs. A page that submits itself during load does so before we exist —
`fixtures/hostile-portal/page-onload.html` navigates, and the test asserts that
it does. P2 still holds there: nothing of ours had been filled.

**Tests.** `fill.spec.ts`, the whole "against a page that fights back" block.

## Claim 8 — a malformed message cannot reach a handler

**Mechanism.** `validateRequest` runs after the sender checks and before
routing. Default-deny: an unrecognised type is refused. Every privileged type is
covered, asserted by a test that diffs the two lists.

**Tests.** `validate.test.ts`, in full.

## What this review does not cover

- **An extension update that is itself malicious.** Out of scope for isolation;
  see `THREAT_MODEL.md`. Mitigation is process, not code.
- **A compromised browser or OS.** Nothing here survives that.
- **The user being deceived by the portal itself.** The review screen shows what
  will be submitted, but it cannot tell the user that the form is a scam.

## Outstanding

**An external security review of `vault/`, `submit-guard.ts` and
`redaction.ts`** — required by the Phase 10 Verify and **not done**. It is a
human activity that cannot be self-performed; this document is the material to
hand a reviewer, not a substitute for one.
