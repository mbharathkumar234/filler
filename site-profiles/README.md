# Site profiles

Versioned JSON selector maps, one per portal: `site-profiles/<site-id>.json`. These are
shippable — and, per Phase 9, potentially shareable between users.

**Profiles contain selectors only, never values.** A profile that carries a user value is a
data leak in a file format designed to be exported. Treat an imported profile as untrusted
input (Phase 9).

Populated in Phase 4. Empty at Phase 0 by design — a profile for a portal whose ToS verdict
is not yet `assistive-ok` must not exist.

## Schema

```json
{
  "siteId": "example-portal",
  "version": 3,
  "matchUrl": "https://portal.example.gov.in/apply*",
  "formFingerprint": "sha256:...",
  "createdAt": "...",
  "lastVerifiedAt": "...",
  "fields": [
    { "key": "family.father_name", "selectors": ["#txtFName"], "confidence": 1.0, "source": "taught" }
  ],
  "documents": [
    {
      "key": "doc.photo",
      "selectors": ["#fuPhoto"],
      "constraint": {
        "mime": ["image/jpeg"],
        "minBytes": 20480,
        "maxBytes": 51200,
        "dimensionsMm": [35, 45]
      }
    }
  ],
  "submit": { "selectors": ["#btnFinalSubmit"], "label": "Final Submit" },
  "blockers": [{ "type": "captcha", "selectors": [".g-recaptcha", "#imgCaptcha"] }]
}
```

The TypeScript counterpart is `SiteProfile` in `src/shared/types.ts` — keep them in step.

## Versioning

`version` is bumped whenever a taught mapping changes a selector (Phase 9). Old versions are
retained for rollback. `lastVerifiedAt` records the last time the selectors were confirmed to
resolve against the live portal; a profile whose selectors resolve at <60% is stale and
prompts for repair rather than filling a half-broken form.
