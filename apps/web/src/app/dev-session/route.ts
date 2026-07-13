import { NextResponse } from "next/server";
import { sessionCookieOptions } from "@/server/session-cookie";

import { getSessionSecret } from "@/server/env";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, type Session } from "@/server/session";
import { signSessionToken } from "@/server/session-token";

// dal-gate-allow: dev-only pre-auth bootstrap — 404 in prod, mints no real identity.
//
// Dev-only: mint a session for a mock principal so the gated dashboard is reachable without running the
// full auth.→app. handoff locally. Now that the gate VERIFIES the cookie value (E7), this mints a real
// signed token (the dev secret) rather than the old opaque "dev-mock" string. Returns 404 in production —
// there is no production path that sets the session cookie except the A-SX handoff, so prod is fail-closed.
// The 404 is checked BEFORE the query string is read, so `?user=&org=` is not a way in.
//
// `?user=<id>&org=<uuid>` overrides the principal, behind an explicit `DEV_SESSION_PRINCIPAL_OVERRIDE=1` (see
// below). This is the seam the Playwright suite seeds its two-org fixture through: rather than
// re-implementing the token format in test code — a fixture that mints with code that isn't the code under
// test can silently drift from it — the browser gets a cookie from the REAL signer, on the real route.
//
// The org id must be a UUID, and that is not cosmetic. `orgs.id` is `uuid`, and the RLS GUC is read back as
// `nullif(current_setting('app.current_org', true), '')::uuid` (migration 0003), so a non-UUID org id is a
// `22P02 invalid input syntax for type uuid` the moment any tenant query runs. The old fixed principal used
// `org_dev_local`, so this route could only ever address an absent tenant.
//
// ⚠️ The DEFAULT principal only gets you a rendered dashboard if its org and membership actually exist in
// your local database — nothing in the repo seeds them. Since ADR-0116 every gated page re-reads membership,
// so a session naming an org you are not a member of is refused and you land back at sign-in. That is the
// gate working, not a bug: pass `?user=&org=` for a principal you have really seeded (which is what the e2e
// harness does), or seed a membership for this default one.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEV_PRINCIPAL: Session = {
  userId: "usr_dev_local",
  // A real UUID, so the default principal can actually address a tenant (see above).
  orgId: "00000000-0000-4000-8000-00000000d0e5",
  user: { name: "Dana (dev)", email: "dana@dev.local", image: null },
};

export async function GET(request: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("Not found", { status: 404 });
  }

  const url = new URL(request.url);
  const wantsOverride = url.searchParams.has("user") || url.searchParams.has("org");

  // TWO independent gates on the principal override, not one.
  //
  // The 404 above is already build-time constant-folded — @opennextjs/cloudflare's esbuild config `define`s
  // `process.env.NODE_ENV` to the literal `"production"` unconditionally, so in any deployed artifact this
  // route reads `"production" === "production"` and returns 404 before it ever looks at the query string. No
  // Cloudflare var, secret, or misconfiguration can flip it, because it is not a runtime lookup.
  //
  // But that single check is now the only thing between an unauthenticated caller and a validly-signed cookie
  // for ANY user in ANY org — a much bigger prize than the old fixed dev principal, which named a tenant that
  // doesn't exist. So the override demands a POSITIVE opt-in as well: an env var nothing sets by default, and
  // that no deployment path sets at all. Two gates, and the escalation needs both to fail.
  if (wantsOverride && process.env.DEV_SESSION_PRINCIPAL_OVERRIDE !== "1") {
    return new NextResponse(
      "dev-session: principal override requires DEV_SESSION_PRINCIPAL_OVERRIDE=1",
      { status: 403 },
    );
  }

  const userId = url.searchParams.get("user") ?? DEV_PRINCIPAL.userId;
  const orgId = url.searchParams.get("org") ?? DEV_PRINCIPAL.orgId;

  if (userId.trim() === "") {
    return new NextResponse("dev-session: `user` must not be empty", { status: 400 });
  }
  if (!UUID_RE.test(orgId)) {
    return new NextResponse("dev-session: `org` must be a UUID", { status: 400 });
  }

  const session: Session = { ...DEV_PRINCIPAL, userId, orgId };
  const token = await signSessionToken(session, await getSessionSecret(), SESSION_TTL_SECONDS);

  // A RELATIVE Location, deliberately. `NextResponse.redirect(new URL("/", request.url))` would be absolute,
  // and under `next dev` Next builds `request.url` from its own default hostname rather than the request's
  // Host header — so a browser that asked for 127.0.0.1 is sent to `http://localhost:3100/`, which Chromium
  // resolves to `::1`, where nothing is listening. A relative Location is origin-agnostic, valid per RFC 7231
  // §7.1.2, and behaves identically in production.
  const res = new NextResponse(null, { status: 307, headers: { Location: "/" } });
  // The same attributes every other set/delete uses. Dev-only route (it 404s in prod above), so this
  // resolves to `secure: false` — the cookie is only ever set over http://localhost.
  res.cookies.set(SESSION_COOKIE, token, {
    ...sessionCookieOptions(),
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}
