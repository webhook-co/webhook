-- migrate:up

-- Provider-secret resolution for the ingest path. To verify a captured webhook's signature
-- synchronously, the wbhk.my write path needs the endpoint's registered provider signing
-- secrets -- and, like the token resolution itself (0011), this happens BEFORE any tenant
-- context exists (org-discovery-by-hash). So the ingest resolver's cold lookup, connecting as
-- webhook_authn (the non-owner, NOBYPASSRLS by-hash credential-resolution role), gets a
-- role-TARGETED SELECT policy plus a COLUMN-scoped grant on provider_secrets, mirroring the
-- api_keys (0009) and endpoints (0011) grants.
--
-- The exposed columns are inert against a leaked webhook_authn credential: secret_ciphertext is
-- AES-256-GCM ciphertext, the DEK is wrapped under a KEK held by the KMS OUTSIDE the database
-- (envelope.ts / ADR-0007), and the plaintext signing secret is NEVER stored. Without the KEK the
-- ciphertext is inert -- reading it yields nothing usable. With no INSERT/UPDATE/DELETE grant the
-- role cannot write or forge. The display-only `label` is deliberately NOT granted (least
-- privilege). This extends the documented webhook_authn residual (docs/threat-model.md) from
-- api_keys + endpoints to provider_secrets.

create policy provider_secrets_authn_select on provider_secrets for select to webhook_authn using (true);

-- The cold-path read resolves by endpoint_id (a non-unique FK column with no index in 0003) and
-- orders newest-first. Without this index every ingest verify sequential-scans a cross-org table;
-- the index turns it into a point-ranged scan that also serves the order-by. (The unseal context
-- is rebuilt from the id/org_id/endpoint_id columns, so enc_context is NOT granted to webhook_authn.)
create index provider_secrets_endpoint_idx on provider_secrets (endpoint_id, created_at desc);

grant select (
  id, org_id, endpoint_id, provider, status, created_at,
  secret_ciphertext, wrapped_dek, kek_ref, enc_nonce, envelope_version
) on provider_secrets to webhook_authn;

-- migrate:down

revoke select (
  id, org_id, endpoint_id, provider, status, created_at,
  secret_ciphertext, wrapped_dek, kek_ref, enc_nonce, envelope_version
) on provider_secrets from webhook_authn;
drop index if exists provider_secrets_endpoint_idx;
drop policy if exists provider_secrets_authn_select on provider_secrets;
