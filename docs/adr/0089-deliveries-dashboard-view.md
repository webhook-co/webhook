# ADR 0089 — deliveries dashboard view: information architecture + honest state rendering

- status: accepted
- date: 2026-07-01
- scope: `apps/web`
- review severity: medium (read-only observability surface; RLS is the tenant boundary)

## context

`deliveries.list` / `deliveries.get` shipped with S3 Slice 3 (ADR-0087) bound on CLI/API/MCP but
`WEB_DEFERRED` — no dashboard surface. This ADR records the decisions made building that deferred web view
(the first slice of the S1 dashboard-gaps lane). The read layer's ordered keyset pagination and its covering
indexes are provided by the shared reads (index-backed full-µs opaque cursor, migration 0036, PR #346); this
slice consumes them and adds no DB change.

## decision

### 1. Information architecture — a global deliveries surface, not a per-endpoint one

Deliveries are the **outbound** half: a `delivery_attempts` row records the engine (or a manual replay)
delivering a captured event to a **destination**. The data model keys a delivery by `destination_id` /
`subscription_id` / `event_id` — there is **no `endpoint_id`** on `delivery_attempts`. An endpoint's own story
is its *inbound* events (the events surface). So:

- The deliveries view is a **global, org-scoped** surface (a top-level "Deliveries" nav section) — a list
  (newest-first, keyset-paginated, status multi-select filter) plus a detail page. This matches the
  org-scoped, `destination`/`subscription`-filterable read.
- A **per-endpoint** deliveries embed is deliberately **not** built — it doesn't fit the model (no
  `endpoint_id`) and conflates inbound capture with outbound delivery. The **contextual** embed instead lands
  **per-destination** (the `destinationId` filter is index-served) on the destination detail page in a later
  slice.

### 2. Honest state rendering

The eight delivery states (`queued|forwarded|pending|delivered|failed|blocked|dead|cancelled`) map to a single
web-side `deliveryCopy` source of tone + label + hint (the surface never renders the raw enum). The surface
never implies more than is true:

- `blocked` reads "refused by the delivery guard — the destination isn't allowed" — true for **both** guard
  paths (a structural URL reject **and** a resolves-to-private refusal); the detail view's per-row `error`
  carries the exact reason. Never "malicious".
- `dead` reads "Undelivered — gave up after the last retry" (not jargon).
- `pending` shows a coarse retry clock ("Retrying in Nm/h") only when a future `next_retry_at` is set;
  otherwise "In progress".
- A null `destination_id` is labelled "localhost" **only** on a legacy `forwarded` row; any other state shows
  an em dash rather than an unverified assumption.

## consequences

- The web tier reads the DB directly under `withTenant(session.orgId)`; RLS is the tenant boundary. The
  browser-safe `Delivery` view carries no `org_id`/secret/internal pointer, and the load-more server action
  fails closed on any cursor that isn't `{uuid id, ISO-µs orderKey}` before it reaches SQL.
- A per-endpoint deliveries view is out of scope until (if) an `endpoint_id`-scoped read is added at parity.
- No contract change and no migration in this slice — it is purely the deferred web view over existing reads.
