-- migrate:up

-- Endpoint-token resolution for the ingest path. Resolving a presented wbhk.my/<token>
-- path token to its owning org+endpoint happens BEFORE any tenant context exists
-- (org-discovery-by-hash), exactly like the api-key verify path (0009). The ingest
-- resolver's cold lookup connects as webhook_authn -- the non-owner, NOBYPASSRLS by-hash
-- credential-resolution role -- and gets a role-TARGETED SELECT policy plus a
-- COLUMN-scoped grant on endpoints, mirroring the api_keys grant.
--
-- The exposed columns are inert against a leaked webhook_authn credential:
-- ingest_token_hash is a peppered HMAC-SHA256 of a >=256-bit CSPRNG token (the pepper
-- lives OUTSIDE the database; see credential.ts and docs/adr/0003), and id/org_id/paused
-- are low-sensitivity. With no INSERT/UPDATE/DELETE grant the role cannot forge a token
-- or write. This extends the documented webhook_authn residual (docs/threat-model.md)
-- from api_keys to endpoints.

create policy endpoints_authn_select on endpoints for select to webhook_authn using (true);

grant select (id, org_id, ingest_token_hash, paused) on endpoints to webhook_authn;

-- migrate:down

revoke select (id, org_id, ingest_token_hash, paused) on endpoints from webhook_authn;
drop policy if exists endpoints_authn_select on endpoints;
