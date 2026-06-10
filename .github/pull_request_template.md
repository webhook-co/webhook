<!-- Keep PRs small and focused. The required CI checks must pass before merge. -->

## What & why

<!-- What does this change do, and why? Link any issue. -->

## How it was tested

<!-- Commands run, scenarios covered. Automated tests are expected for behavior changes. -->

## Human UI / visual testing

> **Does this require human UI/visual testing?** (rendering, layout, interaction, copy in the UI,
> CLI output that a human must eyeball, anything an agent cannot verify itself)

- [ ] **No** — fully covered by automated checks.
- [ ] **Yes — STOP: a human must verify this before merge.** Do not merge until a human has
      visually confirmed it. (Agents: flag for human testing; do not self-approve or merge.)

## Checklist

- [ ] Tests added/updated for the change (and they actually exercise the new behavior).
- [ ] Coverage is maintained or improved — thresholds were **not** lowered to pass CI.
- [ ] No focused/skipped/disabled tests (`*.only`, `*.skip`, `fdescribe`, `xit`, etc.).
- [ ] No CI bypasses — did **not** use `--no-verify`; all required checks pass.
- [ ] Security reviewed: no secrets/keys/credentials committed; external input validated at the
      boundary; no PII/PHI leaked to logs or responses; authz/SSRF considered.
- [ ] Respects the constitution (compliance-by-design, CLI/API/web/MCP parity, private-by-default,
      cookieless ingestion apex, Standard Webhooks, open-core `ee/` boundary).
- [ ] Conversations resolved and docs/changelog updated where relevant.
