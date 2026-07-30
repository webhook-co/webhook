// Back-fill `firstName`/`lastName` for signups that arrive without them.
//
// WHY THIS EXISTS: better-auth's one-tap plugin builds its user record by hand from the Google ID token —
// it destructures only `{ email, email_verified, name, picture, sub }` and hands `handleOAuthUserInfo` an
// empty provider profile. So `socialProviders.google.mapProfileToUser` (runtime/auth.ts), which maps
// `given_name`/`family_name` onto our columns and which that file calls load-bearing, is NEVER CALLED on
// the One Tap path. A One Tap signup would land with both columns NULL — strictly worse data than the
// "Continue with Google" button it replaces. This hook is the repair for that, not a general improvement.
//
// THREE RULES, IN ORDER:
//   1. Never clobber. Only a field that is absent is considered. This makes the OAuth-button path (where
//      both columns are already set to Google's exact values before this runs) a strict no-op, and makes
//      the hook idempotent by construction. Without it, this hook would be a silent regression on every
//      Google button signup — overwriting exact values with a guess, worst on non-Anglo and CJK names.
//   2. Exact when provable. On the one-tap callback, read `given_name`/`family_name` off the ID token.
//   3. Split when not. Otherwise fall back to `splitName(name)` — the same guess we already accept for
//      every GitHub signup.
//
// WHY DECODING WITHOUT VERIFYING IS SOUND. The plugin's handler is strictly sequential: it resolves the
// audience, calls `verifyGoogleIdToken` (jose, Google's JWKS, issuer + audience + exp + a 1h max age) and
// throws 400 if it returns null, checks the hosted domain, and only THEN calls `handleOAuthUserInfo` —
// which is the only path to `createOAuthUser` → `createWithHooks` → this hook. So if we are invoked with
// `path === ONE_TAP_CALLBACK_PATH`, that exact token string was already cryptographically verified in
// this same request. Re-verifying would mean a second uncached JWKS fetch on the signup hot path for
// literally zero added security. The email cross-check below turns that proof into a proof PLUS a guard,
// for the cost of one string compare — because "no other code path under this endpoint creates a user"
// is true today and is exactly the kind of thing an upstream refactor can change quietly.
//
// EVERY failure mode degrades to `splitName`, never to corruption: a null context (better-auth constructs
// that case itself, with `.catch(() => null)`), a missing body or path, a renamed field, an undecodable
// token, an email mismatch. The context is treated as `unknown` and narrowed, the same discipline
// bootstrap.ts already applies to library-internal shapes.
//
// MAGIC-LINK USERS ARE DELIBERATELY LEFT ALONE. better-auth creates them with `name: name || ""` and this
// repo never sends a name, so they arrive with an empty string and `splitName("")` yields nothing. The
// back-fill is a verified no-op for them. Inventing a name from the email local-part would put a guess in
// the column the onboarding screen exists to ask about — and would then flow into personal-org naming on
// a later self-heal. Declined on purpose.
//
// EXISTING USERS ARE NEVER BACK-FILLED. `create.before` does not run when an existing user signs in:
// `handleOAuthUserInfo` takes the link/update branch and never reaches `createOAuthUser`. That is the
// correct scope — those users are already past onboarding, and the only reader (the onboarding pre-fill)
// already derives from `name` at read time.

import { splitName } from "@webhook-co/shared";

import type { betterAuth } from "better-auth";

type AuthConfig = Parameters<typeof betterAuth>[0];
type DatabaseHooks = NonNullable<AuthConfig["databaseHooks"]>;

/** The one-tap plugin's registered endpoint path, as it appears on the endpoint context (basePath stripped). */
export const ONE_TAP_CALLBACK_PATH = "/one-tap/callback";

/**
 * The ONLY columns this hook may write, and the artifact that makes that true.
 *
 * A `create.before` hook bypasses better-auth's `input: false` filter entirely — that filter runs at the
 * route layer, while a hook's returned `data` is merged straight into the adapter payload and the
 * adapter's own transform never consults `input`. So this hook COULD write `onboardedAt` or `imageKey`,
 * both of which runtime/auth.ts deliberately fences off from client writes. A stray `onboardedAt` would
 * mark a brand-new user as already onboarded and skip onboarding permanently. Every value written below
 * is projected through this list, and a test feeds the hook a hostile payload to prove it.
 */
export const NAME_BACKFILL_FIELDS: readonly string[] = ["firstName", "lastName"];

