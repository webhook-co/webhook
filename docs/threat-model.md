# threat model & data classification

The shared adversary model for the wedge spine. Every component (engine,
auth, KMS, audit, tunnel, CLI, MCP) binds to this rather than re-deriving its own.
It enumerates the trust boundaries, classifies the data,
and names the control that protects each. Controls trace to the ADRs;
this doc does not restate their detail.

Scope: the inbound wedge — receive on `wbhk.my`, verify, dedup, persist, inspect,
replay-to-localhost — plus the identity/auth and metering foundations. Outbound
delivery is out of scope (deferred).

## trust boundaries

| boundary | what crosses it | primary control(s) |
| --- | --- | --- |
| Public internet → `wbhk.my` ingest (unauthenticated, cookieless) | untrusted webhook requests from anyone who knows a path token | path-token routing with `404` on unknown; CSPRNG token hashed at rest; body-size cap (`413`); rate-limit + per-token token-bucket; `Host`/SNI validation; cookieless apex (no ambient auth) |
| Tenant A's request ↔ tenant B's data (in one shared Postgres) | any read/write on a tenant-owned table | Postgres RLS, deny-by-default, `FORCE ROW LEVEL SECURITY`, a non-owner/no-`BYPASSRLS` app role; per-request `app.current_org` via single-statement `set_config(local)` |
| Hyperdrive query cache (shared edge) | cached read results keyed on SQL+params, blind to the RLS GUC | tenant reads go only through the **cache-disabled** `HYPERDRIVE_TENANT` binding |
| Multi-tenant Worker isolate (one isolate serves many orgs) | plaintext signing/provider secrets held to sign/verify on the hot path | unwrap to a **non-extractable `CryptoKey` handle** (not raw bytes), size-bounded org-scoped LRU; BAA tenants get a tighter/zero cache (ADR-0007) |
| App role ↔ secret material at rest | endpoint signing keys + per-source provider secrets | envelope encryption: ciphertext + wrapped DEK in Postgres, KEK only in AWS KMS behind a `KmsProvider` seam; AAD-bound |
| App role ↔ audit history | attempts to edit/delete/forge audit entries | append-only (INSERT-only grants + reject-`UPDATE`/`DELETE` trigger) + per-org **HMAC-keyed** hash chain (key outside the DB) + periodic WORM head-anchor |
| `mcp.`/`api.` bearer tokens ↔ resources | OAuth access tokens / API keys presented to a resource server | `verifyBearer → AuthContext` seam with **audience binding** (RFC 8707/9728); tokens never cookies; identity data in our own Neon |
| CLI listen tunnel ↔ `wbhk.my` (authenticated WS) | a bearer-authed WebSocket upgrade streaming event summaries to a connected `wbhk listen` client | api-key bearer in the **Authorization header** (cookieless — preserves the apex's CSRF isolation; **never** a `?token=` query that would log-leak), audience-bound to `api.webhook.co` (the `events.tail` capability over a WS transport, requires `events:read`); the bearer-derived `orgId` is forwarded to the per-session DO on trusted `X-Listen-*` headers that overwrite any client-supplied ones — org/endpoint never come from a client frame; the DO does **no outbound I/O** (no SSRF) and reads only its bound org under RLS. A second auth mode on the apex, distinct from unauthenticated path-token ingest (ADR-0014) |
| Replay target | where a captured event is sent | closed `TargetSchema` union (localhost-tunnel only); no free-form URL; remote targets later require an allowlist + SSRF guard |
| Region/jurisdiction boundary | tenant data at rest for residency-bound tenants | EU Neon project + EU-jurisdiction R2 bucket + jurisdiction-namespaced `LISTEN_SESSION` DO (not `locationHint`) |
| Logs / telemetry | anything written to OTel spans / logs | one "loggable view" boundary; mandatory `redactSecret` + header allowlist; PII/PHI and secrets never logged |

## data classification

| data class | sensitivity | store | protecting controls | retention |
| --- | --- | --- | --- | --- |
| Event bodies (`payload`) | tenant-private, may contain PII/PHI | R2 (per-event key `hash(endpoint_id, dedup_key)`) | RLS-gated metadata + encryption at rest + per-event prune; never logged | tier window |
| Event headers (`events.headers`) | tenant-private, includes signatures | Postgres (ordered JSONB, **unscrubbed**) | RLS + encryption + retention — **not** redaction (redaction would defeat inspection) | tier window |
| Per-endpoint signing secrets | high — our outbound trust | Postgres (envelope-encrypted) | KMS-wrapped DEK, AAD-bound, `CryptoKey` handle on hot path, rotation | until revoked |
| Per-source provider secrets | high — third party's secret | Postgres (envelope-encrypted, separate table) | same envelope + cache model as signing keys; distinct table (opposite trust direction) | until removed |
| `ingest_token` | bearer capability to write events | Postgres stores **only a keyed `HMAC-SHA256` hash** (peppered; shared credential primitive) | random CSPRNG, peppered-hash at rest, constant-time lookup, KV keyed by hash; shown once | endpoint lifetime |
| `api_key` | bearer capability to call the API as an org | Postgres `api_keys`, stores **only a keyed `HMAC-SHA256` hash** (`key_hash`, peppered — pepper held outside the DB) | RLS + FORCE; random ≥256-bit CSPRNG, peppered-hash at rest, constant-time compare, shown once; write path is `webhook_app`, verify path is the column-scoped, SELECT-only `webhook_authn` (ADR-0008 Option B) | until revoked/expired |
| Identity / PII (users) | personal data (GDPR) | Postgres (Better Auth schema) | RLS where org-scoped; erasable; audit refers to it only by pseudonymous `user_id` | until erasure |
| Audit log | integrity-critical, low-PII | Postgres (append-only, hash-chained) | immutability + HMAC chain + WORM anchor; actor = `user_id`, never raw PII | long (compliance) |
| Usage/metering counters | billing-relevant | Postgres (`usage`, derived from `events`) | exactly-once via the dedup unique constraint; no hidden counters | billing windows |
| Session cookies | auth, `app.` only | host-only cookie on `app.` | host-only (no parent-domain), CSRF posture; no `cookieCache`+KV in the wedge | session |

## key adversary scenarios

- **Cross-tenant read.** Defeated by RLS (deny-by-default + `FORCE` + non-owner role) *and* the cache-disabled tenant binding (RLS alone is insufficient because the Hyperdrive cache can't see the RLS GUC). Red-first leak tests, incl. an owner/`SECURITY DEFINER` negative control, gate the change.
- **Leaked/abused ingest token.** Token is hashed at rest (a DB/backup/cache leak yields no usable token); abuse is bounded by rate-limit + the soft-cap pause.
- **Audit tampering / truncation.** Append-only + HMAC-keyed per-org chain + WORM head-anchor make edits, forgeries, and tail-truncation detectable.
- **Secret disclosure from a shared isolate.** Hot path holds only non-extractable `CryptoKey` handles, size-bounded and org-scoped; BAA tenants zero-cache.
- **SSRF / confused-deputy via replay (esp. MCP agent).** Replay target is a closed union today; remote targets are a future, separately-scoped kind behind an SSRF guard.
- **Tunnel row-skip (silent data loss on the hero feature).** The bounded safety-lag watermark (server-assigned `received_at`, `δ ≥ statement_timeout`, primary reads) makes the durable tail provably gapless. The cutoff is computed **Postgres-side** (`now() − δ`) so no Worker↔Postgres clock skew erodes δ; delivery is **poll-only** (no best-effort push, no active-session registry) so liveness is deterministic and there is no registry to poison or leak across tenants; the poll alarm is **fail-safe** (a poll error emits a recoverable `POLL_DEGRADED` notice and re-arms — it never throws, which would silence the tail). The durable resume cursor advances only on client `ack`, so an un-acked event re-delivers on reconnect (at-least-once; consumers dedup by `dedup_key`). See ADR-0014.

## residuals (documented, not solved here)

- **Ingress is not jurisdiction-constrained** without Cloudflare Regional Services — a request can enter via any PoP even when data-at-rest is region-pinned.
- **DO ids may be logged out-of-jurisdiction** by the platform.
- **Replay is at-least-once** — duplicates are possible; consumers dedup via `dedup_key`.
- **Plaintext key material exists transiently in a shared isolate's memory** (as `CryptoKey` handles); accepted and documented for SOC 2 / HIPAA, with BAA tenants opted out of caching.
- **A leaked `webhook_authn` credential enumerates api-key metadata across tenants** — the bearer-verify role holds a `FOR SELECT USING(true)` policy on `api_keys` (verification is org-discovery-by-hash, so it can't be tenant-scoped before the lookup), and a column-level grant on `(key_hash, org_id, scopes, expires_at, revoked_at)` only. So a leaked authn credential can read those columns for every org, but it **cannot forge or use a key** and **cannot write** (no INSERT/UPDATE/DELETE grant), and it never sees the display metadata (`name`/`prefix`/`start`/timestamps). The exfiltrated `key_hash` values are also **inert against an offline match**: `key_hash` is a **peppered `HMAC-SHA256`** of a ≥256-bit CSPRNG secret, and the pepper lives **outside the database** (a wrangler/Worker secret, ADR-0008 hashing posture), so an attacker holding the stolen hashes cannot confirm or match even a *known* plaintext without also stealing the pepper — a database-only breach yields nothing usable. Accepted and documented per ADR-0008 (Option B). The **same role + pattern now also resolves ingest tokens**: migration `0011` gives `webhook_authn` a role-targeted `FOR SELECT TO webhook_authn USING(true)` policy + a column grant on `endpoints (id, org_id, ingest_token_hash, paused)` (org-discovery-by-hash for the `wbhk.my` path token, which likewise can't be tenant-scoped before the lookup). The residual is identical and equally inert — `ingest_token_hash` is the same peppered `HMAC-SHA256` (pepper outside the DB), and the role still cannot forge a token or write (no INSERT/UPDATE/DELETE grant).
- **`.my` ccTLD** registry/policy tail-risk on `wbhk.my` — open diligence on the registry's policy and renewal terms.
