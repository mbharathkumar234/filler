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

**Scope: the frame we write to.** Every write addresses the top frame —
`fill:apply`, a refill, a review edit, an approved submit or upload all go to
`frameId: 0` — so the gesture-injected guard installs there and nowhere else,
matching the `document_start` guard's `allFrames: false`. A guard in a sub-frame
protected nothing of ours and blocked the user's own press on Upload inside a
site's upload window (Google Forms' is a same-origin frame).
`extension.spec.ts` → "the guard stays out of sub-frames", proved to fail with
the old behaviour restored.

**A document's own Upload button.** Many portals put a submit-type Upload beside
each file box, and it posts the whole form. It goes through this same guard: the
user holds to approve one document, the worker issues a token naming exactly
that button — read from its own harvest, never from the panel, and never the
recorded final submit — and burns it before the press (`approval-service.ts`
→ `uploadWithApproval`, `content/upload-press.ts`). The form's other file boxes
are emptied first, so an approval for one document cannot carry another.
`documents.spec.ts` → "is blocked unapproved … and posts once, with one
document, approved"; `approval-upload.test.ts`.

**Upload windows get no guard and no listener.** Putting a document into a
site's upload window runs self-contained functions in that one frame
(`content/upload-window.ts`): one counts, one sets a file box or dispatches a
drop, and neither clicks. With one hold the user can approve every upload
window on a form; the presses that follow — each question's Add file, and a
window's own Upload or Insert if it waits for one — live in `submit-guard.ts`
(`openUploadWindowWithApproval`, `pressUploadInWindowWithApproval`) and each
refuses without a live single-use token issued from that hold
(`uploadAllWithApproval`). `documents.spec.ts` runs them from their own source
text: with a lapsed token neither presses anything.

## Claim 8 — a malformed message cannot reach a handler

**Mechanism.** `validateRequest` runs after the sender checks and before
routing. Default-deny: an unrecognised type is refused. Every privileged type is
covered, asserted by a test that diffs the two lists.

**Tests.** `validate.test.ts`, in full.

## Claim 9 — the document reader never runs in a page

**Mechanism.** The document reader — PaddleOCR's text detector and English
recogniser, run on ONNX Runtime — lives in a dedicated Web Worker, and a service
worker cannot start one, so the worker is started from an **offscreen document**
(`chrome.offscreen`, reason `WORKERS`) that the service worker opens on demand and
closes, with the reader in it, when the last reading is done. Three properties
matter for isolation:

- The offscreen page is one of the extension's own pages. It is never injected
  into a tab, has no `web_accessible_resources` entry, and a site cannot address
  it: `ocr:recognise` and the `pdf:*` requests are refused from anything with a
  `sender.tab`, by the page itself (`offscreen/ocr.ts`), which also checks each
  request's shape — the worker leaves these messages to the page, so the page
  applies the worker's rules.
- PDFs are opened there too, with pdf.js on the page's own thread: a service
  worker may not call `import()`, so it hands each PDF over (`pdf:lock`,
  `pdf:text`, `pdf:render`) and gets back an answer, a text layer or a PNG. A
  locked PDF's password travels with the request that needs it and is dropped
  with it; it is kept only in the vault, sealed with the document.
- The recognition engine is **not in the content script**. `dist/content.js` is
  checked after every build for the reader's own names (`readPage`,
  `uprightPage`, `findTextBoxes`, `decodeCtc`, `layoutText`), for `onnxruntime` and
  `InferenceSession`, and for the names of the engines it replaced.
  All zero.
- The extension's pages are cross-origin isolated (`cross_origin_embedder_policy:
  require-corp`, `cross_origin_opener_policy: same-origin`), which is what lets
  the reader's threads share memory. It is also a narrowing: an isolated page
  cannot embed a cross-origin resource that has not opted in, and cannot keep a
  window reference to a cross-origin page that opened it or that it opened.
  Each thread is the runtime's own file loaded again from this package — never
  a blob, never another origin.
- Nothing is fetched. ONNX Runtime's wasm and the nine models are files in the
  package, and so are pdf.js's image decoders (`pdfjs/`, given to pdf.js as its
  `wasmUrl` by `documents/pdfjs.ts`); the worker is started from its own URL,
  never a blob, and fetches its models only from the extension's own `ocr/`
  folder, so the only
  paths it is given are `chrome-extension://` ones. `connect-src` (`'self'` and
  `api.anthropic.com`) would refuse anything else, and an e2e test asserts that a
  real recognition makes **no request outside the extension's own origin**.

**Tests.** `no-ocr-in-content.test.ts` (the bundle), `sender-checks.test.ts`
(privileged type), `release-gates.test.ts` → "points the document reader at this
package, never at a CDN" (local paths, a URL-started worker, the CPU build of
the runtime, in the source) and "builds with the models it was measured with"
(pinned hashes) and "the reader’s threads" (the two manifest keys; the runtime
in a file of its own; the thread count taken from `crossOriginIsolated`), and
`e2e/ocr.spec.ts` (offscreen opened, answered, closed; the page isolated and
the runtime's file loaded once per thread, all from the package; the
reader's own model fetches observed, all local; no outside requests; no CSP
violations).

**Residual.** The document's decrypted bytes exist in three of the extension's
own background contexts while it is being read — the service worker that
decrypted it, the offscreen page that relays it, and the reader worker that
recognises it — rather than one. All three are the extension's, none is a page,
and the offscreen page is closed afterwards, ending the reader worker with it.

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
