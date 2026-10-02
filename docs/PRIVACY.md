# Privacy policy — AutoFill Assistant

Last updated: 2026-09-18. This describes what the software actually does; if you
find a discrepancy between this document and the behaviour, the behaviour is a
bug and the document is the specification.

## The short version

Your details never leave your device, except that you type them into the form
you chose to fill. There is no account, no server, no analytics, and no
telemetry. One optional feature makes a network request, and it sends the
*shape* of a form — never anything you have saved.

## What is stored, and where

| What | Where | Encrypted | Survives a browser restart |
|------|-------|-----------|---------------------------|
| Your saved details (name, address, ID numbers, bank details) | `IndexedDB`, on this device | Yes — AES-GCM 256, key derived from your passphrase with Argon2id | Yes |
| Your uploaded documents and the resized copies made from them | `IndexedDB`, on this device | Yes, same key | Yes |
| Your Anthropic API key, if you set one | `IndexedDB`, on this device | Yes, same key | Yes |
| The audit log — what was filled, where, what you approved | `chrome.storage.local` | No | Yes |
| Site profiles — which selector on a page corresponds to which field | `chrome.storage.local` | No | Yes |
| The state of a fill in progress | `chrome.storage.session` | No | No — cleared when the browser closes |

Nothing in the two unencrypted stores contains a value you typed. The audit log
records *which kind of field* was filled (`id.aadhaar`), never its contents,
unless you explicitly turn on value logging — which is off by default, and the
switch says what it costs.

## Reading details out of your documents

You can ask the extension to read a document you have uploaded and suggest
details to save from it — an Aadhaar number off an e-Aadhaar PDF, a name and
date of birth off a scanned card.

All of this happens on your device. The document is decrypted inside the
extension's own background worker, read there, and the text is discarded when
the reading finishes. **The document's contents are never sent anywhere**, and
they are never given to the optional AI helper — the boundary that keeps your
saved values away from that helper covers document text in exactly the same
way, and the same tests enforce it.

Two things about this are worth stating plainly:

- **Nothing is saved without you.** The extension shows you what it read, next
  to the line of the document it read it from, and saves only what you tick.
  Every value is editable before you save it.
- **A value read from a document is recorded as such.** It is stored with a
  note saying it came from a scan rather than from your typing, so if a
  misreading ever does get through, it can be found afterwards.

Where a number carries a check digit — Aadhaar does — the extension verifies it
and tells you whether it passed. A number that fails is not offered for saving
at all; you are told it was probably misread.

**PDFs locked with a password.** An e-Aadhaar or an e-PAN is downloaded locked.
When you save one, the extension asks you for its password — it never works
the password out for you — and keeps it with the document, encrypted in your
vault like the document itself, so you are asked once. It is used only to open
that document on this device: to read it, and to make the unlocked copy a form
asks for. It is never sent anywhere, and removing the document removes it.

## Putting your documents into forms

When a form asks for a document — a photograph, a signature, an Aadhaar card —
the extension fits your saved copy to what the form says it accepts (size,
format, dimensions) and puts it into the form's own upload box, the same way it
types your details into the form's text boxes. The fitting happens on your
device, in the background worker that holds your key.

- **The extension sends nothing.** The site receives a document when the form
  sends it, exactly as if you had chosen the file yourself. Some sites start
  uploading the moment a file lands in their box; that is the site's own code,
  as with sites that check a value while you type it.
- **The name the site sees is the kind of document** — `photo.jpg`,
  `aadhaar_card.pdf` — never your original filename, which is not stored.
- **A site's own Upload button is pressed only after you approve it**, one
  document at a time, with the same hold-to-approve as the final submit. Where
  that button sends the whole form, the extension first empties the form's
  other upload boxes, so only the document you approved goes with it.
