-- migrate:up

-- Lane C A2b-4 — extend webhook_authn's api_keys column grant to also read `grant_id`, so the issuer's
-- RFC 7009 /revoke can resolve a presented `whk_` access key to its PARENT GRANT cross-org by hash. A
-- `whk_` does not embed its org (unlike the `rtk_` refresh handle), so the only way to find its grant is
-- the bearer-verify role's existing cross-org by-hash read path (the role-targeted SELECT policy from
-- 0009). This mirrors 0014's `audience` extension exactly: a column-level SELECT on a non-secret metadata
-- column. webhook_authn still cannot read display fields (name/prefix/start/timestamps), cannot write, and
-- its row visibility is unchanged (the FOR SELECT TO webhook_authn policy already exists).

grant select (grant_id) on api_keys to webhook_authn;

-- migrate:down

revoke select (grant_id) on api_keys from webhook_authn;
