# ADR 0019 — Credential mint model: conditional audience stamp + the first-party api_keys invariant

- status: accepted (A0b — the resolve-side seam); **A0c extends this ADR** with the `mintScopedKey`/`mintKeyForGrant` primitives, grant lifecycle + cascade revoke, and the `aae1` audit helper.
- date: 2026-06-19
- scope: `packages/db` — `credential-resolver.ts` (the conditional stamp), `api-keys.ts` (the `webhook_authn` cold lookup reading `api_keys.audience`), `auth-deps.ts` (the single-sourced factory). The mint primitives land in A0c.
- relates: ADR-0010 (auth foundation, **r5/r6/r7**), ADR-0020 (credential & governance schema — the `audience` column), ADR-0008 (api-key RLS posture), ADR-0002 (Hyperdrive cache disabled for the cold path).
- review severity: high (audience/authz seam on the credential surface)

## context

ADR-0010 (r5/r6) settles "OAuth login **mints a scoped `whk_` key**" — so the *issuance* side is the
new work, but *validation* is the existing `verifyBearer → credential-resolver → makeApiKeyColdLookup`
seam shared by api., the engine `/listen` tunnel, and mcp. Two facts about that seam force this ADR's
decisions:

1. **One shared cache, keyed by the bare credential hash.** `KV_AUTHZ` is a single namespace across all
   three surfaces; the cache key is the bare hash (no surface in it), so **one entry serves every
   surface** and a single `invalidateHash` revokes everywhere (revoke-complete). The audience the
   resolver attaches is the security-critical confinement field: `verifyBearer` rejects a request whose
   principal `audience !==` the surface's own RFC 8707 resource (a strict scalar `!==`).
2. **Before A0b the stamp was UNCONDITIONAL** — the resolver overwrote every resolved principal's
   audience with the *presenting surface's* resource. That kept the shared entry audience-agnostic (each
   surface re-stamped its own) but made it impossible to **confine a per-key audience**: an OAuth-minted
   key bound to mcp would be silently widened to api when presented at api.

A0a (ADR-0020) added the nullable `api_keys.audience` column. A0b makes the resolve seam *honor* it.

## decision

1. **Conditional audience stamp.** The resolver stamps the presenting surface's `resource` onto a
   resolved principal **only when the principal carries no intrinsic audience** (a legacy/org-wide key)
   *and* the surface is audience-bound (`resource` set). A principal that resolved **with** its own
   intrinsic audience (a per-key OAuth-minted key, read from `api_keys.audience`) is left intact — never
   widened to the presenting surface. The stamp is applied identically on **both** the cache-hit and the
   cold path; the cache stores the **raw** (pre-stamp) cold result, so a legacy key serializes
   audience-less (each surface stamps its own) while a per-key key carries its audience through the
   shared entry. Net: the shared cache stays audience-agnostic for legacy keys (the cross-surface 401
   guard holds) **and** per-key keys stay confined to their bound surface.
2. **`makeApiKeyColdLookup` reads `api_keys.audience`** and returns `row.audience || undefined`. The
   `|| undefined` (not `?? undefined`) coalesces an empty string to "no binding" as well — otherwise a
   stored `""` would survive the resolver's `audience !== undefined` guard, skip the stamp, and then be
   rejected by `assertAudience`'s strict `!==` on *every* surface, silently bricking the key
   (fail-closed). The cold-path column grant to `webhook_authn` extends to `audience` only (ADR-0020) —
   the cold path never learns a key's grant topology.
3. **The first-party `api_keys` invariant (ADR-0010 r7), restated as the spine of the mint model:**
   *every* key-creation path — `createApiKey` (standalone) today and `mintScopedKey`/`mintKeyForGrant`
   (grant-backed, A0c) — writes the **first-party `api_keys` table** that this resolver reads. The
   Better-Auth `apikey` plugin table is **generator-config-only**; it is never read or written at
   runtime. A key written anywhere else would be invisible to the resolver and unrevocable.

## rejected alternatives

- **Per-surface cache keys** (`hash + resource`) — would confine audiences by construction, but
  multiplies cache entries per key and **breaks single-invalidate revocation completeness** (revoke
  would have to enumerate every surface). The conditional stamp keeps one entry per key.
- **Keep the unconditional stamp** — cannot confine a per-key OAuth-minted audience; defeats the whole
  point of the `audience` column.
