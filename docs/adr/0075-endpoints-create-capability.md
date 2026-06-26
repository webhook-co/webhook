# ADR 0075 — `endpoints.create` capability + the `endpoints:write` scope

> **Superseded (partial), 2026-06-26.** The *one-time, unrecoverable reveal* of the ingest URL described
> here is superseded by a decision to make the ingest URL **always-shown** — retrievable on demand and
> stored **envelope-encrypted at rest** (not hash-only). The create flow keeps minting the URL; only the
> "shown exactly once" property changes. This ADR will be revised when that change ships (tracked in the
> internal backlog). API keys are unaffected — they remain one-time-reveal.

- status: accepted.
- date: 2026-06-25
- scope: server + cli. `packages/contract` (new `endpoints.create` capability, `CreatedEndpointSchema`,
  `endpoints:write` added to the closed `CAPABILITY_SCOPES` tuple); `packages/db` (`createEndpointWithAudit`
  + `createWriteHandlers`; the shared handler type renamed `ReadHandlers`→`CapabilityHandlers`);
  `apps/api` (`POST /v1/endpoints` + a committed `INGEST_BASE_URL` var); `apps/mcp` (the auto-registered
  `endpoints.create` tool mints inside the McpAgent DO; `INGEST_BASE_URL` var); `packages/cli`
  (`wbhk endpoints create`). No schema change, no migration.
