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

/**
 * A per-user-stable slug: `<name-or-email-or-default>-<userId-suffix>`. The suffix is the full slugified
 * userId, so a collision between two different users is cryptographically improbable (a slug already taken
 * by another user would make the bootstrap throw — bootstrapPersonalOrg conflicts on the org id, not the
 * slug); stability means an idempotent re-run produces the same slug. (The 63-char cap is generous; the
 * base is what gets truncated if a name is very long, never the uniqueness-bearing suffix in practice.)
 */
export function personalOrgSlug(user: BootstrapUser): string {
  const base = slugify(user.name ?? "") || slugify(user.email?.split("@")[0] ?? "") || "user";
  const suffix = slugify(user.id) || "x";
  return `${base}-${suffix}`.slice(0, 63);
}

/** A human display name for the personal org: the user's name, else their email local-part, else default. */
export function personalOrgName(user: BootstrapUser): string {
  const name = user.name?.trim();
  if (name) return name;
  const local = user.email?.split("@")[0]?.trim();
  return local || "Personal";
}

/**
 * Bootstrap one user's personal org on a fresh webhook_app client, then close it. Best-effort: a failure
 * is logged, never thrown — the session-create self-heal retries and bootstrapPersonalOrg is idempotent.
 */
export async function bootstrapForUser(deps: BootstrapDeps, user: BootstrapUser): Promise<void> {
  const client = deps.createClient(deps.tenantConnectionString, { max: 1 });
  try {
    const hasher = deps.makeHasher(deps.credentialPepper);
    await deps.bootstrap(
      client,
      { userId: user.id, slug: personalOrgSlug(user), name: personalOrgName(user) },
      hasher,
    );
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
