-- migrate:up

-- The R2 object key for an organization's UPLOADED logo (null = no logo → the app falls back to the generated
-- initial/hue OrgAvatar). Object lives in R2_AVATARS under the `org/<uuid>/logo.webp` prefix (namespaced apart
-- from the `user/<id>/avatar.webp` user avatars in the same bucket).
--
-- Unlike `user.imageKey` (0078), `orgs` is an APP-OWNED table — `webhook_app` holds insert/update/delete on it
-- (0003) — so this pointer is written directly by the app under `withTenant` (RLS `orgs_update` gates on the
-- pinned org), with NO Better Auth generator / auth RPC involved. Hence snake_case `image_key` to match every
-- other `orgs` column. Nullable, no default → a metadata-only add, safe on a live table. The upload route gates
-- the write to owner/admin (org branding, same class as the org name), so it's never client-injectable.

alter table orgs add column image_key text;

-- migrate:down

alter table orgs drop column image_key;
