# Firefox port — assessment

**Status: not done.** This document is the audit, not the port.

Phase F lists a Firefox port under *Should Achieve*. It has not been built, and
this file exists so that "not done" comes with a reason and a scope rather than
an empty checkbox. Everything below was measured against the tree at the commit
that added this file; the API-support claims about Firefox itself are from
general knowledge and **should be re-checked against current Firefox
documentation before anyone starts** — they are the part of this document most
likely to have moved.

## Why not a shim

A compatibility layer could be written in an afternoon and would compile. It
would also be untestable here: there is no Firefox in this environment, and an
extension that has never been loaded into the browser it claims to support is
not ported, it is merely typed. Shipping shims that create the appearance of
support is worse than the honest gap, because the next person reads the shim
and assumes somebody tried it.

## What the codebase actually uses

Surveyed across `src/`, excluding tests and comments:

| API | Firefox MV3 | Note |
|-----|-------------|------|
| `chrome.storage.local` / `.session` | supported | `.session` needs Firefox 115+ |
| `chrome.runtime.*` (messaging, lifecycle) | supported | |
| `chrome.tabs.*` (query, get, sendMessage, create, onRemoved) | supported | |
| `chrome.scripting.executeScript` | supported | |
| `chrome.scripting.registerContentScripts` | supported | Firefox 102+ |
| `chrome.permissions.*` | supported | |
| `chrome.i18n.getUILanguage` | supported | only read for a default; the panel's own catalogue is in `src/ui/lib/i18n.ts` |
| **`chrome.sidePanel`** | **not available** | the blocker below |

`chrome.webNavigation` and `chrome.history` appear in the tree only inside
comments explaining why they are *not* used. Nothing needs porting there.

## The two real blockers

### 1. The side panel

`chrome.sidePanel` and the `side_panel` manifest key have no Firefox
equivalent. Firefox has `sidebar_action`, which is a different manifest key, a
different API, and — the part that matters — a different lifecycle: it is not
opened by an action click in the same way, and `setPanelBehavior({
openPanelOnActionClick: true })` has no direct counterpart.

The panel is not a detail of this extension; it is where the whole product
lives. Every screen in `src/ui/` renders inside it, and P1 ("the user is
present") is expressed through it. A port means a second host surface, and the
sensible shape is an adapter that both manifests point at rather than
conditionals sprinkled through the UI.

Scope: one new entry point, one manifest variant, and `src/background/index.ts`
line 73 made conditional. The React tree underneath should need nothing.

### 2. The background entry point

The manifest declares `background.service_worker` with `type: 'module'`.
Firefox MV3 uses an event page — `background.scripts` — instead. This is a
manifest change rather than a code change, but it brings a behavioural
difference worth checking rather than assuming: the extension already treats
its background as terminable (that is why run state is persisted to
`chrome.storage.session` on every transition, and why `crash-safety.test.ts`
exists), so the design is compatible in principle. Whether it is compatible in
practice is exactly what running it would tell you.

## What would need re-verifying, not just re-compiling

- **Argon2id via WASM.** `wasm-unsafe-eval` is a Chrome CSP directive.
  Firefox's handling of WASM in extension pages differs and needs testing, not
  reasoning. If it fails, the vault does not open — this is the highest-risk
  item on the list.
- **The submit guard.** Its whole value is capture-phase interception at
  `document_start`. Event ordering and `registerContentScripts` timing are
  precisely the sort of thing that differs between engines, and P2 depends on
  it. `tests/e2e/` would need to run against Firefox, not merely pass on
  Chromium.
- **`optional_host_permissions` prompting.** Firefox's permission UX differs,
  and the early-guard flow in `src/background/early-guard.ts` is built around
  Chrome's.

## Recommended order

1. Manifest variant + background entry point. Get it loading at all.
2. Vault unlock, to settle the WASM question early — if Argon2id does not work,
   the rest of the plan changes.
3. Sidebar adapter, so the UI is reachable.
4. Run `npm run e2e` against Firefox. The submit-guard adversarial specs are
   the ones that decide whether the port is real.

Nothing here should be marked green on the basis of steps 1–3.
