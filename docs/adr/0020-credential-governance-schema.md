# ADR 0020 — Credential & governance schema: auth_grant, org_policy, auth_audit_event

- status: accepted
- date: 2026-06-19
- scope: `packages/db` (migrations 0013–0014 — the credential/governance tables + the `api_keys` extension)
- relates: ADR-0010 (auth foundation, r3/r5/r6/r7), ADR-0008 (api-key RLS posture), ADR-0004 (audit chain). The mint-scoped-key model + the conditional audience stamp land in the forthcoming Lane B mint-model ADR (0019).
- review severity: high (RLS + governance schema on the credential surface)

## context

ADR-0010 (r5/r6) settles "OAuth login mints a scoped `whk_` key" and a **governance-ready credential
model designed in now** so the later admin console needs no migration. Lane B slice A0a lands that
schema beneath the mint primitive (which is A0c): the grant a key hangs off, the per-org policy knobs,
the control-plane audit chain, and the `api_keys` columns the mint + the conditional audience stamp need.

## decision

1. **Three tables (migration 0013)** under the canonical tenant-RLS discipline (mirrors
   `0003_domain_tables.sql`): `ENABLE` + `FORCE` RLS, deny-by-default per-command policies on
   `current_org_id()`, DML granted to `webhook_app` only.
   - **`auth_grant`** — one row per CLI/web login (a device-authorization grant): `status`
     (`pending_approval|active|revoked|expired`), `auth_method` (`pkce_loopback|device_code`), device
     name/fingerprint + created/last-used ip/geo, approved/revoked actor+timestamp+reason,
     `sso_identity_id`. Named **`auth_grant`**, not the SQL reserved word `grant` (which would force
     quoting everywhere). `actor_type` defaults `'user'` (enum-now-for-future).
   - **`org_policy`** — one row/org; **every governance field is nullable = unset**, so enabling a
     control later is data, not a migration. `require_device_approval` null/false = OFF (the founder
     default for all orgs).
   - **`auth_audit_event`** — append-only, per-org hash-chained, the **same discipline as `audit_log`**
     (`0005`): the DB enforces chain *structure* (contiguous per-org `seq`, `prev_hash` linked to the
     prior `row_hash`, immutability triggers blocking UPDATE/DELETE/TRUNCATE, SELECT+INSERT-only RLS);
     the **app** supplies `row_hash = HMAC(key, prev_hash || canonical(fields))` with the key held
     outside the DB role.
2. **The `api_keys` extension (migration 0014)** — all additive/expand-only:
   - `audience` (nullable) — the per-key RFC 8707 audience; the future-OAuth seam `credential-resolver`
     documents. Null = legacy/org-wide (stamped with the presenting surface at resolve time).
   - `grant_id` (uuid FK → `auth_grant`, **permanently nullable**, `on delete cascade`) — null = a
     standalone/directly-created key; set = an OAuth/device-grant-backed key.
   - `owner_type` (`NOT NULL DEFAULT 'user'`, check `user|org`) — a constant default is metadata-only
     and backfills existing rows.
   - `sso_authorized` (nullable) — designed-in for the SSO-authorization gate; unenforced in v1.
   - The `webhook_authn` cold-path column grant extends to **`audience` only** (not
     grant_id/owner_type/sso_authorized — the cold path needs only the audience for the conditional stamp).
3. **`auth_audit_event` is a SEPARATE chain from `audit_log`, not a reuse:** distinct fields
   (`event_type/target_id/ip/geo/metadata`) and a distinct canon version (`aae1`), so the frozen
   `audit_log` `wha1` chain is byte-for-byte untouched. The dedicated `appendAuthAuditEntry` helper +
   the `aae1` canonicalization land in A0c (the mint slice); 0013 ships the table + the chain/
   immutability triggers.

## rejected alternatives

- **Reuse `audit_log`** for auth events (an `auth.*` action vocabulary) — shoehorns device/ip/geo into
  `metadata`; the control plane warrants its own vocabulary + a separate chain.
- **Reuse the `wha1` 5-field canon** for `auth_audit_event`, storing ip/geo/metadata unhashed — weaker
  tamper-evidence over the control-plane fields; the dedicated `aae1` chain (A0c) hashes them all.
- **`grant_id` NOT NULL** (every key under a grant) — rejected per ADR-0010 r7: standalone
  directly-created keys (e.g. CI keys via `createApiKey`) are a permanent part of the model, so
  `grant_id` is permanently nullable; there is no contract migration.
- **Naming the table `grant`** (ADR-0010 r6's logical name) — reserved word; renamed to `auth_grant`.

## consequences

- The governance schema is in place; admin-console enforcement (credential-TTL caps, scope allowlists,
  SSO-required, MFA, long-lived-key limits, the human approval queue) lands later with **no migration**
  (nullable fields + the append-only audit). `require_device_approval` defaults OFF for all orgs incl.
  enterprise; a per-org admin toggle flips it.
- The conditional audience stamp + `makeApiKeyColdLookup` reading `api_keys.audience` are A0b; the
  `mintScopedKey`/`mintKeyForGrant` primitives + the `aae1` `appendAuthAuditEntry` helper + the
  `auto_approve_rules` evaluator are A0c.
- **`org_policy` is effectively read-only in v1 — no mutation surface exists.** It is webhook_app-
  writable within-org under RLS, but nothing writes it yet. **Forward requirement [SEC-RLS-08]:** when
  a policy setter lands (the admin console), it MUST (a) gate on admin/owner membership — RLS pins the
  org but does NOT authorize *who* may change policy — and (b) emit a `policy_changed` auth-audit
  event (the `aae1` chain already reserves the `policy_changed` event_type). Recorded so it isn't
  missed when the setter is built.
- **Reversible** — `dbmate up → down → down → up` verified clean; expand-only, no NOT-NULL contract.
  **`0015` shipped** the composite `api_keys (grant_id, org_id) → auth_grant (id, org_id)` FK
  hardening (A0c-3 — the cross-tenant grant-binding fix; documented in ADR-0019), so the Lane B
  migration block 0013–0015 is fully consumed (this supersedes the earlier "0015 reserved/unused"
  note). The Better-Auth `apikey`-table drop (ADR-0008's contract migration) remains deferred
  (contingent on Lane C removing `apiKey()` from the generate config).
- **Tested** (the RLS leak suite, `packages/db/test/rls.test.ts`, now 92 tests): cross-org isolation +
  deny-by-default + FORCE-defeats-owner across all three new tables; `auth_audit_event` append-only
  (chain contiguity, prev_hash linkage, genesis, the immutability trigger vs the cluster superuser);
  the `api_keys` extension (column defaults, the grant FK, the `audience`-only authn column grant).
