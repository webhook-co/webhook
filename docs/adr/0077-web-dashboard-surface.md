# ADR 0077 — web dashboard surface: events + endpoint management at parity (DB-direct, R2/KV-on-web, CSP)

> **Superseded (partial), 2026-06-26.** The ingest-URL **one-time reveal** in the dashboard (the "shown only
> once" copy) is superseded by a decision to make the ingest URL **always-shown** — retrievable on demand
> from the endpoint detail and stored **envelope-encrypted at rest** (not hash-only). The create/rotate
> reveal dialogs and the detail page will be revised when that change ships (tracked in the internal
> backlog). API keys are unaffected — they remain one-time-reveal.

- status: accepted.
- date: 2026-06-25
- scope: web + a small `packages/contract` + `packages/db` change, shipped across three slices.
  `packages/contract` (un-defer 8 capabilities on the `web` surface — `endpoints.list/get/create/delete/
  rotate` + `events.list/get/getPayload` — by removing their `web: WEB_DEFERRED` exemptions, in lockstep
  with the `parity.test.ts` conformance map). `packages/db` (two new leaf subpath exports — `./reads`,
  `./endpoints` — so apps/web imports the read + endpoint-write fns without tripping the Turbopack
  `export *` barrel bug). `apps/web` (the events list + detail/payload-inspect views, the endpoint
  management UI, the DB-direct server actions, a static CSP, and three new bindings — `R2_PAYLOADS` read,
  `KV_CONFIG` evict, `INGEST_BASE_URL` var). The deploy overlay (`gen-wrangler-prod.mjs`) registers the two
  new placeholders for the web app. **No DB migration** (reads + existing tables; the bindings are infra).
- relates: ADR-0075 (`endpoints.create`) + ADR-0076 (`endpoints.delete`/`rotate` + `makeIngestHashEvictor`,
  the eviction seam this reuses), ADR-0024/0025 (the credential-mgmt UI + best-effort KV eviction pattern
  this mirrors), ADR-0021 (app./auth. on OpenNext — no middleware/nonce, shapes the CSP), ADR-0056 (the
  auth. CSP this mirrors), ADR-0015 (the R2 base64 payload envelope), ADR-0023/0034 (the DAL session gate),
  ADR-0018 (the events cursor/headCursor), the CLI/API/web/MCP parity non-negotiable in AGENTS.md.
- review severity: high — un-defers 8 capabilities onto a browser surface, adds an R2 read binding + a
  `KV_CONFIG` evict binding to the dashboard worker, ships the first CSP on app., and adds session-authed
  mutation server actions. `/code-review` + `/security-review` per slice; founder visual sign-off per slice
  (the AGENTS.md human-UI hard stop).

## context

The wedge's headline parity gap: `app.webhook.co` is settings + credentials only. A user can browse no
events, inspect no payload, and manage no endpoints in the browser — even though `events.*` and
`endpoints.*` are bound on api + cli + mcp. AGENTS.md makes CLI/API/web/MCP parity a non-negotiable, and
every capability carried a `surfaceExempt: { web: WEB_DEFERRED }` marker plus an empty web binding set,
with `parity.test.ts` asserting "web is exempt everywhere" — the gate that has held the dashboard work
behind this epic. `endpoints.create/delete/rotate` (ADR-0075/0076) closed the backend lifecycle, so the
dashboard is now unblocked.

The data model has two truths the UI must respect (both re-verified against the schemas):

- **Events have no delivery status.** `EventSummary`/`Event` (`packages/shared/src/entities.ts`) carry
  `verified` (a signature-verification boolean), `provider`, and a dedup key/strategy — nothing about
  delivered/failed/latency. Delivery status/statusCode/attempt live on `DeliveryAttemptSchema`, produced
  **only by replay**. So the event-list per-row signal is a **verified pill**, never a delivery status.
- **`events.list` is endpoint-scoped.** Its input requires `endpointId`; there is no cross-endpoint "all
  events" feed capability. So events are reachable only *through* an endpoint.

## decision

Build the events surfaces + full endpoint management on app.webhook.co under the established **DAL +
`withTenant` DB-direct** pattern, un-deferring exactly 8 capabilities on web in lockstep with the parity
conformance test. Leave `events.tail` (live tail = the CLI/WS story), `events.replay` (CLI-intrinsic —
`TargetSchema` admits only `localhost-tunnel`; a browser has no tunnel), and `audit.verify` web-deferred.

### data access — DB-direct, not proxy-via-api

apps/web reaches the backend exactly as the credential dashboard already does: a gated server
component/action calls `verifySession()` → opens a per-request `webhook_app` pool over
`HYPERDRIVE_TENANT` → runs Lane B db fns inside `withTenant(app, orgId, …)` (RLS via `app.current_org`).
No HTTP api-client, no bearer, no CORS. The alternative — proxying payload reads + endpoint writes through
apps/api — was rejected: apps/api authenticates **bearer tokens with an `endpoints:write` scope**, but the
web principal is a **session** (userId+orgId cookie) with no scopes, so proxying would require inventing a
new web→api trust contract (a service binding + a session→scoped-principal conversion, with no graceful
fallback) — strictly more net-new attack surface than reusing the in-process db fns, and inconsistent with
every other web data path. The raw db write fns (`createEndpointWithAudit` etc.) enforce no scope (scope is
a bearer/write-handler concern); RLS-org-pinning is the correct and sufficient authz for the session
surface. Authz is **org-membership-wide** (any member of the org can manage its endpoints), matching how
the credential dashboard already works; a per-action owner/admin role gate is a documented future addition,
not v1.

### the two new write/read bindings — accepted blast-radius delta

DB-direct endpoint writes need two bindings beyond the existing set:

- **`KV_CONFIG`** (evict-only) — delete/rotate return the ingest token hash; the dashboard evicts it via
  `makeIngestHashEvictor` over `KV_CONFIG` so rotate's **hard cutover** stops the old URL immediately
  (the `deleted_at` cold-lookup filter + the 300s TTL are the durable stop; eviction makes it instant).
  Best-effort by construction (mirrors the credential-revoke KV_AUTHZ eviction — a failed evict never
  fails the mutation, logs are scrubbed, the hash is never logged).
- **`R2_PAYLOADS`** (read-only usage) — the payload-inspect view reads a captured event's stored bytes
  after an RLS metadata read (`getEvent` → `R2_PAYLOADS.get(payloadR2Key)`), mirroring apps/api's
  `events.getPayload`. There is no db fn for the R2 read; it is a thin web server module.

Blast-radius assessment: apps/web **already** mints API keys (CREDENTIAL_PEPPER), signs the audit chain
(AUDIT_CHAIN_HMAC_KEY), and evicts KV_AUTHZ. Adding an org-scoped R2 read + an ingest-hash evict to an
already credential-issuing worker is a **marginal** delta, and it avoids the larger attack surface of a new
cross-service trust path. Accepted. `INGEST_BASE_URL` is a committed (non-secret) var = `https://wbhk.my`,
validated fail-closed before any mint (`normalizeIngestApex`), exactly as apps/api does.

### the Turbopack bundling discipline

Every db value import is via a **leaf subpath** (`@webhook-co/db/reads`, `/endpoints`); the `@webhook-co/db`
`export *` barrel resolves to `undefined` at runtime under Turbopack/OpenNext (a class the static gate —
vitest + `next build` — cannot catch; only a `next dev`/post-deploy render of the gated route surfaces it).
The zod schemas are imported **type-only** (the db fns return already-parsed objects). Every gated page is
render-smoked in a real `next dev` (or post-deploy curl) before it is claimed to work, and no mutation path
keeps a silent `catch {}` (a scrubbed `console.error` so a bundling-undefined surfaces in CF observability).

### CSP on app.

app. ships its first Content-Security-Policy, a static header set in `next.config.ts` `headers()` mirroring
apps/auth (ADR-0056) **minus Turnstile** — the dashboard loads no third-party origin. OpenNext on Workers
has no per-request nonce, so script/style fall back to `'unsafe-inline'` (Next hydration + theme-init +
Radix); React output-escaping stays the primary XSS defense, framing/base-uri/plugins/form-action/connect
are locked to `'self'`. The existing `next-config-csrf.test.ts` tripwire (which forbids widening
`serverActions.allowedOrigins` — Next's same-origin server-action check is the CSRF defense) is preserved.

### truthful UX

- Endpoint create / rotate reuse the credential dashboard's one-time-reveal dialog (hideCloseButton +
  warn Banner + mono code + CopyButton + Done); copy says the webhook URL is shown only once.
- Rotate is a **hard cut, no grace window** — the confirm says the current URL stops working the moment you
  rotate; update it everywhere first.
- Delete is **soft** — the confirm says the endpoint stops receiving immediately but its past events stay
  inspectable.
- The events-list "status" is a **verified** signal (verified / unverified), never a delivery status; the
  detail view renders the structured `VerificationResult` diagnostic (pass → keyId+scheme; fail → the
  reason code mapped to human copy). The mockup's delivery table + success/latency KPIs are not built —
  they are not backable by today's data model.

## consequences

- The dashboard closes the receive → inspect → manage loop in the browser; CLI/API/web/MCP parity holds for
  the 8 capabilities.
- app. gains a read-only R2 binding + an evict-only KV_CONFIG binding (documented delta above); the deploy
  overlay must carry the two new placeholders (enforced by the generator's leak check).
- **Deferred (roadmap, not built):** a cross-endpoint global event feed (needs a new capability), an event
  verified/status filter (events.list is provider-only), aggregate metrics / an Overview (no aggregates
  capability), `endpoints.pause` (soft-delete is v1's only terminal action), web live-tail (events.tail)
  and web replay (events.replay is CLI-only), and per-action membership-role gating.
- **Tracked hardening follow-ups (from the slice-1 `/code-review`, none blocking):** a scoped read-only
  token for the `R2_PAYLOADS` binding (Workers `r2_buckets` has no read-only mode — the same future
  hardening apps/api already notes); a shared parameterized security-headers builder across apps/web +
  apps/auth (+ apps/www's `_headers`); a repo guard asserting the `INGEST_BASE_URL` apex matches across the
  engine/api/mcp/web configs; and replacing the `@webhook-co/db` `export *` barrel with explicit named
  re-exports (the durable fix for the per-module leaf-export workaround).
