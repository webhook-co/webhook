-- migrate:up

-- The R2 object key for a user's UPLOADED avatar (null = no upload → the app falls back to the provider /
-- gravatar image via `user.image`). This is distinct from `user.image`: `image` is Better Auth's core column
-- holding an external provider avatar URL (proxied + host-allowlisted), and it's overwritten on every social
-- login — an R2 object key would break the URL parse and get clobbered. So a separate pointer column.
--
-- Declared as a Better Auth `additionalFields` entry (apps/auth/src/auth.ts) so the schema GENERATOR emits it
-- and the CI drift guard stays green; this is the hand-owned dbmate counterpart (the 0073 pattern). Nullable,
-- no default → a metadata-only add, safe on a live table. Written ONLY app-side over the auth RPC
-- (`input: false` in the runtime config), never client-settable — a client-settable image key would be a
-- pointer-injection vector (serve someone else's / an arbitrary object).

alter table "user" add column "imageKey" text;

-- migrate:down

alter table "user" drop column "imageKey";