interface NamePatch {
  firstName?: string;
  lastName?: string;
}

/** A user row as handed to `user.create.before` — everything optional, because it is library-shaped. */
interface CreatingUser {
  email?: unknown;
  name?: unknown;
  firstName?: unknown;
  lastName?: unknown;
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/** A field counts as ABSENT when it is missing, null, or blank — `completeOnboarding` stores "" as NULL. */
const isAbsent = (value: unknown): boolean => asString(value) === undefined;

/**
 * Decode a JWT's payload WITHOUT verifying it (see the module header for why that is correct here).
 * Returns undefined for anything that is not three dot-separated segments with a JSON middle.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const segment = token.split(".")[1];
  if (segment === undefined || segment.length === 0) return undefined;
  try {
    const binary = atob(segment.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    // TextDecoder, not the binary string: names carry non-ASCII ("María"), and reading the raw bytes as
    // latin-1 would mojibake exactly the names this hook exists to get right.
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The exact names from a One Tap ID token, when this really is the one-tap callback and the token really
 * describes the user being created. Any doubt returns undefined and the caller falls back to splitName.
 */
function exactNamesFromContext(user: CreatingUser, context: unknown): NamePatch | undefined {
  if (typeof context !== "object" || context === null) return undefined;
  const { path, body } = context as { path?: unknown; body?: unknown };
  if (path !== ONE_TAP_CALLBACK_PATH) return undefined;
  if (typeof body !== "object" || body === null) return undefined;

  const token = (body as { idToken?: unknown }).idToken;
  if (typeof token !== "string") return undefined;

  const payload = decodeJwtPayload(token);
  if (payload === undefined) return undefined;

  // The guard: the token must describe the row being created. better-auth lowercases the email before
  // the insert, so compare case-insensitively rather than requiring the claim to already be normalized.
  const claimed = asString(payload.email)?.toLowerCase();
  const creating = asString(user.email)?.toLowerCase();
  if (claimed === undefined || creating === undefined || claimed !== creating) return undefined;

  const firstName = asString(payload.given_name);
  const lastName = asString(payload.family_name);
  // given_name is the one Google effectively always sets; without it there is nothing exact to prefer.
  return firstName === undefined ? undefined : { firstName, lastName };
}

/**
 * better-auth `user.create.before`: fill `firstName`/`lastName` when — and only when — they are absent.
 *
 * Returns `{ data }` with at most the two name fields, or `undefined` for "change nothing". It can NEVER
 * return `false`: better-auth reads `false` as "abort the insert", which would silently break signup, so
 * there is no branch here that produces a boolean and a test pins that against hostile input.
 */
export async function nameBackfillBefore(
  user: CreatingUser,
  context: unknown,
): Promise<{ data: NamePatch } | undefined> {
  try {
    const row: CreatingUser = typeof user === "object" && user !== null ? user : {};
    const wantFirst = isAbsent(row.firstName);
    const wantLast = isAbsent(row.lastName);
    if (!wantFirst && !wantLast) return undefined;

    const candidate = exactNamesFromContext(row, context) ?? splitName(asString(row.name));

    const patch: NamePatch = {};
    // Projection through the allowlist: every write below names a field from NAME_BACKFILL_FIELDS and
    // nothing reaches `patch` by any other route.
    if (wantFirst && asString(candidate.firstName) !== undefined) {
      patch.firstName = asString(candidate.firstName);
    }
    if (wantLast && asString(candidate.lastName) !== undefined) {
      patch.lastName = asString(candidate.lastName);
    }

    return Object.keys(patch).length > 0 ? { data: patch } : undefined;
  } catch {
    // A throw here would break signup outright. Writing nothing leaves the columns NULL, which the
    // onboarding pre-fill already handles.
    return undefined;
  }
}

/**
 * Compose the name back-fill into an existing databaseHooks object.
 *
 * Mirrors `withAccountTokenStripping`: a shallow spread so every other model's hooks — and crucially the
 * bootstrap's `user.create.after`, which provisions the personal org — pass through BY REFERENCE. A
 * single composition point in `buildAuthConfig` is what guarantees the back-fill for every auth instance
 * regardless of caller, rather than depending on which deps a particular caller happened to pass.
 */
export function withNameBackfill(hooks: DatabaseHooks | undefined): DatabaseHooks {
  return {
    ...hooks,
    user: {
      ...hooks?.user,
      create: {
        ...hooks?.user?.create,
        before: nameBackfillBefore,
      },
    },
  } as DatabaseHooks;
}
