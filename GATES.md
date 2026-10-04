# Gate ledger — `MASTER_PROMPT.md`

> Only the human sets a phase to `APPROVED` or records a waiver. The agent sets every other status,
> and builds only for the first phase below that is not `APPROVED`.

## Reference machine and budgets

| Item | Value | Set by |
|---|---|---|
| Reference machine | 4 CPU cores, 8 GB RAM, integrated graphics, Windows 11, current stable Chrome (default until the human records their own) | default |
| Core install budget | 40 MB (proposed; confirm in U8) | default |
| `content.js` budget | current size + 150 KB (proposed; confirm in U2) | default |
| Passbook photo read | ≤ 2 s on the reference machine | default |

## Baseline (filled in when U0 passes)

| Metric | Baseline |
|---|---|
| High-confidence mismatches | — |
| Mapped correctly, per category | — |
| Fill-stick | — |
| Portal errors left after filling (from U1) | — |
| Document field accuracy | — |
| Median time per form / per document page | — |
| Install size | — |

## Phases

| Phase | Name | Status | Gate report | Approved (by, date) | Waivers |
|---|---|---|---|---|---|
| U0 | Ground truth: measure before building | NOT-STARTED | — | — | — |
| U1 | Read the portal's errors and fix them first | NOT-STARTED | — | — | — |
| U2 | Every form control a real portal uses | NOT-STARTED | — | — | — |
| U3 | Names "as per document", checked before submitting | NOT-STARTED | — | — | — |
| U4 | Privacy anyone can verify | NOT-STARTED | — | — | — |
| U5 | Understand any label on the device; retire the API key | NOT-STARTED | — | — | — |
| U6 | Portal playbooks | NOT-STARTED | — | — | — |
| U7 | Photo and signature studio | NOT-STARTED | — | — | — |
| U8 | Small and fast on a budget laptop | NOT-STARTED | — | — | — |
| U9 | Remember every application | NOT-STARTED | — | — | — |
| U10 | Jobs, KYC and travel | NOT-STARTED | — | — | — |
| U11 | Launch readiness | NOT-STARTED | — | — | — |