- **`row.audience ?? undefined`** (null/undefined-only coalesce) — leaves an empty-string audience
  surviving as `""`, which fails closed on every surface (a silent per-key brick). `|| undefined` folds
  the empty string into the legacy path.
- **A DB write-once trigger on `audience`** in v1 — deferred. v1 has **no audience-mutation surface**
  (`createApiKey` never sets it; A0c sets it at INSERT, not UPDATE), and mutation is already
  RLS-confined to the owning org (`webhook_app` is `nobypassrls`, policy gated on `current_org_id()`),
  so the blast radius is within-org only. See the consequence below.

## consequences

- **Per-key keys are confined; legacy keys remain org-wide.** A pre-0014 key (no stored audience) still
  validates across the org's surfaces via the shared entry; an OAuth-minted per-key key is rejected off
  its bound surface. Back-compat preserved.
- **Audience is treated as immutable post-mint.** If A0c (or a future admin tool) ever **narrows** a
  key's audience after mint, it MUST invalidate the credential cache (as revoke does) — otherwise the
  prior audience keeps resolving from the shared entry until the 300s TTL backstop lapses. This is a
  within-org staleness window, not a cross-tenant escalation (RLS + `assertAudience`'s strict equality
  bound it). **Flagged for A0c.**
- **A0c extends this ADR** with the `mintScopedKey`/`mintKeyForGrant` contract (login mints a new
  grant + key; refresh re-mints under the existing grant — expire-naturally, ADR-0020 Q3), the cascade
  revoke + KV invalidation, and the `aae1` `appendAuthAuditEntry` helper.
- **Single-sourced wiring (P1).** api./engine/mcp build their identical resolver+verifyBearer triple
  through `makeApiKeyAuthDeps({hasher, authn, cache, resource})`; `resource` drives only the conditional
  stamp. No surface can drift from the others.
- **Tested** (pure-logic, no DB, `packages/db/test/credential-resolver.test.ts` + the real-DB
  `packages/db/test/api-keys-lifecycle.test.ts`): a legacy key is stamped per surface and resolves at
  api *and* mcp via the shared bare-hash entry; a per-key audience is honored and **not** widened, and
  stays confined through a cross-surface cache hit; a single `invalidate` clears the one entry
  everywhere; an empty-string stored audience coalesces to the legacy path (no brick); the ingest path
  (no `resource`) leaves the audience untouched.

## A0c update — the mint primitives (the issuance half)

A0c builds the issuance functions over this seam (`packages/db/src/grants.ts` + the `aae1`
`auth-audit.ts` and the `auto-approve.ts` evaluator):

- **`mintScopedKey`** (login) — atomic grant + key + audit in ONE tx. Approval model on
  `org_policy.require_device_approval` (default **OFF** → mint active immediately). When **ON**:
  `evaluateAutoApprove(auto_approve_rules, ctx)` — a match mints an auto-approved active grant + key;
  no match creates a **pending_approval** grant with **NO key** (a later `approveGrant` mints). An
  auto-approval is recorded as a **system** decision (`approved_by` null, `grant_approved` audit
  `actor` null + `metadata.auto=true`); a human `approveGrant` records the approver + `auto=false`.
- **`mintKeyForGrant`** (refresh, `grant_type=refresh_token`) — re-mints a fresh key on the EXISTING
  active grant (throws if not active); the prior key is **not** revoked (expire-naturally, ADR-0020
  Q3); stamps the grant's `last_used_at`. **Contract:** the caller (Lane C) must pass `scopes`/
  `audience` that are a subset of the grant's original consent — v1 does not persist a grant's scope
  set, so this layer cannot verify the subset (documented; a widening refresh would escalate).
- **`createPendingGrant`** / **`approveGrant`** — the device-code start / completion.
- **Defensive guards:** `ttlSeconds > 0` (never mint a pre-expired key); `evaluateAutoApprove` is
  fail-closed (malformed/absent rules → pending).
- **Composite FK (migration 0015):** `api_keys (grant_id, org_id) → auth_grant (id, org_id)` replaces
  0014's single-column FK, so the DB enforces a key's grant is in the SAME org — the cross-tenant
  binding the exported `insertApiKey` primitive could otherwise allow is now structurally impossible
  (defense in depth; `auth_grant.unique(id, org_id)` exists for this). NULL `grant_id` (standalone
  keys) is unaffected.
- **Deferred to A0c-4:** `revokeGrant` (cascade + KV-invalidation hashes), `revokeApiKey`, and the
  read helpers (`listGrants` / `listApiKeysForGrant`).
