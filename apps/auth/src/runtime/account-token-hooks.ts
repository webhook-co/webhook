// Data minimization / compliance-by-design: webhook.co uses social OAuth (Google, GitHub) for IDENTITY
// ONLY. Nothing in the codebase reads the provider tokens Better Auth stores on the `account` row —
//   • accessToken  — a short-lived bearer for calling the provider's API on the user's behalf; we never do.
//   • refreshToken — only issued with offline access (Google needs access_type=offline; GitHub OAuth apps
//                    issue none), which we don't request — so there's nothing to keep.
//   • idToken      — an OIDC JWT consumed AT sign-in to establish identity, then stale and unused.
// Storing them is pure liability (a plaintext-at-rest exposure in the identity DB). Rather than encrypt
// tokens we never read, we DON'T PERSIST them: these Better Auth `databaseHooks` null all three on every
// account create/update, and migration 0061 nulls any pre-existing rows. If we ever add a feature that
// acts on a user's behalf against a provider, that's the moment to request the right scopes and add
// ENCRYPTED refresh-token storage designed for it (incremental authorization) — not before.
//
// CAUTION: do NOT enable Better Auth's `account.storeAccountCookie`. On re-auth it seeds the account cookie
// from the freshly-minted in-memory tokens, which bypasses this DB-write strip — a plaintext provider token
// would land in a cookie despite the DB being clean. buildAuthConfig leaves it off; a guard test pins that.

import type { betterAuth } from "better-auth";

// Derived here (not imported from ./auth) to avoid a cycle — auth.ts imports THIS module for the wiring.
type AuthConfig = Parameters<typeof betterAuth>[0];

/** The exact set of columns we refuse to persist, pinned to null. Merged over the account row by Better
 *  Auth (`{ ...actualData, ...result.data }`), so it must name ONLY the token columns. */
export const STRIPPED_ACCOUNT_TOKENS = {
  accessToken: null,
  refreshToken: null,
  idToken: null,
} as const;

/** A Better Auth `create.before` / `update.before` hook return: merge `data` over the row. */
type BeforeResult = { data: typeof STRIPPED_ACCOUNT_TOKENS };
type BeforeHook = (row: unknown) => Promise<BeforeResult>;

const strip: BeforeHook = async () => ({ data: { ...STRIPPED_ACCOUNT_TOKENS } });

/** The account-model databaseHooks that strip the OAuth tokens on write. Both create and update are
 *  covered — Better Auth updates the account on each re-auth (updateAccountOnSignIn), which would otherwise
 *  re-persist a fresh token. */
export function makeAccountTokenHooks() {
  return {
    account: {
      create: { before: strip },
      update: { before: strip },
    },
  };
}

type DatabaseHooks = NonNullable<AuthConfig["databaseHooks"]>;

/**
 * Compose the account token-stripping into an existing databaseHooks object (the signup→bootstrap
 * user/session hooks), so a single wiring point guarantees the stripping for every auth instance. Other
 * models' hooks pass through untouched; an existing `account.create.after` / `update.after` is preserved,
 * and only the `before` hooks are installed (token-stripping is authoritative and non-negotiable).
 */
export function withAccountTokenStripping(hooks: DatabaseHooks | undefined): DatabaseHooks {
  const account = makeAccountTokenHooks().account;
  return {
    ...hooks,
    account: {
      ...hooks?.account,
      create: { ...hooks?.account?.create, before: account.create.before },
      update: { ...hooks?.account?.update, before: account.update.before },
    },
  } as DatabaseHooks;
}
