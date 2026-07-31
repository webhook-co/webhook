// Refuse to CREATE a user whose email the provider did not verify.
//
// THE HOLE THIS CLOSES. better-auth enforces `emailVerified` only on the LINK branch of
// `handleOAuthUserInfo` — the check lives inside `if (dbUser)` (oauth2/link-account.mjs). The SIGNUP
// branch, a few lines below, calls `createOAuthUser({ …, emailVerified: userInfo.emailVerified })` with
// NO check whatsoever. So `accountLinking.requireLocalEmailVerified` and an empty `trustedProviders`
// — both of which this app sets, and both of which are genuinely correct — govern linking to an
// EXISTING row and say nothing at all about creating a NEW one.
//
// THE ATTACK, end to end:
//   1. An attacker holds a Google account whose address is victim@company.com and which Google reports
//      as `email_verified: false`. Google's own integration docs tell you not to trust the email claim
//      without that flag, precisely because this state is reachable.
//   2. They open the login page and tap One Tap. A user row for victim@company.com is created with
//      `emailVerified: false` and the ATTACKER's Google `sub` linked to it, plus a session and a
//      bootstrapped personal org.
//   3. The real victim later signs in by magic link. `revokeUnprovenAccountAccess` runs — but it deletes
//      only accounts with `providerId === "credential"`, and this app has none (social + magic-link
//      only). The attacker's GOOGLE account link is untouched.
//   4. `emailVerified` flips to true, the victim lands in the attacker's row, and the attacker keeps
//      permanent One-Tap access to the victim's account and organisation.
//
// One Tap did not introduce this — the "Continue with Google" button reaches the same code — but it
// removes every remaining speed bump: the takeover becomes a single unauthenticated POST with no
// redirect, no captcha, and no interaction beyond a tap.
//
// WHY A `create.before` HOOK. It is the one place every better-auth create path funnels through, so a
// single check covers Google, One Tap, GitHub and any provider added later, without depending on each
// provider's mapping. It is also the only layer that can still say NO: by the time an after-hook runs,
// the row and its linked account exist.
//
// WHAT IT DOES NOT BREAK, verified against the installed package rather than assumed:
//   • Magic link creates with a literal `emailVerified: true` (plugins/magic-link/index.mjs) — the link
//     IS the proof — so this gate is invisible to it.
//   • Google and One Tap pass the provider's real claim through.
//   • GitHub resolves `verified` from its /user/emails API for the chosen address.
//   • Nothing in this repo creates users outside better-auth; `packages/db` writes raw SQL, which never
//     reaches `databaseHooks`.
//
// THE ACCEPTED COST. A GitHub signup whose /user/emails call fails resolves to `false` (upstream's
// `?? false`) and is refused rather than admitted. That is the correct direction — we cannot prove the
// address — and the user can retry or use magic link, which proves it directly. The refusal is logged so
// it is diagnosable rather than a mystery.

import type { betterAuth } from "better-auth";

type AuthConfig = Parameters<typeof betterAuth>[0];
type DatabaseHooks = NonNullable<AuthConfig["databaseHooks"]>;

/** The structured observability sink `buildAuthConfig` threads through (`deps.log`). */
type LogSink = (event: string, fields?: Record<string, unknown>) => void;

/**
 * Whether the row being created carries PROOF that its owner controls the email.
 *
 * Strictly `=== true`. A truthy string or number is what a mis-mapped provider profile looks like, and
 * accepting one would silently reopen the hole this module exists to close — so anything that is not a
 * real boolean `true` counts as unproven. Every legitimate path sets a genuine boolean.
 */
export function isEmailProven(user: unknown): boolean {
  if (typeof user !== "object" || user === null) return false;
  return (user as { emailVerified?: unknown }).emailVerified === true;
}

/**
 * Compose the unverified-email refusal into an existing databaseHooks object.
 *
 * Sits OUTSIDE the name back-fill so it runs first and short-circuits: on refusal the inner hook is
 * never invoked, because there is no point deriving a display name for a row that must not exist.
 * Returning `false` is better-auth's abort signal — `createWithHooks` stops and `handleOAuthUserInfo`
 * degrades to `"unable to create user"`, which the endpoint surfaces as a 401.
 *
 * Fails CLOSED by construction: the refusal is decided before the log call, and the log is wrapped, so a
 * telemetry fault can never turn a refusal into an acceptance.
 */
export function withUnverifiedEmailRejection(
  hooks: DatabaseHooks | undefined,
  log?: LogSink,
): DatabaseHooks {
  const inner = hooks?.user?.create?.before as
    ((user: unknown, context: unknown) => Promise<unknown>) | undefined;

  const before = async (user: unknown, context: unknown) => {
    if (!isEmailProven(user)) {
      try {
        // The event name only. The refused address is the one thing here that is PII, and an
        // unverified signup attempt is exactly the case where it might not belong to the person trying.
        log?.("signup.refused_unverified_email", {});
      } catch {
        // never let telemetry change the decision
      }
      return false;
    }
    return inner ? inner(user, context) : undefined;
  };

  return {
    ...hooks,
    user: {
      ...hooks?.user,
      create: {
        ...hooks?.user?.create,
        before,
      },
    },
  } as DatabaseHooks;
}
