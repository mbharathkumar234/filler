# Fixtures

Saved portal HTML, one directory per site profile: `fixtures/<site-id>/page-1.html`.

Served locally by `npm run fixtures:serve` (http://localhost:4173). **E2E tests never touch a
live portal** (§6.1) — Playwright's `baseURL` points here.

## Capturing a fixture

1. Confirm the portal's verdict in `docs/portal-notes/<site-id>.md` is `assistive-ok`.
   Do not capture fixtures for `prohibited` portals.
2. Open the form, `Ctrl+S`, save as **Webpage, Complete**.
3. Drop it in `fixtures/<site-id>/page-1.html` (one file per wizard step: `page-2.html`, ...).
4. **Strip all real PII.** Use obviously-fake values, then grep the file for anything you
   actually typed — including in `value=` attributes, hidden inputs, and `__VIEWSTATE`.
5. Note in the portal file which step each page is.

## Hostile variants

Phase 6 needs fixtures that misbehave on purpose (§ Phase 6 Verify):

- resets all field values on a simulated postback,
- regenerates element ids on each load,
- contains a fake CAPTCHA gate,
- calls `form.submit()` on load (the Phase 5 adversarial test),
- embeds a cross-origin iframe.

Name these `page-1.hostile-<what>.html` alongside the clean capture.

## demo-portal/

Hand-written, synthetic, not a copy of any real site. It exists so `fixtures:serve` and the
e2e harness have something to run against before real portals are chosen. Keep it — it is
also the "demo fixture form" the Phase 10 onboarding flow fills.