- **Upload windows** (Google Forms' "Add file"): a document is attached there
  only by uploading it to the form owner's Google Drive, so it takes your
  approval first. One press-and-hold approves the form's documents; the
  extension then, one at a time, presses each question's Add file, puts the
  document in, and waits for the upload to finish. Or do it one document at a
  time with "Put … in the upload window". Either way nothing is uploaded
  without a deliberate action of yours.
- **A copy on disk, only if you ask.** If a site's upload window will not take
  the file, the panel can prepare a copy for you to choose by hand. Saving it
  writes an unencrypted copy to your Downloads folder, which stays there until
  you delete it. The panel says so beside the link.
- **High-sensitivity documents ask for your passphrase again** — a signature,
  an Aadhaar card, a PAN card — if it has been a few minutes since you last
  entered it, exactly as an Aadhaar *number* does.

The audit log records which kind of document went into which form, and which
uploads you approved — never a document's contents or its name.

## What leaves your device

**One thing, and only if you turn it on.** If you supply an Anthropic API key,
the extension can ask a language model to identify form fields the built-in
rules could not. What it sends:

- field labels, `name`/`id` attributes, input types, and dropdown option text,
- with anything that looks like a value removed first (numbers, emails, PANs,
  IFSC codes, dates, long identifiers),
- and then checked against your own saved details, so a portal that prints your
  name back at you cannot leak it through a label. If anything of yours
  survives that check, **the request is not sent at all**.

What it never sends: your saved details, your documents, filenames, or **the
address of the page you are on**. Each form is asked about at most once — the
answer is remembered locally.

If you do not set a key, the extension makes no network requests whatsoever.

## What we never do

- We never submit a form without an explicit approval action from you, and we
  never press a site's own Upload button without one either.
- We never read, solve, or bypass a CAPTCHA, a one-time code, or an electronic
  signature. Those steps are yours; the extension stops and waits.
- We never fill a password field.
- We never run without you: there is no headless mode, no scheduling, and no
  queue of applications.
- We never handle more than one person's details. There is one profile.

## What you are responsible for

**The accuracy of anything you submit.** This software helps you type faster; it
does not know whether your details are correct, whether you are eligible, or
whether a form means what you think it means. The review screen exists so that
you check before approving, and approving is a deliberate act for that reason.

You are also responsible for the terms of the sites you use it on.

## Permissions, and why each is needed

| Permission | Why |
|------------|-----|
| `activeTab` | To read and fill the page you are on, only from the moment you click the extension's button. It expires on navigation. |
| `scripting` | To inject the form-reading code into that tab on that click. Nothing is injected automatically. |
| `storage` | The local stores in the table above. |
| `sidePanel` | The panel is the extension's entire interface. |
| `offscreen` | To read text out of a document you asked it to read, and to open a PDF you saved. The reader runs in a worker that a service worker cannot start, and a PDF needs a library a service worker cannot load, so both happen in one of the extension's own hidden pages, which is closed again afterwards. No document leaves the device. |

**No `host_permissions`.** The extension has no standing access to any site.

**Optional, per-site access.** You can choose, one portal at a time, to let
AutoFill start protecting a page from the moment it loads rather than from the
moment you click. This exists for one specific case: if a portal reloads the
page with your values already in it and submits them automatically, the guard
would otherwise arrive too late. Nothing is granted unless you press the button,
it applies to that one site, and the panel lists every site you have granted
with a way to take it back. The same per-site access is what the panel asks for
if a form's upload window is served by another site, and only when you press the
button to allow it.
**No declared content scripts** — nothing runs on a page until you ask it to.
**No `tabs`, `webRequest`, `cookies`, `history`, or `downloads`.**

## Deleting your data

- *Saved details and documents*: the vault editor, or uninstall the extension.
- *Audit log*: "Delete this log" in the panel.
- *Learned site profiles*: "Forget learned forms" in the panel.
- *API key*: "Remove key" in the panel.

Uninstalling removes all of it. There is no copy anywhere else, which also
means **there is no recovery**: if you forget your passphrase, your vault is
gone. Export a backup and keep it somewhere safe.

The setup questions — your board, what you studied, your category and any
reservation you claim — are stored **sealed in the vault**, like everything
else, because the answers say something about you. They decide only what this
panel offers you; no form is ever filled from them.

A backup holds the saved details **and the saved documents**, each still
encrypted exactly as the vault holds them — the export never decrypts
anything, so no plaintext copy of a document exists at any point. The file
opens only with the passphrase the vault had when it was written, and it is as
large as the documents inside it. The derived, portal-sized copies are left
out: they are a cache, and they rebuild from the originals.

## Contact

This is not a hosted service and there is no data controller to write to. Bugs
and privacy concerns belong in the project's issue tracker.
