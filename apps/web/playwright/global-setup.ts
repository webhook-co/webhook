import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import { createClient, DB_ROLES, withTenant, type Sql } from "@webhook-co/db";
import { createOrgWithOwner } from "@webhook-co/db/orgs";

import { setupSchema } from "../../../packages/db/test/migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "../../../packages/db/test/pg";
import { BASE_URL, PORT, writeFixture, type Fixture } from "./fixture";

// The dashboard's first end-to-end harness.
//
// Until now `apps/web` had NO browser test at all — Playwright covered only the marketing site. That gap is
// not theoretical. The page tests MOCK the auth gate, so they keep passing even if a page reads the acting
// org from the wrong place. The server-action tests assert that `revalidatePath` was called with a path
// LITERAL, so they keep passing even when that path no longer exists and the invalidation has silently
// become a no-op. Neither class of bug is visible below the browser.
//
// So: a real Postgres, a real `next dev`, a real Chromium.
//
// Two things here are load-bearing and easy to get subtly wrong.
//
//  1. **The app connects as `webhook_app`, not the superuser.** The `localConnectionString` committed in
//     wrangler.jsonc is `postgres://postgres:…`, and the `postgres` superuser BYPASSES row-level security. A
//     suite booted against it would happily render every tenant's rows and still go green — it would prove
//     nothing about the isolation it exists to prove. We override the binding to the app role.
//     `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>` is wrangler's documented override, and
//     `initOpenNextCloudflareForDev()` (next.config.ts) builds its miniflare through the same
//     `getPlatformProxy()` path, so `next dev` honours it.
//
//  2. **We spawn `next dev` ourselves rather than using Playwright's `webServer`.** Playwright starts
//     `webServer` and waits for it to answer BEFORE it runs globalSetup — so a server that needs the database
//     this function provisions can never become healthy, and the run deadlocks. Owning the process here means
//     provision → boot → test → tear down is simply top-to-bottom, and one place owns the teardown.
//
// The browser gets its session from the real `/dev-session` route (`?user=&org=`), so the cookie is minted by
// the production signer — a fixture that minted with a re-implementation of the token format would be free to
// drift from the code it is meant to be testing.

const BOOT_TIMEOUT_MS = 180_000;

/**
 * Miniflare validates a hyperdrive binding's local connection string and REFUSES one without a password
 * ("You must provide a password — e.g. 'user:password@host:port/db'"), so `next dev` throws
 * `ERR_VALIDATION` on the first tenant query rather than connecting.
 *
 * The test cluster authenticates with `trust`, so its URLs carry no password and Postgres ignores whatever
 * one we send. Supplying a dummy therefore satisfies Miniflare's schema and changes nothing about how the
 * connection actually authenticates. A managed Postgres (CI's `TEST_DATABASE_URL`) already carries a real
 * password, and we leave it alone.
 */
function withDummyPasswordForMiniflare(url: string): string {
  const parsed = new URL(url);
  if (parsed.password === "") parsed.password = "trust-auth-ignores-this";
  return parsed.toString();
}

async function seedUser(owner: Sql, id: string, name: string, email: string): Promise<void> {
  await owner`
    insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
    values (${id}, ${name}, ${email}, ${true}, now())`;
}

/** Seed two humans and two orgs, and return what the specs need to address them. */
async function seed(appUrl: string, ownerUrl: string): Promise<Fixture> {
  const owner = createClient(ownerUrl, { max: 1 });
  const app = createClient(appUrl, { max: 1 });
  try {
    // Dana owns Alpha and is a plain MEMBER of Beta; Robin owns Beta and has no membership in Alpha at all.
    // That shape is what lets the suite exercise the things that actually matter: multi-org switching, a role
    // gate (member vs owner), and cross-tenant isolation — including the same human, same browser, acting in
    // a different org, which is the case a single-tenant fixture can never reach.
    await seedUser(owner, "usr_dana", "Dana Kessler", "dana@alpha.test");
    await seedUser(owner, "usr_robin", "Robin Vale", "robin@beta.test");
    await seedUser(owner, "usr_sam", "Sam Ortiz", "sam@beta.test");

    const alpha = await createOrgWithOwner(app, {
      slug: "alpha-e2e",
      name: "Alpha",
      ownerUserId: "usr_dana",
    });
    const beta = await createOrgWithOwner(app, {
      slug: "beta-e2e",
      name: "Beta",
      ownerUserId: "usr_robin",
    });

    // Dana and Sam are both plain members of Beta. Sam exists so the removal spec has someone to remove
    // without destroying the membership the other specs depend on.
    await withTenant(app, beta.id, async (tx) => {
      await tx`insert into memberships (org_id, user_id, role) values (${beta.id}, ${"usr_dana"}, ${"member"})`;
      await tx`insert into memberships (org_id, user_id, role) values (${beta.id}, ${"usr_sam"}, ${"member"})`;
    });

    return {
      appConnectionString: appUrl,
      users: {
        dana: { id: "usr_dana", name: "Dana Kessler", email: "dana@alpha.test" },
        robin: { id: "usr_robin", name: "Robin Vale", email: "robin@beta.test" },
        sam: { id: "usr_sam", name: "Sam Ortiz", email: "sam@beta.test" },
      },
      orgs: {
        alpha: { id: alpha.id, slug: "alpha-e2e", name: "Alpha" },
        beta: { id: beta.id, slug: "beta-e2e", name: "Beta" },
      },
    };
  } finally {
    await owner.end({ timeout: 5 }).catch(() => {});
    await app.end({ timeout: 5 }).catch(() => {});
  }
}

