# <Portal display name>

- **site-id:** `<kebab-case-id>` (must match `fixtures/<site-id>/` and `site-profiles/<site-id>.json`)
- **Entry URL:** <https://...>
- **Form URL(s):** <https://...>
- **ToS / acceptable-use URL:** <https://...>
- **Read on:** YYYY-MM-DD by <name>

## Why this portal

<Which repetitive form is it, and roughly how often does a user fill it? If nobody fills it
twice, it does not belong on the target list.>

## Relevant ToS clauses

> <Verbatim quote of the clause that governs automated or assisted interaction. Include the
> section number. Do not paraphrase.>

> <Second quote, if the ToS separately addresses bulk access, scraping, or third-party tools.>

## Reading

<Two to five sentences. Does the language prohibit automation outright, prohibit only
unattended/bulk access, or say nothing? Note explicitly whether "automated means" is defined
in the document, and whether a human-approved single submission plausibly falls inside it.>

## Technical notes

- **Stack:** <ASP.NET WebForms / React SPA / plain HTML / ...>
- **Postbacks:** <yes/no — does `__doPostBack` regenerate ids? Phase 6 relevance.>
- **Blockers present:** <CAPTCHA type, OTP step, eSign/DigiLocker redirect, payment gateway>
- **Multi-step wizard:** <yes/no, how many steps>
- **Dependent dropdowns:** <e.g. State -> District -> Taluk>
- **Scratch/dummy application available:** <yes/no — needed for pre-release smoke tests, §6.1>
- **Document slots:** <which `doc.*` keys, with the constraint text quoted verbatim>

## Fixtures captured

- [ ] `fixtures/<site-id>/page-1.html` — <which step>
- [ ] PII stripped and verified (grep for the test values you typed)

## Verdict

**`assistive-ok` | `unclear` | `prohibited`**

<One or two sentences justifying the verdict against the quoted clauses. If `unclear` or
`prohibited`, state what would have to change for that to be revisited.>