- relates: ADR-0003 (256-bit credential floor), ADR-0004 (`wha1`/`audit_log` tamper-evident chain),
  ADR-0008 (hash-at-rest, plaintext-shown-once), ADR-0014 (first-credential bootstrap — the headless
  `createEndpoint` this exposes), ADR-0019 (mint model). Numbered **0075** (not the brief's 0074): the
  concurrent `whk_` lane's merged ADR-0073 earmarks 0074 for its secret-scanning auto-revoke webhook, so
  0075 is the next conflict-free number.
- review severity: high — this adds a new active scope + a write/mutation route (an authz surface).
  `/code-review` + `/security-review`.

## context

Endpoint creation (and its `wbhk.my/<token>` ingest URL) existed only as the headless `createEndpoint`
db primitive used by the operator bootstrap (ADR-0014) — there was **no programmatic `endpoints.create`**
on any bearer surface. This was the one real self-serve product gap: it blocks the dashboard endpoint UI
(lane S1) and a complete OpenAPI for SDKs (S7). The contract carried only read + replay capabilities;
the scope vocabulary was a closed four-scope tuple with `keys:manage` reserved name-only.

## decision

A new capability `endpoints.create` (input `{ name }`, output the endpoint + a one-time `ingestUrl`),
gated by a new **active** scope `endpoints:write`, bound on **api + cli + mcp** at parity (web deferred
as a *binding*, but see consequences). The capability is added to `CAPABILITIES`; everything else
derives from that single source of truth.

1. **Scope `endpoints:write`** — added to the closed `CAPABILITY_SCOPES` tuple (the `CapabilityScope`
   type source). Read/write symmetry with `endpoints:read`; it will absorb future endpoint
   update/pause/delete. `keys:manage` stays reserved (governance-flavoured); `:write` is the
   data-mutation verb. The OAuth issuer's advertised + grantable scope set DERIVES from the contract
   registry, so the new scope flows into discovery, consent, and every mint path with no second edit.

2. **Authorization: scope-only.** Any bearer carrying `endpoints:write` may create in its own org; RLS
   pins the org. No membership/role lookup — consistent with `events:replay` (a mutation gated purely
   by scope) and with the invariant that `userId` is not on the bearer path (api-key principals carry
   none). The privilege decision is made at grant/consent time. On mcp there is **no edge scope gate**
   (unlike the api edge's `authorizeBearer`), so the write handler's `ensureScope` is the SOLE authz
   gate there and runs FIRST — before any mint or insert.

3. **Audit: `wha1`/`audit_log`, in the same transaction.** `createEndpointWithAudit` mints, inserts the
   endpoint, and appends one `audit_log` row (`action="endpoint.created"`, `target=<id>`,
   `actor=userId ?? null`) in ONE `withTenant` tx — they commit or roll back together. This is the
   control-plane chain `audit.verify` already reads and that migration 0005 names "endpoint created" as
   its canonical example; `endpoints.create` becomes its first live writer, closing the tracked
   "interactive org/endpoint mutation audit" deferral. (`aae1`/`auth_audit_event` was rejected: it is
   the auth chain and would need a CHECK-enum migration.)

4. **Not idempotent; one-time, unrecoverable reveal.** Each call mints a new endpoint + token; the
   response carries `ingestUrl` (which embeds the secret token) exactly once. The endpoints table stores
   only the token hash and has no token column, so the URL is unrecoverable after creation — rotation is
   creating a new endpoint. The CLI api-client sends the POST with `idempotent: false`, and it only
   blind-retries idempotent requests, so a transient failure can never duplicate an endpoint (the
   one-time-reveal model is incompatible with idempotent retry returning the same secret). The CLI
   reveals the record on stdout and the "save it now" caveat on stderr.

5. **Per-org endpoint soft cap → `RATE_LIMITED`.** `createEndpointWithAudit` takes a per-org
   transaction-scoped advisory lock, then checks a per-org count (default **100**, tunable) inside the
   tx and throws `RATE_LIMITED` past it — the first producer of that declared error. The lock makes the
   cap EXACT under concurrency (not a best-effort cap+N). An abuse backstop (especially for an autonomous
   mcp agent minting permanent, secret-bearing public URLs), since there is no `endpoints.delete`/rotate yet.

6. **`INGEST_BASE_URL` is a committed wrangler `var`, validated fail-closed in the shared seam.** The
   prod-overlay generator carries ids/secrets/routes but NO `vars` and only prepends, so the value
   (`https://wbhk.my`) is committed in `apps/api` + `apps/mcp` `wrangler.jsonc` and survives to prod. The
   shared write handler (`normalizeIngestApex`) validates it — absolute http(s), no path/query/fragment —
   **lazily at create time, before the mint**, so a missing/garbage value 500s ONLY the create path
   (never minting `undefined/<token>` or `host/x?q=/<token>`, never committing an orphan, and never
   breaking reads). Both surfaces inherit the guard from the one seam rather than re-implementing it.

7. **One capability-handler map, single-sourced.** The write handler shares the read handler's
   signature, so `createWriteHandlers` returns the same `CapabilityHandlers` map type. `buildCapabilityHandlers`
   (in `packages/db`) merges read + write into one map; both api and mcp call it and dispatch by name —
   the surfaces can't drift. (`ReadHandler(s)` was renamed `CapabilityHandler(s)` now that the map holds a
   write handler; `events.replay`'s separate-field model was not reused because mcp must bind the same handler.)

### alternatives considered

- **`endpoints:manage` scope.** Rejected: `:write` pairs with `:read`; `:manage` is reserved for
  governance (mirrors `keys:manage`).
- **Owner/admin-gated authz.** Rejected: api-key principals carry no `userId`, so a membership check
  would break the bearer model and contradict the userId-off-the-bearer-path invariant.
- **`aae1` audit chain.** Rejected: auth-event semantics + a required enum migration.
- **An idempotency key.** Rejected: incompatible with one-time reveal (a retry can't re-reveal the
  secret); the non-idempotent POST + client no-retry already prevents duplicates.
- **MCP as a fast-follow.** Considered (minting inside a Durable Object is a new runtime path); the
  founder chose MCP-now after a workerd de-risk spike proved `randomBytes` mint works in the DO isolate.

## consequences

- Existing read-only keys (e.g. the founder key) get **403** on create — fail-closed; a new
  `endpoints:write` grant/key is required to create.
- Because the live `app.webhook.co` create-key form and the `wbhk login` consent screen render the
  derived scope set, `endpoints:write` now appears as a selectable scope on both (a key carrying it can
  then create via api/cli/mcp; the dashboard still has no create-endpoint button — that is S1). The
  founder accepted this and waived the human-UI eyeball for the new scope chip.
- An mcp agent can mint a permanent, secret-bearing public ingest URL (returned in tool output). This is
  the deliberate cost of MCP parity; the soft cap is the abuse backstop.
- `audit.verify` now returns real rows for any org that has created an endpoint.
- No `endpoints.delete`/rotate yet: a lost ingest URL means creating a new endpoint; the soft cap is the
  only bound on mint volume. Both are tracked follow-ups.
- Non-idempotent + one-time reveal means a response dropped AFTER the server commit (network blip) leaves
  an orphaned endpoint whose URL is unrecoverable and which counts against the soft cap until
  `endpoints.delete` exists. This is inherent to the reveal model (an idempotent retry could not re-reveal
  the secret); the client never blind-retries the POST, so it cannot itself cause a duplicate.
- This unblocks the dashboard endpoint UI (S1) and a complete OpenAPI/SDK surface (S7).