/** Boot `next dev` against the seeded database and resolve once it answers. */
async function startDevServer(appConnectionString: string): Promise<ChildProcess> {
  // `-H 127.0.0.1` is not cosmetic. Next builds `request.url` from the hostname it was bound to, not from the
  // request's Host header, so a server bound to the default `localhost` makes /dev-session redirect to
  // `http://localhost:3100/` even when the browser asked 127.0.0.1 — and Chromium resolves `localhost` to
  // `::1`, where Next is not listening. The navigation then dies with ERR_CONNECTION_REFUSED mid-chain.
  // Binding the same host the suite drives keeps the origin (and therefore the cookie) consistent.
  const child = spawn("pnpm", ["exec", "next", "dev", "-H", "127.0.0.1", "-p", String(PORT)], {
    stdio: ["ignore", "inherit", "inherit"],
    // `detached` puts the child in its own PROCESS GROUP, and teardown signals the group (`-pid`). Without it
    // we would SIGTERM the `pnpm` wrapper and leave the `next dev` it spawned holding port 3100 — the next run
    // then fails to bind, or worse, silently talks to the PREVIOUS run's server and its dead database.
    detached: true,
    env: {
      ...process.env,
      NODE_ENV: "development",
      CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_TENANT: appConnectionString,
      // Pin the signing secret rather than leaning on env.ts's dev fallback, so the token /dev-session hands
      // the browser is verified against a secret this run chose.
      SESSION_TOKEN_SECRET: "e2e-only-session-secret-do-not-use-anywhere-else",
      // The positive opt-in /dev-session demands before it will mint an arbitrary principal. Nothing else in
      // the repo sets this, and no deployment path can.
      DEV_SESSION_PRINCIPAL_OVERRIDE: "1",
      // Where the gate sends an unauthenticated request. Nothing listens there, deliberately: the specs
      // assert on the redirect itself, and a dead origin makes an accidental follow fail loudly rather than
      // wander off into a real auth server.
      AUTH_BASE_URL: "http://127.0.0.1:3199",
    },
  });

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`e2e: next dev exited with code ${child.exitCode} before it answered`);
    }
    try {
      // Readiness means "compiled AND serving correctly", so the probe demands the 307 that /dev-session
      // actually returns. Accepting any status would let a 500 — a broken Hyperdrive binding, a failed
      // compile — count as booted, and every spec would then fail with a confusing symptom far from the
      // cause. (The probe sends no `?user=`/`?org=`, so it is the default-principal path and needs no seed.)
      const res = await fetch(`${BASE_URL}/dev-session`, { redirect: "manual" });
      if (res.status === 307) return child;
      throw new Error(
        `e2e: /dev-session answered ${res.status}, expected 307 — the dev server booted but is not healthy`,
      );
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("e2e:")) {
        killTree(child);
        throw err;
      }
      /* not listening yet */
    }
    await sleep(250);
  }

  killTree(child);
  throw new Error(`e2e: next dev did not answer on ${BASE_URL} within ${BOOT_TIMEOUT_MS}ms`);
}

/** SIGTERM the child's whole process group — see `detached` above. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM"); // group already gone
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const pg: EphemeralPostgres = await startEphemeralPostgres();
  await setupSchema(pg);

  const appUrl = pg.urlFor({ role: DB_ROLES.app });
  const fixture = await seed(appUrl, pg.urlFor({ role: DB_ROLES.owner }));
  writeFixture(fixture);

  const server = await startDevServer(withDummyPasswordForMiniflare(appUrl));

  // Playwright runs a function returned from globalSetup as the global teardown. That is what keeps the
  // cluster's and the server's lifetimes tied to the run, rather than leaking a stray postgres and a stray
  // Next process on every invocation.
  return async () => {
    killTree(server);
    await pg.stop();
  };
}
