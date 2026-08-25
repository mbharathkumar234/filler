# Portal notes

One file per target portal: `docs/portal-notes/<site-id>.md`, written from `TEMPLATE.md`.

**This directory is the gate for Phase 0.** A teammate should be able to read it and know
exactly which portals are in-bounds and why (§ Phase 0 Verify).

## Status

> **Not yet done — blocked on a human decision.**
>
> Three target portals must be chosen, and their Terms of Service / acceptable-use pages
> read and summarised here. This cannot be delegated to a code-writing session: it is a
> reading-and-judgement task about specific real-world sites, and a wrong `assistive-ok`
> verdict is the "Portal ToS prohibits automation" risk in §6.4 (severity: High).

## The verdict

Every note ends with exactly one of:

| Verdict | Meaning | Consequence |
|---------|---------|-------------|
| `assistive-ok` | The ToS permits user-directed assistive tooling, or is silent on it while prohibiting only unattended/bulk automation — which this product structurally is not (P1, P6). | Build a site profile. Capture fixtures. |
| `unclear` | Prohibition language is broad or ambiguous enough that a reasonable reader could go either way. | Do **not** ship a profile. Revisit with a second reader, or contact the portal operator. |
| `prohibited` | The ToS forbids automated interaction, scripted form filling, or third-party tooling. | Drop it. Do not build a profile. Do not capture fixtures. |

Default to the stricter reading. `unclear` is a real answer — recording it honestly is more
useful than a confident guess.

## What to quote

Quote the actual clause, verbatim, with the URL and the date you read it. A paraphrase is
not reviewable, and ToS pages change without notice — `lastReadAt` is what tells a future
reader whether the verdict is stale.

## Choosing targets

Good first targets tend to share these properties:

- A long, repetitive form the user genuinely fills more than once.
- A stable, non-obfuscated DOM (ASP.NET postbacks are fine — Phase 6 handles them; heavy
  canvas or WASM-rendered forms are not).
- A scratch/dummy application mode, so pre-release smoke tests (§6.1) can run without
  submitting a real application.
- No hard dependency on a step P4 forbids automating (eSign-only submission, for example,
  means the run ends at a handoff — which is acceptable, but know it in advance).
