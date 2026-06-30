# ADR 0081 — remote replay destinations: a pre-registered allowlist behind an SSRF guard

- status: accepted
- date: 2026-06-30
- scope: `packages/shared`, `packages/db`, `packages/contract`, `apps/api`, `packages/cli`, `apps/engine`
- review severity: high (the server's first user-controlled outbound HTTP — an SSRF surface)

## context

ADR-0005 froze the replay `TargetSchema` as a closed union (localhost-tunnel only) and named the
precondition for ever delivering to a remote host: "a registered allowlist plus an explicit SSRF guard."
Outbound delivery (S3) needs the **server** to deliver a stored event to a user's remote endpoint. A server
performing outbound HTTP to a user-controlled destination is a server-side request forgery (SSRF) +
confused-deputy vector — acutely so when driven by an MCP agent, which could be steered at internal
metadata endpoints (`169.254.169.254`) or another tenant's infrastructure (ADR-0005). This ADR records the
posture that makes remote replay safe.

## decision

**A remote replay targets a PRE-REGISTERED destination, never a free-form URL, and every delivery is guarded
at connect time.**

- **A pre-registered allowlist (`replay_destinations`).** An org registers the https URLs it permits as
  replay destinations (migration 0024; org-scoped, full RLS, soft-delete). The replay `TargetSchema` gains a
  `{kind:"destination", destinationId}` arm that references a row by id — the replay call can never carry a
  raw URL, so even a compromised or over-eager caller can only reach an org-registered, auditable
  destination. Management is `replayDestinations.{create,list,delete}` at api + CLI parity (reusing the
  `endpoints:*` scopes), **web-deferred** (the dashboard epic) and **mcp-exempt**: an agent must not be able
  to mutate the egress allowlist — the confused-deputy vector ADR-0005 names — which is a DIFFERENT rationale
  than `events.replay`'s "localhost is CLI-intrinsic", and is recorded distinctly. The handlers bind on a
  dedicated api-only map, NOT the shared map `apps/mcp` builds, so the exemption is un-driftable.

- **A structural guard at registration; an authoritative guard at delivery.** `canonicalizeAndValidateUrl`
  (a pure, dependency-free module in `packages/shared`) rejects, at registration: non-https schemes,
  embedded credentials, IP-literal hosts (every decimal/octal/hex/short-form encoding canonicalizes to an IP
  literal via the WHATWG URL parser and is caught), disallowed ports, and single-label / non-FQDN hosts.
  Registration is an early reject for honest mistakes and an audit point — it is NEVER a "safe, skip the
  guard" flag. The AUTHORITATIVE guard runs UNCONDITIONALLY at delivery time in the engine (the egress
  chokepoint): resolve the host and reject any resolved address that falls in a private / loopback /
  link-local / metadata / CGNAT / ULA range (a fail-closed deny-list), and never follow a cross-origin
  redirect. CIDR membership is hand-rolled arithmetic, not a Node polyfill, so on the Workers runtime it
  cannot silently fail open.

- **The engine is the single egress chokepoint.** The outbound POST is performed by the engine (the
  ADR-sanctioned delivery home + KMS custodian), reached from `apps/api` over a service binding — api never
  makes the user-controlled outbound call itself. The engine re-authorizes each request (it re-derives the
  stored payload's key from the authenticated principal's org rather than trusting a key it is handed), so a
  tenant-boundary slip upstream cannot turn the engine into a cross-tenant oracle.

This decision ships in two slices: **(1a)** the allowlist registry + the shared structural guard; **(1b)**
the `{kind:"destination"}` target arm + the engine delivery dispatcher (the connect-time resolve guard +
the actual POST). The remote kind fulfils the "future remote target" ADR-0005 anticipated and is the
"server itself delivers and observes the response" record ADR-0016 reserved; for the remote kind the
recorded `delivery_attempts` row carries the real `status_code` (the previously-null placeholder) — an
evolution of the row's SEMANTICS within its existing nullable shape, not a schema break.

## consequences

- Replay can reach a remote host, but only an org-registered one, and only through a connect-time guard —
  the closed union plus the allowlist keep this a deliberate, auditable capability rather than a silent SSRF
  surface.
- The application guard is defense-in-depth ATOP the Workers runtime's public-only egress default; the
  precise range coverage and the residual-risk analysis are tracked internally — this public record states
  the posture, not an attack recipe.
- Remote outbound delivery is a paid-tier capability; metering and enforcement are a separate concern, not
  decided here.
- Amends ADR-0005 (the prophecy is now being built); ADR-0016's localhost decision is unchanged — the remote
  kind is exactly the server-delivered case it reserved. Recorded in `docs/threat-model.md` (the
  replay-target boundary).
