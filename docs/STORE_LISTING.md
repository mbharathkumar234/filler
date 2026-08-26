# Chrome Web Store listing — draft

Store review checks that the permission list matches the described behaviour and
that the description does not overclaim. This draft is written to survive that
check by being accurate rather than by being cautious.

## Name

AutoFill Assistant — Indian portal forms

## Short description (132 characters max)

> Fill repetitive Indian portal forms from details you save once. Stops before
> submitting. Nothing leaves your device.

(126 characters.)

## Detailed description

> Government, college, scholarship and exam portals ask the same forty questions
> every time. AutoFill Assistant stores your details once, encrypted on your own
> device, and fills them in when you ask it to.
>
> **It stops before submitting. Always.**
>
> You get a review screen listing every field it filled, what it filled from,
> and how confident it was. Anything it was unsure about is pushed to the top
> and has to be ticked before submission unlocks. Approving takes a deliberate
> press-and-hold, and the approval lasts ninety seconds and covers exactly one
> submission.
>
> **What it will not do**
>
> - It will not read or solve a CAPTCHA.
> - It will not read a one-time code from your phone or email.
> - It will not sign anything electronically.
> - It will not submit a payment.
> - It will not fill a password.
>
> When a form reaches one of those, it stops and hands the page back to you with
> a note about what is needed. Those steps are yours.
>
> **Where your details live**
>
> On this device, in encrypted storage, under a passphrase only you know. There
> is no account and no server. If you forget the passphrase, the data is gone —
> export a backup.
>
> **When a form is one it has not seen**
>
> It works out most fields from their labels. For the rest you can point at a
> field and say what it is; it remembers, and repairs itself when a portal
> redesign moves things.
>
> Optionally, you can supply your own Anthropic API key to have a language model
> identify unfamiliar fields. It is sent the *shape* of the form — labels and
> field names with anything value-like stripped out, checked against your own
> saved details before sending. Your details, your documents, and the address of
> the page are never sent. Without a key the extension makes no network requests
> at all.
>
> **You remain responsible for what you submit.** This types faster than you do;
> it does not know whether your details are right.

## Permission justifications

Reviewers ask for these one at a time.

**`activeTab`** — The extension reads and fills the form on the tab you are
looking at. `activeTab` grants that only from the moment you click the
extension's toolbar button, and the grant expires when the tab navigates. This
is the narrowest permission that allows a form-filler to work at all.

**`scripting`** — Used to inject the form-reading code into that tab, on that
click, via `chrome.scripting.executeScript`. **No content scripts are declared
in the manifest**, so nothing is injected into any page automatically.

**`storage`** — Local storage of the user's encrypted details and documents,
their audit log, and the site profiles that let a form be recognised a second
time. Nothing is synced.

**`sidePanel`** — The side panel is the extension's entire user interface.

**No host permissions are requested.** The extension has no standing access to
any website. `host_permissions` in the manifest is an empty array.

**`optional_host_permissions: ["*://*/*"]`** — reviewers will ask about this, so
the answer is here rather than buried. **Nothing is granted at install.** The
pattern is broad because the extension supports *any* portal a user chooses, and
Chrome requires an origin to be listed here before it can be requested at all.
What the user actually grants is one origin at a time, from a button in the side
panel, on a site they are already using.

The reason it exists: the submit guard normally starts when the user clicks the
extension. That is late enough to matter in exactly one case — if a portal
reloads the page with the previously filled values still in it and submits them
during `load`, they would go before the guard exists. Granting the origin lets
the guard register as a `document_start` content script **for that origin only**,
with `persistAcrossSessions: false`, and the panel lists every granted origin
with a one-click revoke.

If a reviewer would prefer the feature removed rather than the pattern narrowed,
it can be: the extension works without it, with that one window left open.

**Remote code:** none. All code is bundled. The one WebAssembly module is the
Argon2id password-hashing implementation, embedded in the package rather than
fetched, which is why the CSP includes `wasm-unsafe-eval` and nothing else.

**Network access:** one host, `api.anthropic.com`, only when the user has
supplied their own API key, and only carrying redacted form structure. This is
declared in the manifest's `connect-src`.

## Single purpose

Filling forms the user is already filling, on the page they are already on,
with details they have saved themselves — and stopping before submission for
their review.

## Category

Productivity → Workflow & Planning

## Pre-submission checklist

- [ ] Screenshots show the review screen, not just a filled form — the review
      screen is the product.
- [ ] The listing does not use the words "automatic", "automated", "bot", or
      "bulk". None of them describe this, and all of them invite rejection.
- [ ] Privacy policy URL points at `docs/PRIVACY.md`, published.
- [ ] The demo video, if any, shows the extension stopping at a CAPTCHA.
- [ ] `npm run build` output reviewed: no source maps shipped, no `console.log`
      of user data.
- [ ] Version bumped in `package.json`.

## Reading details out of your documents

The extension can read a document you have uploaded — an e-Aadhaar PDF, a
scanned card — and suggest details to save from it. This runs entirely on the
device: the document is decrypted in the extension's own background worker,
read there, and never transmitted. Nothing is saved without you ticking it, and
every suggested value is shown beside the line it came from and can be edited
first.

Where a number carries a check digit, it is verified before being offered.
