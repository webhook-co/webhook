// A1b-2 — signup→bootstrap. When Better Auth creates a user (first social login / magic-link signup), and
// as a self-heal when it creates a session, provision the user's personal org via Lane B's idempotent
// bootstrapPersonalOrg (org + owner membership + default endpoint, one tx, deterministic per-user id).
//
// This runs on a SEPARATE driver/role from Better Auth: the webhook_app postgres.js client over
// HYPERDRIVE_TENANT (bootstrapPersonalOrg sets the RLS tenant context itself), NOT Better Auth's
// webhook_auth pg pool. userId is Better Auth's server-authenticated id, never request-derived. A failure
// never throws (it would break signup/login) — the session-create self-heal retries, and the primitive is
// idempotent. The per-user slug must be globally unique, so it carries a stable suffix derived from the
// userId (two different users can't collide).

import { createHash } from "node:crypto";

import {
  bootstrapPersonalOrg,
  createClient,
  createCredentialHasherFromBase64,
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
  log?: (event: string, fields?: Record<string, unknown>) => void;
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
 * The uniqueness suffix: a short digest of a domain-separated seed. Deterministic per (user, attempt), so an
 * idempotent re-run derives the same slug — and it does NOT contain the user id, which is the point.
 */
function slugSuffix(userId: string, attempt: number): string {
  const seed =
    attempt === 0 ? `webhook:personal-org:${userId}` : `webhook:personal-org:${userId}#${attempt}`;
  return createHash("sha256").update(seed).digest("hex").slice(0, SUFFIX_HEX);
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
 * `attempt` re-derives a different (still stable) suffix, so a genuine collision is retried rather than
 * bricking the user — see bootstrapForUser.
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

/** How many fresh suffixes to try before giving up. A collision is already vanishingly unlikely. */
const MAX_SLUG_ATTEMPTS = 5;

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
 * raises a unique violation and throws — and the derivation is DETERMINISTIC, so the self-heal re-derives the
 * same slug and fails identically. Forever. A one-in-a-million collision would permanently leave whoever lost
 * it with no org at all, silently. Retrying with a fresh (still stable) suffix is what makes it survivable.
 *
 * Only a slug collision is retried. A db outage is not a slug problem, and hammering it four more times would
 * just make an incident worse.
 */
export async function bootstrapForUser(deps: BootstrapDeps, user: BootstrapUser): Promise<void> {
  const client = deps.createClient(deps.tenantConnectionString, { max: 1 });
  try {
    const hasher = deps.makeHasher(deps.credentialPepper);
    const name = personalOrgName(user);

    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
      try {
        await deps.bootstrap(
          client,
          { userId: user.id, slug: personalOrgSlug(user, attempt), name },
          hasher,
        );
        return;
      } catch (error) {
        if (!isSlugCollision(error) || attempt === MAX_SLUG_ATTEMPTS - 1) throw error;
        deps.log?.("auth.bootstrap_slug_collision", { userId: user.id, attempt });
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
    // The session carries only the userId — sufficient, since an idempotent re-run ignores slug/name.
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
