# ADR 0011 — read-capabilities surface: one shared handler, two transports (API + MCP)

- status: accepted
- date: 2026-06-15
- scope: `packages/db` (read handlers), `apps/api`, `apps/mcp`, `packages/contract` (parity), `packages/shared`
- review severity: high

## context

Slice 8 builds the bearer-auth read surface the CLI read commands (slice 10), the tunnel (11), and
replay (12) all consume: the five read capabilities — `endpoints.list/get`, `events.list/get`,
`audit.verify` — exposed over both REST (`apps/api`, `api.webhook.co`) and MCP (`apps/mcp`,
`mcp.webhook.co`). The constitution makes CLI/API/web/MCP parity a non-negotiable, so a capability
added to one surface must reach the others. The risk this ADR addresses is **drift**: two
hand-written copies of "list an org's endpoints under RLS, paginate, map errors" inevitably diverge
in subtle, security-relevant ways. Relates to the bearer-auth model (API key for CLI/API, OAuth
for MCP/agents; the `verifyBearer → AuthContext` seam), ADR-0004 (audit chain — `audit.verify`),
ADR-0005 (closed replay target — `events.replay`, deferred here), ADR-0002 (Hyperdrive caching off
for tenant reads), and `docs/threat-model.md` (RLS tenant isolation, loggable-view redaction).

## decision

1. **One shared handler layer, two transports.** The read logic lives once, in
   `packages/db/createReadHandlers(deps)` — a `capabilityName → (AuthContext, input) => output` map
   that enforces the capability scope, validates input against the contract Zod schema, runs the
   tenant read under RLS (`withTenant`), and returns the contract-shaped output, throwing a typed
   `CapabilityFault(code)` on `NOT_FOUND`/`VALIDATION_ERROR`/`FORBIDDEN`. `apps/api` wraps each entry
   in HTTP; `apps/mcp` wraps each in an MCP tool. The two surfaces bind the **same map**, so they
   cannot diverge, and the read logic is tested once against real Postgres + RLS in the db pool.

2. **`apps/mcp` is a Cloudflare McpAgent (Durable Object).** The protected `/mcp` route is served by
   `WebhookMcp extends McpAgent`, registered as the OAuthProvider's `apiHandler` via
   `WebhookMcp.serve("/mcp")`. Chosen over a hand-rolled stateless MCP server because it is the
   Cloudflare-native path (the streamable-HTTP transport, session lifecycle, and the upgrade path to
   server→client streaming that `events.tail` will need in slice 11 all come for free) and because
   the OAuth grant arrives on `this.props` automatically. The `agents` package declares `react`/`ai`
   as peers, but those are for its chat/react entrypoints — `agents/mcp` pulls neither into the
   Worker bundle (verified); the only added bundle deps are `partyserver` (the DO framework) and the
   MCP SDK. The DO requires `nodejs_compat` (the shared db reads run inside it) plus a
   `new_sqlite_classes` migration.

3. **API keys reach MCP via `resolveExternalToken`, not a second token type.** OAuth-access-token
   validation stays MCP-only (the OAuth library's tokens are opaque + KV-bound to the issuing
   Worker). The OAuthProvider calls `resolveExternalToken` for any bearer it did not mint — today
   every caller, since the `/authorize` login that mints provider tokens is deferred — and we resolve
   it as an API key through the **same `verifyBearer` seam `apps/api` uses** (audience =
   `MCP_RESOURCE`), handing back the principal as grant props + the bound audience (the provider
   re-checks it). So one credential model serves both surfaces; the MCP tools never see a raw token.

4. **The capability error taxonomy maps once per transport.** `CapabilityFault.code` (the closed
   `CAPABILITY_ERRORS` set) maps to HTTP status in `apps/api/http-status.ts` (total over the set) and
   to an `isError` MCP tool result carrying the code in `apps/mcp/tools.ts`. Operational faults (a
   DB/Hyperdrive outage, a wiring bug) are **never** masqueraded as a capability error: they
   propagate to a generic 5xx (API) or a generic protocol error (MCP), with internals logged, never
   echoed. Auth precedes every read; the `orgId` comes only from the verified `AuthContext` under RLS.

