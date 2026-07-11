-- migrate:up

-- Let the bearer-resolution role read a key's OWN id, so an audited mutation can name the credential
-- that performed it.
--
-- Until now the resolved principal was {org_id, scopes, audience} — it never read the key's id. A standalone
-- api key carries no user, so every mutation made over the API, MCP, or the CLI was written to the audit
-- chain with `actor = NULL`: indistinguishable from the delivery DO's genuine system actions. The chain
-- could not say who acted, and an incident could not say WHICH CREDENTIAL TO ROTATE.
--
-- `webhook_authn` is the most exposed role in the system, so its grant on api_keys is a deliberately narrow
-- column list and every widening must justify itself. This one adds `id` and nothing else:
--   * `id` is the key's own primary key — not secret material, and strictly less sensitive than `key_hash`,
--     which this role must already read to authenticate at all.
--   * It is the MINIMUM needed for attribution: it names the credential without naming the human.
--   * `created_by` is deliberately NOT granted (see 0057). The accountable human is resolved at READ time by
--     joining api_keys under `webhook_app`'s RLS — which keeps that link authoritative and keeps the hot path
--     from ever learning who owns a key.
grant select (id) on api_keys to webhook_authn;

-- migrate:down

revoke select (id) on api_keys from webhook_authn;
