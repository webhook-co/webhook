# ADR-0118: Account-linking policy, pinned; and a unique identity index on `account`

- **Status:** Accepted
- **Date:** 2026-07-15
- **Relates to:** ADR-0008 (role model / RLS), ADR-0010 (auth runtime), ADR-0061-era account-token stripping

## Context

Two latent weaknesses sat under the identity tables, both harmless today but load-bearing the moment an
**email-change / connect-disconnect-social** surface ships (a following slice):

1. **Account linking rode Better Auth's defaults, unpinned.** `buildAuthConfig`
   (`apps/auth/src/runtime/auth.ts`) set no `account.accountLinking` block, so the policy that decides *when a
   provider identity attaches to an existing user* was whatever the library defaulted to for the installed
   version. Implicit linking (sign in with Google → attach to the local account with that email) is exactly
   the classic account-pre-hijack primitive: pre-seed a local account with a victim's address, wait for them
   to sign in with a provider, inherit the link. Better Auth's defaults happen to defend this
   (`requireLocalEmailVerified ?? true`, and implicit linking requires a verified *incoming* email unless the
   provider is "trusted"), but "happens to" is not a policy — a version bump or a stray edit could move it
   silently.

2. **`account` had no uniqueness on `(providerId, accountId)`.** That pair *is* the external identity
   ("github" + the GitHub user id, "google" + the Google `sub`). Better Auth's adapter looks an account up by
   exactly this pair on every social sign-in and link, but the table carried only a `userId` index — so the
   lookup was a seq scan, and two concurrent OAuth callbacks for the same identity could race into **two**
   account rows. A duplicated identity makes "which account is this?" nondeterministic.

## Decision

**Pin the account-linking policy explicitly, and make the duplicate-identity state unrepresentable.**

### 1. Linking policy, spelled out (`account.accountLinking`)

| Option | Value | Why |
| --- | --- | --- |
| `enabled` | `true` | Keep implicit verified-email linking on — signing in with a provider whose verified email matches an existing account links them rather than stranding a second identity. **A deliberately accepted risk**, chosen for UX; the guards below fence it. |
| `disableImplicitLinking` | `false` | The explicit companion to `enabled` — implicit linking stays on, on purpose. |
| `trustedProviders` | `[]` | No provider is trusted to link *without* asserting a verified incoming email. Empty is the secure choice; Google and GitHub both provide `email_verified`. |
| `requireLocalEmailVerified` | `true` | Only implicitly link **into** a local account whose own email is verified. This is Better Auth's default, pinned so it can't be silently dropped — it is what blocks the pre-hijack. This runtime is social + magic-link only, and magic-link always verifies, so it costs legitimate users nothing. |
| `allowDifferentEmails` | `true` | Let a *signed-in* user link a provider whose email differs from their current one — required so a user who changes their email can re-link Google/GitHub. Safe: `/link-social` needs the user's own session, and implicit sign-in linking stays same-email regardless. |
| `allowUnlinkingAll` | `false` | Never allow the last sign-in method to be unlinked — that would strand the user out of their own account. |

It lives **only** in the runtime config, not the generator (`apps/auth/src/auth.ts`): linking is behavioural,
not schema, so it emits no DDL and does not touch the Better Auth schema-drift guard. A regression test
(`auth.test.ts` — "PINS the account-linking policy explicitly") fails if any value is dropped or flipped.

### 2. A unique index on the identity pair (migration `0076`)

`create unique index "account_providerId_accountId_key" on "account" ("providerId", "accountId");`

`account` is an RLS-exempt global identity table (ADR-0008 / migration 0001), owned by `webhook_owner` and
DML'd by the non-bypass `webhook_auth` role (0016) — a plain btree unique has no policy interaction and needs
no GRANT change. It turns the adapter's lookup into an index probe and makes the concurrent-callback duplicate
impossible at the database.

**Prod pre-flight:** a unique-index build fails cleanly (no data change) if a duplicate pair already exists.
Before applying to prod, confirm none do (query in the migration header); de-dup keeping the earliest
`createdAt` if any appear. On this deployment the expected count is zero.

## Consequences

- The linking policy is now a reviewed, tested artifact rather than a library default. The accepted residual
  risk is implicit verified-email linking itself — fenced by `requireLocalEmailVerified` + verified-incoming-
  email + empty `trustedProviders`, and revisited if we ever add password signup (which would make
  unverified-local-account seeding cheap again).
- The identity pair is unique; the email-change and connect/disconnect-social slice can rely on "one row per
  external identity" without re-proving it.
- No RLS/role/generator/schema-drift impact. The migration is reversible (`drop index`).
