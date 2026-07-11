import { makeAuth, type AuthExecutionContext, type RuntimeAuth } from "../runtime/auth";
import type { AuthEnv } from "../runtime/env";
import { LOGIN_PATH } from "../runtime/urls";
import type { LogoutRouteDeps } from "./logout-route";

/** The /logout deps plus the pool-close hook the mount drains via ctx.waitUntil. */
export interface LogoutDeps {
  deps: LogoutRouteDeps;
  close: () => Promise<void>;
}

/**
 * Build the GET /logout deps for one request.
 *
 * Only the Better Auth runtime is needed — no tenant pool, no pepper: signing out reads the session cookie
 * and deletes the session row, and touches nothing tenant-scoped. Built lazily so a logout with no session
 * still pays for only the one call.
 *
 * Lands on the bare `/login` (no `?redirect=`): after signing out there is deliberately nothing to return
 * to, and a `redirect` param here would be a live bounce target for a user who no longer has a session.
 */
export async function makeLogoutDeps(
  env: AuthEnv,
  ctx?: AuthExecutionContext,
): Promise<LogoutDeps> {
  let auth: RuntimeAuth | undefined;
  const getAuth = async () => (auth ??= await makeAuth(env, ctx));

  const deps: LogoutRouteDeps = {
    signOut: async (request) => (await getAuth()).signOut(request),
    loginUrl: () => LOGIN_PATH,
    log: (event, fields) => console.log(JSON.stringify({ message: event, ...fields })),
  };

  return { deps, close: async () => auth?.close() };
}
