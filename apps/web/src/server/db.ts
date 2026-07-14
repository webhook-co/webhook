import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { createClient, type Sql } from "@webhook-co/db/client";
import { after } from "next/server";
import { cache } from "react";

interface HyperdriveBinding {
  readonly connectionString: string;
}

/**
 * ONE tenant Postgres client per RENDER, shared by every loader in it. RLS (via the session `orgId`, pinned by
 * `withTenant`) remains the tenant-isolation backstop — this changes the connection's lifecycle, never its
 * authority.
 *
 * ── Read this before believing "one client per request" ─────────────────────────────────────────────────
 *
 * React's `cache()` memoizes against the **render pass**: it reads React's async dispatcher, and when there is
 * no dispatcher it calls straight through and memoizes NOTHING (verified in the shipped React bundle, not
 * assumed). Next installs that dispatcher for the RSC render — so on a page view, every loader in the tree
 * genuinely shares one client, which is the case that dominates and the case this exists for.
 *
 * A SERVER ACTION body runs before that render. So on the mutation path the memo may not dedupe, and an action
 * that gates (`requireOrgAccess` -> the directory read) and then writes can end up with more than one client.
 *
 * That is worth stating plainly rather than papering over, and it is also NOT a regression: before this, every
 * caller opened its own client unconditionally, so an action already paid exactly that. Each client still
 * registers its own `after()` close, so nothing leaks, and no client is ever closed by someone who does not own
 * it. The win applies to the page renders (the common path, several loaders deep); the mutation path is left
 * no worse than it was.
 *
 * The invariant that actually matters is therefore NOT "there is exactly one client" — it is "NOBODY CLOSES A
 * CLIENT THEY DID NOT OPEN". That one holds unconditionally, and it is what the tests pin.
 *
 * ── What this replaced, and why it was slow ─────────────────────────────────────────────────────────────
 *
 * Every loader used to open its OWN client and `await` its close in a `finally`. Nothing was shared, so cost
 * scaled with however many things a page happened to read:
 *
 *   * the overview page opened SIX connections — the layout's gate, the layout's org switcher, and then
 *     `loadDashboard`'s four `Promise.all`'d loaders, each opening its own;
 *   * each paid a fresh TCP + TLS + Postgres startup handshake to Hyperdrive;
 *   * each BLOCKED THE RESPONSE on `await app.end()` — the user waited on teardown that had nothing to do
 *     with rendering their page.
 *
 * ── The two things that make sharing correct ────────────────────────────────────────────────────────────
 *
 * `cache()` is React's per-request memo: every caller in one request gets the SAME client, and a second
 * request never sees the first one's. There is deliberately no module-level client — one that outlived a
 * request would be a cross-tenant hazard on Workers, not merely a leak.
 *
 * `after()` runs the close AFTER the response is flushed, and that is the part a `finally` structurally
 * cannot do. A `finally` in each loader must close while the request is still in flight — which is precisely
 * why the client could not be shared before: the first loader to finish would close it out from under the
 * others. Closing after the response gives one open, one close, and zero teardown on the hot path.
 *
 * ── The pool size is a decision, not a default ──────────────────────────────────────────────────────────
 *
 * `max: 5`, NOT `max: 1`. A single shared connection would SERIALIZE loaders that currently run concurrently:
 * the overview's four reads would go parallel -> sequential, and across a cross-region round trip that trades
 * six handshakes for four sequential queries and can land SLOWER than what it replaced. With a small pool,
 * sequential callers reuse one warm connection and concurrent callers still overlap. Five covers the widest
 * fan-out we have (four, on the overview) with one to spare.
 */
const requestTenantDb = cache(async (): Promise<Sql> => {
  const { env } = await getCloudflareContext({ async: true });
  const hyperdrive = (env as Record<string, unknown>).HYPERDRIVE_TENANT as
    HyperdriveBinding | undefined;
  if (!hyperdrive?.connectionString) {
    throw new Error("HYPERDRIVE_TENANT binding is not configured");
  }

  const app = createClient(hyperdrive.connectionString, { max: 5 });

  // Release AFTER the response, never during it. `after()` is Next's primitive for exactly this and maps onto
  // `waitUntil` on Workers.
  //
  // Note what this is NOT: a deferred WRITE on a request-scoped client. That is the trap that has bitten this
  // codebase before — a `waitUntil` task that writes must open its OWN connection, because the request's
  // client is already gone by the time it runs. Here the request is finished with the client and we are
  // closing it; there is no work left to race.
  //
  // Best-effort: a slow or failed close must never surface as an error on a response the user already has.
  after(async () => {
    await app.end({ timeout: 5 }).catch(() => {});
  });

  return app;
});

/**
 * The request's tenant client.
 *
 * Callers MUST NOT close it. The request owns its lifecycle (see `after()` above), and closing it early would
 * pull the connection out from under every other loader in the same render.
 */
export async function getTenantDb(): Promise<Sql> {
  return requestTenantDb();
}

/**
 * Run `fn` against the request's tenant client.
 *
 * The single entry point, so callers say WHAT they need rather than how the connection is managed. That is
 * what let the acquire/release policy go from six-clients-per-page to one without touching a call site.
 */
export async function withTenantDb<T>(fn: (app: Sql) => Promise<T>): Promise<T> {
  return fn(await requestTenantDb());
}

/**
 * Release the request's client EARLY, before the response is finished.
 *
 * ── Read the warning before you reach for this ──────────────────────────────────────────────────────────
 *
 * Almost nothing should. The normal contract is that you do not close what you did not open, and `after()`
 * closes it once the response is done — which is what makes the client safe to share across a render in the
 * first place. Calling this while ANYTHING else in the request still intends to query is precisely the bug the
 * `no-early-db-close` guard exists to prevent: the connection is torn out from under the other callers.
 *
 * ── The one shape where it is right: finish the DB work, then stream for a long time ────────────────────
 *
 * A route handler that reads the database and then returns a STREAM (the event-payload download) does not
 * render a layout, so it is the only consumer of the client — and its database work is completely finished
 * before the first byte of the body is sent. Left to `after()`, the connection would be held, idle, for the
 * entire duration of the download: a user on a slow link pulling a large captured payload pins a Postgres
 * connection for as long as it takes them to receive it, and enough concurrent slow downloads would starve the
 * pool for everyone else. Nothing is gained by holding it — the query is done.
 *
 * Closing twice is harmless: `after()` still fires and postgres.js's `end()` is idempotent.
 */
export async function releaseTenantDbEarly(): Promise<void> {
  const app = await requestTenantDb();
  // db-close-allow: the ONE legal early close — a streaming route handler whose DB work is finished and whose
  // response body will take an arbitrarily long time to send. See the doc comment above.
  await app.end({ timeout: 5 }).catch(() => {});
}
