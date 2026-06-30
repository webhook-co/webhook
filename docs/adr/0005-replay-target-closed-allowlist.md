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

The "registered allowlist plus an explicit SSRF guard" precondition above is now being built (ADR-0081):
an org-level `replay_destinations` allowlist (migration 0024) + a fail-closed, connect-time SSRF guard.
The remote target is the additive `{kind:"destination", destinationId}` arm — it references a registered
allowlist row by id, so there is **still no free-form URL**. The arm lands with the server-side delivery
slice; this remains a deliberate, reviewable change, exactly as the closed union intended.
