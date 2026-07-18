# ADR-0122: org-wide events browse, and the canonical `GET /v1/events` route

- **Status:** Accepted
- **Date:** 2026-07-18
- **Relates to:** ADR-0002 (Hyperdrive caching disabled for tenant reads), ADR-0102 (dashboard listen-ticket transport)

## Context

Events were reachable **only through an endpoint**: `events.list` hard-required an `endpointId`, the API route
was `GET /v1/endpoints/{endpointId}/events`, and the dashboard had no place to answer "what just arrived across
my whole org?". Getting there meant fanning out `endpoints.list` → N× `events.list`, which is exactly the
question the canonical agent + operator both ask first.

## Decision

**`endpointId` becomes optional on the `events.list` capability — omit it to browse the whole org — and the
API gains a canonical top-level route while the old nested route stays as a deprecated alias.**

1. **Two typed doors, one SQL body.** The db layer reaches org-wide scope by calling a differently-named,
   greppable function (`listOrgEvents` / `tailOrgEventsWithCursors`) — never by forgetting to pass a field.
   Both funnel through one query body whose only difference is that the `endpoint_id =` predicate is dropped
   org-wide; **RLS (`org_id = current_org_id()`) is then the only scope.** The endpoint-existence gate stays
   bolted to the required-`endpointId` door, so org-wide has no `not_found` arm.

2. **Canonical route + deprecated alias.** `GET /v1/events?endpointId=…` (operationId `eventsList`) is
   canonical; `GET /v1/endpoints/{endpointId}/events` (operationId `eventsListByEndpoint`) remains as a
   **deprecated alias** so published SDKs don't break. `routes.test.ts`'s strict one-route-per-capability
   bijection is **strengthened**, not weakened, into: every capability has exactly one _canonical_ route;
   every _alias_ names a capability that has a canonical route; operationIds are unique. (Weakening a drift
   guard to ship a feature is the smell; expressing a real concept — canonical vs alias — is not.)

3. **Four-surface parity.** The widening ships identically on API, CLI, web, and MCP, plus all four generated
   clients (TS/Python SDKs, the Go SDK, and the CLI), each with a deprecated by-endpoint method retained. New
   facets — `method`, `eventType`, `dedupStrategy` — land on every surface too, and `receivedAfter` accepts
   the existing `parseSince` relative grammar (`7d`/`24h`/`30m`/`now`).

## Consequences

- **Isolation rests entirely on RLS + an uncached tenant pool.** The org-wide reads carry _no_ per-org bound
  parameter (like `listDeliveries` before them), so their Hyperdrive cache key would be identical across
  orgs. This is safe only because the tenant pool has query caching disabled (ADR-0002), which a deploy-time
  preflight (`hyperdrive-cache-posture`) now enforces rather than trusting a comment.
- **Performance is index-usable.** The org browse rides `events_org_ordered_idx (org_id, received_at, id)`
  (migration 0089), which subsumes the old `events_org_recent_idx`. Both the DESC browse and the ASC live
  tail are ordered index scans with no Sort node; the index is deliberately **non-partial** so the retention
  and billing readers (which must see tombstoned rows) keep using it.
- **The org-wide live tail** reuses the listen-ticket transport with an additive scope discriminator — see
  ADR-0102's amendment; RLS is already the org boundary, so an org-scoped ticket grants no new authority,
  only a wider leaked-ticket blast radius bounded by the same TTL.
- **`eventType` is honest about coverage.** It is null for every provider outside stripe/github/shopify, so
  every surface's copy says so — a filter returning nothing means "we don't parse this provider's event
  type", not "no events".
