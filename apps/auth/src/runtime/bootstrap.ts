// A1b-2 — signup→bootstrap. When Better Auth creates a user (first social login / magic-link signup), and
// as a self-heal when it creates a session, provision the user's personal org via Lane B's idempotent
// bootstrapPersonalOrg (org + owner membership + default endpoint, one tx, deterministic per-user id).
//
// This runs on a SEPARATE driver/role from Better Auth: the webhook_app postgres.js client over
// HYPERDRIVE_TENANT (bootstrapPersonalOrg sets the RLS tenant context itself), NOT Better Auth's
// webhook_auth pg pool. userId is Better Auth's server-authenticated id, never request-derived. A failure
// never throws (it would break signup/login) — the session-create self-heal retries, and the primitive is
// idempotent. The per-user slug must be globally unique AND is now a URL segment (/org/{slug}/…), so it is
// short, carries no identity, and a collision is retried rather than being fatal. See personalOrgSlug.

import { createHash, randomBytes } from "node:crypto";

import {
  bootstrapPersonalOrg,
  createClient,
  createCredentialHasherFromBase64,
  type Sql,
} from "@webhook-co/db";

export interface BootstrapUser {
  id: string;
  name?: string | null;
  email?: string | null;
}

export interface BootstrapDeps {
  /** webhook_app connection string (HYPERDRIVE_TENANT). */
  tenantConnectionString: string;
  /** Base64 credential pepper — keys the default endpoint's ingest-token HMAC. */
  credentialPepper: string;
  createClient: typeof createClient;
  bootstrap: typeof bootstrapPersonalOrg;
  makeHasher: typeof createCredentialHasherFromBase64;
  /** ctx.waitUntil — runs the session-create self-heal after the response (off the login hot path). */
  waitUntil?: (promise: Promise<unknown>) => void;
  /**
   * Read a user's profile. The self-heal is handed a bare userId, so without this it would name the org after
   * nobody — see the note on `hydrate`. Injectable so the unit tests can stub it; the default reads the
   * `"user"` row over the same webhook_app client (migration 0066 grants it a column-scoped
   * `select (id, name, email)`).
   */
  loadUserProfile?: (client: Sql, userId: string) => Promise<UserProfile | null>;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

interface UserProfile {
  name: string | null;
  email: string | null;
}

async function defaultLoadUserProfile(client: Sql, userId: string): Promise<UserProfile | null> {
  const rows = await client<UserProfile[]>`
    select "name", "email" from "user" where "id" = ${userId} limit 1`;
  return rows[0] ?? null;
}

/**
 * Give the user a name before we name their org after them.
 *
 * 🐞 The session-create self-heal is handed `{ id: session.userId }` and nothing else — Better Auth's session
 * row carries no profile. The old comment called that "sufficient, since an idempotent re-run ignores
 * slug/name", which is exactly backwards for the ONLY user the self-heal ever does anything for: someone who
 * has NO org yet. For them the slug and name are not ignored — they are the ones that get persisted. So a
 * user whose signup bootstrap blipped was silently given an org called **"Personal"** with the slug
 * **`org-<hex>`**, and `on conflict (id) do nothing` meant no later run ever repaired it.
 *
 * That was survivable while `orgs.slug` was a dead column. It stops being survivable the moment the slug is
 * the org's URL (`/org/{slug}/…`) and there is no rename path.
 *
 * So: if the caller gave us no profile, read one. This costs a query only on the self-heal path, which runs
 * inside `waitUntil` — off the login hot path — and only for a user we are actually about to bootstrap.
 */
async function hydrate(
  deps: BootstrapDeps,
  client: Sql,
  user: BootstrapUser,
): Promise<BootstrapUser> {
  if (user.name || user.email) return user;
  const load = deps.loadUserProfile ?? defaultLoadUserProfile;
  const profile = await load(client, user.id);
  return profile ? { ...user, name: profile.name, email: profile.email } : user;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The name part is capped; the uniqueness suffix never is. See the note on personalOrgSlug. */
const MAX_BASE = 16;
const SUFFIX_HEX = 6;

/**
 * The uniqueness suffix.
 *
 * Attempt 0 is a DETERMINISTIC digest, so an idempotent re-run derives the same slug. Its seed is
 * domain-separated for the slug specifically — deliberately NOT the seed `personalOrgId` hashes, even though
 * that would have worked. Sharing it would make the slug literally the first 24 bits of the org's own UUID:
 * harmless in itself (org ids are not secret, and nothing gates on their unguessability), but it couples two
 * identifiers that have no reason to move together.
 *
 * Every RETRY is RANDOM, and that is the load-bearing part. A deterministic retry set is a FIXED, FINITE set
 * — the same five slugs for that user, for all time. If all five are taken, the user is bricked exactly as
 * permanently as before this fix: the session-create self-heal re-derives those same five on every later
 * login and fails identically, forever. Fresh randomness is what makes the brick RECOVERABLE — the next login
 * draws new candidates, so the user heals on their own.
 */
function slugSuffix(userId: string, attempt: number): string {
  if (attempt === 0) {
    return createHash("sha256")
      .update(`webhook:org-slug:${userId}`)
      .digest("hex")
      .slice(0, SUFFIX_HEX);
  }
  return randomBytes(SUFFIX_HEX).toString("hex").slice(0, SUFFIX_HEX);
}

/**
 * A per-user-stable slug: `<name-or-email-or-default>-<digest>` — e.g. `dana-example-a3f19c`.
 *
 * This is a URL segment now (`/org/{slug}/…`), so it has two jobs it did not have before: be short, and
 * carry no identity. The old form was `<name>-<the whole 32-char Better Auth user id>` — around 45
 * characters, and it put the user's real name AND their auth user id into every teammate's URL bar, every
 * `Referer`, and every access log. The suffix is now a 6-hex digest of a domain-separated seed instead.
 *
 * 🐞 And the old form had a live bug. It was `` `${base}-${suffix}`.slice(0, 63) ``, which keeps the FIRST 63
 * characters — the base comes first, so it is the UNIQUENESS SUFFIX that gets truncated away, not the base.
 * (The comment claimed the exact opposite, which is how it survived review.) A display name of 63+ characters
 * is entirely user-controlled — it comes straight from a Google or GitHub profile — and produced a slug with
 * NO suffix at all. A second user with the same long name then collided on `orgs.slug`, bootstrap threw, and
 * `bootstrapForUser` SWALLOWS the throw (deliberately: a bootstrap fault must not break signup). That user
 * ends up with **no org at all, permanently** — the session-create self-heal re-derives the same slug and
 * fails identically, forever.
 *
 * So: the BASE is capped, before the join. The suffix is never truncated, and the whole thing is bounded by
 * construction rather than by a slice of the result.
 *
 * `attempt` 0 is the stable digest; every attempt after it draws a RANDOM suffix, so a genuine collision is
 * retried rather than bricking the user — and, crucially, remains retryable on a later login instead of
 * re-deriving the same doomed candidates forever. See bootstrapForUser.
 */
export function personalOrgSlug(user: BootstrapUser, attempt = 0): string {
  const named = slugify(user.name ?? "").slice(0, MAX_BASE);
  const emailed = slugify(user.email?.split("@")[0] ?? "").slice(0, MAX_BASE);
  // Re-trim: slicing a slug can leave a trailing hyphen, which the DB CHECK forbids.
  const base = (named || emailed).replace(/-+$/, "") || "org";
  return `${base}-${slugSuffix(user.id, attempt)}`;
}

/** A human display name for the personal org: the user's name, else their email local-part, else default. */
export function personalOrgName(user: BootstrapUser): string {
  const name = user.name?.trim();
  if (name) return name;
  const local = user.email?.split("@")[0]?.trim();
  return local || "Personal";
}

/**
 * How many suffixes to try before giving up. Exported so the test can pin the real budget: asserting a RANGE
 * ("between 2 and 5 calls") would stay green if someone quietly cut it to two.
 *
 * Giving up is not the end of the road any more — attempts 1+ are random, so the self-heal on the user's next
 * login draws fresh candidates rather than re-deriving the same doomed set.
 */
export const MAX_SLUG_ATTEMPTS = 5;

/** A unique-constraint violation on `orgs.slug` — i.e. this slug is taken by a DIFFERENT user's org. */
function isSlugCollision(error: unknown): boolean {
  const e = error as { code?: unknown; constraint_name?: unknown } | null;
  return (
    !!e &&
    e.code === "23505" && // unique_violation
    typeof e.constraint_name === "string" &&
    e.constraint_name.includes("slug")
  );
}

/**
 * Bootstrap one user's personal org on a fresh webhook_app client, then close it. Best-effort: a failure is
 * logged, never thrown — a bootstrap fault must not break signup/login. The session-create self-heal retries,
 * and bootstrapPersonalOrg is idempotent.
 *
 * 🔑 That swallow is exactly why a slug collision has to be retried HERE, and cannot be left to the self-heal.
 * `bootstrapPersonalOrg` conflicts on the org ID, not the slug, so a slug already held by a different user
 * raises a unique violation and throws. Nothing above catches it, so the loser silently gets no org — and if
 * the candidates were deterministic, every later self-heal would re-derive the same doomed set and fail
 * identically. Forever. Retrying, with RANDOM suffixes after the first, is what makes it survivable.
 *
 * Only a slug collision is retried. A db outage is not a slug problem, and hammering it four more times would
 * just make an incident worse.
 */
export async function bootstrapForUser(deps: BootstrapDeps, user: BootstrapUser): Promise<void> {
  const client = deps.createClient(deps.tenantConnectionString, { max: 1 });
  try {
    const hasher = deps.makeHasher(deps.credentialPepper);
    // Before we name the org after them, make sure we actually know who they are — the self-heal is handed a
    // bare userId, and an org named after nobody is permanent (see `hydrate`).
    const known = await hydrate(deps, client, user);
    const name = personalOrgName(known);

    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
      try {
        await deps.bootstrap(
          client,
          { userId: known.id, slug: personalOrgSlug(known, attempt), name },
          hasher,
        );
        return;
      } catch (error) {
        if (!isSlugCollision(error) || attempt === MAX_SLUG_ATTEMPTS - 1) throw error;
        deps.log?.("auth.bootstrap_slug_collision", { userId: known.id, attempt });
      }
    }
  } catch (error) {
    deps.log?.("auth.bootstrap_failed", { userId: user.id, error: String(error) });
  } finally {
    await client.end();
  }
}

/** Better Auth databaseHooks that bootstrap on user creation + self-heal on session creation. */
export function makeBootstrapHooks(deps: BootstrapDeps) {
  return {
    // Primary: awaited so the org exists before signup completes (the user lands needing it).
    user: {
      create: {
        after: async (user: BootstrapUser): Promise<void> => {
          await bootstrapForUser(deps, user);
        },
      },
    },
    // Self-heal: covers the rare user-create-bootstrap failure. Run OFF the login hot path via
    // ctx.waitUntil (it's a no-op for the ~always-already-bootstrapped user, so it must not add a tenant-
    // DB round-trip to every login's latency). Falls back to awaiting only if no waitUntil is available.
    //
    // The session carries ONLY the userId. That used to be called "sufficient, since an idempotent re-run
    // ignores slug/name" — which is exactly backwards for the only user this hook ever does anything for:
    // one who has no org YET, and for whom the slug and name are not ignored but persisted. It gave them an
    // org called "Personal" at `/org/org-<hex>/`, permanently. `bootstrapForUser` now reads their profile
    // when the caller hasn't supplied one.
    session: {
      create: {
        after: async (session: { userId: string }): Promise<void> => {
          const healing = bootstrapForUser(deps, { id: session.userId });
          if (deps.waitUntil) deps.waitUntil(healing);
          else await healing;
        },
      },
    },
  };
}
