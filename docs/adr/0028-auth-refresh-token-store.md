# ADR 0028 — OAuth refresh-token store: an org-embedded opaque handle with atomic single-use

- status: accepted (A2b-2a — the `auth_refresh_token` table + the mint/consume+rotate/revoke helpers in `packages/db`). The token-core seam wiring + the `/token` route that call these are A2b-2b/A2b-3.
- date: 2026-06-20
- scope: `packages/db` — migration `0017_auth_refresh_token.sql` + `packages/db/src/refresh-token.ts` (+ tests; `rls.test.ts` registers the new tenant table).
- relates: ADR-0024 (Option-B token issuance — this is the "refresh-token store" its consequences flag; `redeemRefresh`'s `consumeRefresh` seam is backed here), ADR-0020 (governance schema — `auth_grant`, the composite-FK pattern from migration 0015), ADR-0008/0009 (api-key RLS posture + the `webhook_authn` cross-org read pattern), ADR-0010 (audit-anchor — migration 0010, the FORCE-RLS / SECURITY-DEFINER constraint cited below), `internal/build-plans/lane-c-auth-identity-backend.md` §2.
- review severity: high (a long-lived credential store on the token-issuance surface; tenant isolation + single-use)

## context

ADR-0024 settles Option-B token issuance: the frozen `/token` mints a 24h first-party `whk_` key and
returns it with a **first-party, opaque ~90d refresh handle** — Lane C's own, hashed, bound to the grant,
**not** the provider's refresh. Its consequences list "consumeRefresh must be a genuinely atomic SQL
`UPDATE … RETURNING`" as an A2b follow-up. This ADR is that store.

The hard constraint shaping the design: the `/token` refresh request carries **only the opaque handle** —
no org context. But `auth_grant` / `api_keys` are `FORCE ROW LEVEL SECURITY`, org-scoped by
`current_org_id()`. So consuming a handle (an issuer **mutation**) needs to resolve its tenant *before* it
can run under RLS. The codebase already solves the read version of this (`webhook_authn` resolves an
api-key's org by hash cross-org via a role-targeted `using(true)` SELECT policy — ADR-0009), and migration
0010 documents the only two cross-org mechanisms available: a role-targeted permissive policy, or a
BYPASSRLS role — and explicitly notes that an **owner-owned SECURITY DEFINER function does NOT bypass FORCE
RLS here** (the owner is policed under FORCE). KV was also on the table (the plan said "KV or DB table").

## decision

**1. The handle embeds its org: `rtk_<orgId>_<secret>`.** The orgId is a tenant-**routing** hint, not a
secret (the holder already owns the org); the entropy is a 256-bit `secret`. Consume parses the org from
the handle → `withTenant(orgId)` → every read/write is plain **`webhook_app` under normal RLS**. No
cross-org role, no BYPASSRLS, no SECURITY DEFINER. The stored `token_hash` is HMAC-SHA256+pepper over the
**whole** plaintext (reusing `createCredentialHasher`, like api_keys), so the embedded org is **tamper-
covered**: swapping the org segment changes the hash and matches nothing.

**2. Single-use is one atomic statement.** Consume is a single
`UPDATE auth_refresh_token rt SET used_at = now() FROM auth_grant g WHERE rt.token_hash = $candidate AND
rt.grant_id = g.id AND rt.org_id = g.org_id AND rt.used_at IS NULL AND rt.revoked_at IS NULL AND
rt.expires_at > now() AND g.status = 'active' AND (g.expires_at IS NULL OR g.expires_at > now())
RETURNING …`, then the rotation insert + `replaced_by` link, all in one `withTenant` transaction. Under
READ COMMITTED a concurrent replay loses the row lock, re-evaluates `used_at IS NULL` against the committed
row, and matches nothing — exactly one consume wins (tested with `Promise.all` on two connections).

**3. The grant is the lifetime ceiling.** The consume join gates on **both** `g.status = 'active'` and
`g.expires_at` — a revoked grant can't refresh, and a refresh can never outlive the grant lifetime the
consent screen advertises, even though nothing flips `status` to `'expired'` (no sweep exists yet). This is
the complete kill-switch: the consume `UPDATE … FROM auth_grant` is the *only* path that spends a handle.

**4. Pepper-rotation tolerant.** Consume iterates `hasher.candidates()` (current + previous peppers) so
outstanding ~90d handles survive a pepper rotation — mirroring the api-key verify path. It loops rather
than `= any($buffers)` because postgres.js doesn't bind a `Buffer[]` as `bytea[]`; a handle is stored under
exactly one pepper, so at most one candidate matches and the loop stays atomic single-use.

**5. RLS posture symmetric with api_keys.** `enable + force row level security`, all four policies
(`org_id = current_org_id()`), full CRUD to `webhook_app`. Composite FK `(grant_id, org_id) →
auth_grant(id, org_id) ON DELETE CASCADE` (the 0015 pattern). Registered in `TENANT_TABLES` so the
catalog-driven leak suite exercises its cross-org isolation.

## rejected alternatives

- **A cross-org WRITE role** (a role-targeted `for update … using(true)` policy, the mutation analogue of
  `webhook_authn`/`webhook_anchor`) — would give the issuer cross-org write reach over every tenant's
  refresh handles. Acceptable for a read-only verify path; too broad a blast radius for a mutation.
  Embedding the org avoids needing it at all.
- **A SECURITY DEFINER consume function** — does NOT bypass `FORCE` RLS here (owner is policed; migration
  0010 documents this), so it would see zero rows. A non-starter.
- **A KV store** (the plan's other option) — eventually-consistent, no atomic compare-and-swap, so true
  single-use under concurrent replay isn't guaranteed. The DB `UPDATE … WHERE used_at IS NULL` is.
- **Hashing only the secret (org outside the hash)** — would let the org segment be swapped without
  changing the hash. Hashing the whole plaintext makes the routing hint tamper-evident.

## consequences

- **A2b-2b threads `orgId` + `audience` into the `issueRefreshToken` seam.** ADR-0024 froze that seam as
  `issueRefreshToken(grantId)`, but the store needs the org (to embed + INSERT under RLS) and the audience
  (to denormalize onto the row so `consumeRefresh` returns it). Implementation revealed the seam must carry
  them — a small token-core change in A2b-2b. The C↔D `FrozenTokenBody` (the real external contract) is
  untouched.
- **Deferred to their consumer slices, tracked:** (a) eager handle revocation on grant-revoke —
  `revokeRefreshTokensForGrant` is shipped + tested but called by **A2b-4**'s `/revoke`; safe to defer
  because the consume join already fail-closes revoked grants (it's defense-in-depth, not the kill-switch).
  (b) The audit trail for a refresh — the **A2b-3** `/token` handler audits via `mintKeyForGrant`'s
  `key_minted`. (c) An expiry/used-row **sweep** job — the DELETE grant + policy are in place for it.
- **Accepted:** `auth_refresh_token` grows one row per refresh over a grant's life until the sweep lands
  (indexed by `grant_id`; lookups unaffected). `mintKeyForGrant` (Lane B) gates on grant status but not
  grant expiry — harmless on the refresh path since `consumeRefresh` already rejects expired grants before
  it's reached, but a parity fix for non-refresh callers is a Lane B follow-up.
- **Tested** (`packages/db/test/refresh-token.test.ts`, test:db, 13 cases): mint shape (org-embedded,
  hash-only storage); consume happy path → rotated handle; single-use replay; two-connection concurrent
  consume → exactly one wins; rotation chain; unknown/malformed/empty-org/wrong-prefix handles; org-tamper
  (hash covers org); expired handle; revoked grant; expired grant; pepper-rotation via candidates;
  `revokeRefreshTokensForGrant`. Plus the generic cross-org leak suite via `TENANT_TABLES`.
