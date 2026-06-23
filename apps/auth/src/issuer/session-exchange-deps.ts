// A-SX-2a — wires /session/exchange's seams: consume on the webhook_app tenant pool (the org-embedded ticket
// resolves the tenant), and the profile read on the webhook_auth identity pool (the global `user` table). No
// provider helpers, so this needs no `cloudflare:workers`; it's mounted in issuer-handler for consistency.
// I/O glue (two pools + the pepper secret) — typecheck-/build:cf-/deploy:dry-verified.

import {
  consumeSessionExchange,
  createClient,
  createCredentialHasherFromBase64,
  getAuthUserProfile,
} from "@webhook-co/db";
import { readSecretBinding } from "@webhook-co/shared";

import { redeemSessionExchange, type SessionPrincipal } from "./session-exchange-core";
import type { SessionExchangeRouteDeps } from "./session-exchange-route";
import { APP_BASE_URL } from "../runtime/urls";
import { readSessionExchangeEnv, type SessionExchangeEnv } from "../runtime/env";

export interface SessionExchangeDeps {
  deps: SessionExchangeRouteDeps;
  /** Drain both per-request pools (call via ctx.waitUntil after the response). */
  close: () => Promise<void>;
}

/** Build the /session/exchange deps for one request. */
export async function makeSessionExchangeDeps(
  env: SessionExchangeEnv,
): Promise<SessionExchangeDeps> {
  const hasher = createCredentialHasherFromBase64(await readSecretBinding(env.CREDENTIAL_PEPPER));
  // webhook_app (tenant, RLS) consumes the ticket. The webhook_auth (identity) pool is only needed AFTER a
  // ticket consumes (the profile read), so open it LAZILY: a bad/expired ticket (the 401 path) never opens
  // it, and a failure opening it can't strand `app` (no eager two-pool ctor leak).
  const app = createClient(env.HYPERDRIVE_TENANT.connectionString, { max: 2 });
  let authClient: ReturnType<typeof createClient> | undefined;
  const getAuthClient = () =>
    (authClient ??= createClient(env.HYPERDRIVE_AUTH.connectionString, { max: 2 }));

  // The app. origin the ticket is audience-bound to — the TRUSTED server-side value (never a request
  // header), env-driven so it stays SYMMETRIC with the handoff's mint audience (session-handoff-deps).
  // Defaults to the prod host; set APP_BASE_URL in dev so a localhost-minted ticket redeems.
  const expectedAudience = env.APP_BASE_URL ?? APP_BASE_URL;

  const deps: SessionExchangeRouteDeps = {
    // The audience match is in consume's WHERE, so a ticket can only be redeemed by the app. it was minted
    // for (the value above must equal what session-handoff-deps minted with).
    consume: (ticket) => consumeSessionExchange(app, ticket, hasher, expectedAudience),
    getProfile: (userId) => getAuthUserProfile(getAuthClient(), userId),
    log: (event, fields) => console.log(JSON.stringify({ message: event, ...fields })),
  };

  return {
    deps,
    close: async () => {
      await Promise.allSettled(
        [app.end(), authClient?.end()].filter(Boolean) as Promise<unknown>[],
      );
    },
  };
}

/**
 * The service-binding redeem (the SessionExchange WorkerEntrypoint's logic). app. RPCs this over a Cloudflare
 * service binding instead of the public `POST /session/exchange` HTTP route, so /session/exchange need not stay
 * publicly exposed. It validates the env, builds the SAME redeem deps the HTTP route uses, redeems through the
 * SAME shared core (redeemSessionExchange), and returns the principal — or `null` for an invalid/expired/used/
 * wrong-audience ticket OR the user-missing edge (both collapse to null: app. redirects to login either way).
 * The per-request pools are always drained before returning (no waitUntil needed — the RPC awaits the result).
 *
 * worker.ts (tsc-excluded for its generated-handler import) calls this from a thin WorkerEntrypoint, mirroring
 * how IssuerIntrospect delegates to introspect — so the real logic stays in this type-checked + tested module.
 */
export async function redeemSessionExchangeRpc(
  env: Record<string, unknown>,
  ticket: string,
): Promise<SessionPrincipal | null> {
  if (typeof ticket !== "string" || ticket.length === 0) return null;
  const { deps, close } = await makeSessionExchangeDeps(readSessionExchangeEnv(env));
  try {
    const result = await redeemSessionExchange(deps, ticket);
    return result.status === "ok" ? result.principal : null;
  } finally {
    await close().catch((error: unknown) =>
      console.log(
        JSON.stringify({ message: "session_exchange.rpc_pool_close_failed", error: String(error) }),
      ),
    );
  }
}
