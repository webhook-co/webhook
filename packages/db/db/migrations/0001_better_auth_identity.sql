-- migrate:up

-- Better Auth identity schema (generated, checked in, pinned — plan §0.8).
-- Source: `pnpm --filter @webhook-co/auth run auth:generate` -> the DDL captured in
-- db/migrations/.better-auth.schema.sql. We OWN these migrations; Better Auth never
-- auto-migrates prod. Tables are kept verbatim (quoted camelCase identifiers, text
-- ids) so a future regenerate diffs cleanly against the generator output.
--
-- These are GLOBAL identity tables, NOT org-scoped: `user`/`session`/`account`/
-- `verification` are per-user, and `apikey` is keyed by `referenceId` (the org) but
-- managed by the @better-auth/api-key plugin. They are therefore intentionally
-- EXEMPT from per-org RLS in this freeze — any org-scoping/RLS for identity is the
-- post-freeze auth workstream (mid-build decision, plan live-log). The RLS
-- catalog-coverage test (rls-leak-tests) lists these as documented exemptions.

create table "user" (
  "id" text not null primary key,
  "name" text not null,
  "email" text not null unique,
  "emailVerified" boolean not null,
  "image" text,
  "createdAt" timestamptz default current_timestamp not null,
  "updatedAt" timestamptz default current_timestamp not null
);

create table "session" (
  "id" text not null primary key,
  "expiresAt" timestamptz not null,
  "token" text not null unique,
  "createdAt" timestamptz default current_timestamp not null,
  "updatedAt" timestamptz not null,
  "ipAddress" text,
  "userAgent" text,
  "userId" text not null references "user" ("id") on delete cascade
);

create table "account" (
  "id" text not null primary key,
  "accountId" text not null,
  "providerId" text not null,
  "userId" text not null references "user" ("id") on delete cascade,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz default current_timestamp not null,
  "updatedAt" timestamptz not null
);

create table "verification" (
  "id" text not null primary key,
  "identifier" text not null,
  "value" text not null,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz default current_timestamp not null,
  "updatedAt" timestamptz default current_timestamp not null
);

create table "apikey" (
  "id" text not null primary key,
  "configId" text not null,
  "name" text,
  "start" text,
  "referenceId" text not null,
  "prefix" text,
  "key" text not null,
  "refillInterval" integer,
  "refillAmount" integer,
  "lastRefillAt" timestamptz,
  "enabled" boolean,
  "rateLimitEnabled" boolean,
  "rateLimitTimeWindow" integer,
  "rateLimitMax" integer,
  "requestCount" integer,
  "remaining" integer,
  "lastRequest" timestamptz,
  "expiresAt" timestamptz,
  "createdAt" timestamptz not null,
  "updatedAt" timestamptz not null,
  "permissions" text,
  "metadata" text
);

create index "session_userId_idx" on "session" ("userId");
create index "account_userId_idx" on "account" ("userId");
create index "verification_identifier_idx" on "verification" ("identifier");
create index "apikey_configId_idx" on "apikey" ("configId");
create index "apikey_referenceId_idx" on "apikey" ("referenceId");
create index "apikey_key_idx" on "apikey" ("key");

-- migrate:down

drop table if exists "apikey";
drop table if exists "verification";
drop table if exists "account";
drop table if exists "session";
drop table if exists "user";