5. **Parity is a gate, not a hope (`surfaceExempt`).** Each capability declares the GA surfaces it is
   deliberately *not* bound on, with a dated reason: `web` on every capability (the dashboard epic is
   deferred), and `api`+`mcp` on `events.tail`/`events.replay` (slices 11/12). A conformance test
   asserts that the live bindings (cli: 7 commands; api: 5; mcp: 5; web: 0) satisfy
   `assertCapabilityParity` *with* those exemptions, and that the exemptions are tight (un-exempting a
   bound surface fails). `apps/mcp` derives its bound tools from the contract
   (`requiredSurfaces(cap).includes("mcp")`), so lifting an exemption forces a tool + handler or the
   build goes red.

6. **The KV credential-cache adapter is shared, not copied a third time.** `kvCredentialCache`
   (KVNamespace → the resolver's hot cache) moves to `@webhook-co/shared/kv-cache`, consumed by
   `apps/engine`, `apps/api`, and `apps/mcp`. It lives on a dedicated subpath the package barrel does
   not re-export, so the Node-only `@webhook-co/db` (which must never import Workers types, and
   resolves shared via its built declarations) never sees `KVNamespace` — the node↔workers boundary
   stays intact.

## consequences

- A read capability is implemented and security-reviewed once; API and MCP are thin transport
  adapters over it, and the CLI (slice 10) binds the same contract. New read capabilities get parity
  by construction.
- `events.tail`/`events.replay` land on api+mcp in slices 11/12 by adding handlers + tools and
  removing the two exemptions (the conformance test + the bound-capabilities test fail until both are
  done). The frontend epic removes the `web` exemptions the same way.
- The MCP wiring (dispatch, fault mapping, the api-key bridge, the grant trust boundary) is
  node-tested; the full `initialize → tools/list` handshake is exercised end-to-end in workerd
  (KV-seeded auth, no Postgres); the read logic + RLS + pagination + cursor + audit-chain verification
  are tested in the db pool against real Postgres. The tenant read inside the DO is not re-tested at
  the MCP layer — it is the same shared handler.
- Two short-lived DB clients per authenticated MCP call (the authn cold-lookup on the Worker via
  `resolveExternalToken`, the RLS tenant read inside the DO), each torn down in a `finally` — the same
  per-request lifecycle as `apps/api` and `apps/engine`. Caching stays off on both Hyperdrive bindings.
- Adopting `agents`/`@modelcontextprotocol/sdk` adds a sizeable dev dependency tree; only
  `agents/mcp` + `partyserver` + the MCP SDK reach the Worker bundle. `nodejs_compat` + the DO
  migration are now part of the mcp deploy config.

## security note — MCP session binding (known, deferred-hardening)

The McpAgent Durable Object is keyed by the `Mcp-Session-Id`, and `this.props` (the grant the tools
authorize against) is set **once**, from the request that *initializes* the session — McpAgent
`onStart` runs only on the first request per DO wake; warm requests don't refresh it. So a session is
**bound to its initializing principal**, and the session id is a *bearer-equivalent secret*: the
platform mints it unguessably (`newUniqueId()`) and returns it only to that caller over TLS. A second
authenticated principal could read the initializer's org **only** by obtaining that secret session id
(theft / a buggy client that shares it across tenants) — the streamable-HTTP handler routes purely by
session id and surfaces no per-request principal to the tool handler, so we do not additionally
re-bind the principal per call. The MCP-layer auth code is otherwise correct: `orgId` is taken only
from the validated grant, every read is RLS-scoped and scope-gated, and faults never leak internals.

This is acceptable for this slice because callers are org-scoped API keys that each open their own
session; cross-principal session reuse becomes reachable only once the **deferred** OAuth user-login
(`/authorize`) mints multi-user tokens. The follow-up when that lands: principal-namespaced session
routing (route to `streamable-http:${orgId}:${sessionId}` so a session id is only valid within its
org) or a per-request principal re-check. Tracked; do not enable multi-user OAuth login without it.
