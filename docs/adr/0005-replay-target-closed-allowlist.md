# ADR 0005 — replay target is a closed allowlist

- status: accepted
- date: 2026-06-12
- scope: `packages/contract`
- review severity: high

## context

`events.replay` re-sends a captured event to a target. If the target were a free-form
URL, replay becomes a server-side request forgery (SSRF) and confused-deputy vector —
acutely so when driven by an MCP agent, which could be steered into hitting internal
metadata endpoints (`169.254.169.254`) or other tenants' infrastructure.

## decision

The replay `TargetSchema` is a **closed discriminated union** with a single variant
today:

```ts
{ kind: "localhost-tunnel", sessionId: string }
```

There is **no free-form URL**. A remote target is a future, separately-scoped `kind`
that will require a registered allowlist plus an explicit SSRF guard before it ships.
`events.replay` also takes a required `idempotencyKey`; the persisted idempotency store
is the `delivery_attempts (org_id, idempotency_key)` unique index (migration 0003), so a
retried replay is de-duplicated.

## consequences

- Replay cannot be aimed at arbitrary hosts; the only destination is the developer's own
  machine via the CLI tunnel session.
- Adding remote delivery later is an additive `kind` behind its own guard and ADR — the
  closed union makes that a deliberate, reviewable change rather than a silent capability.
- Defined in `packages/contract` (`target.ts`, `capabilities.ts`); recorded in
  `docs/threat-model.md` (the replay-target boundary).

## amendment (2026-06-30, ADR-0081)

The "registered allowlist plus an explicit SSRF guard" precondition above is now built (ADR-0081): an
org-level `replay_destinations` allowlist (migration 0024) + a fail-closed, connect-time SSRF guard in the
engine. The replay `TargetSchema` is now a **two-variant** closed union — `{kind:"localhost-tunnel",
sessionId}` and the remote `{kind:"destination", destinationId}` arm. The remote arm references a
registered allowlist row BY ID, so there is **still no free-form URL**; this was the deliberate, ADR-
reviewed addition the closed union was designed to make safe. The server-delivered remote kind also
populates the previously-null `delivery_attempts.status_code` (a SEMANTIC evolution within the row's
existing nullable shape — no schema break), so the capability's output now carries the real HTTP outcome.
