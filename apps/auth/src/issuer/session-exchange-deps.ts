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

import type { SessionExchangeRouteDeps } from "./session-exchange-route";
import { APP_BASE_URL } from "../runtime/urls";
import type { SessionExchangeEnv } from "../runtime/env";

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

  const deps: SessionExchangeRouteDeps = {
    // expectedAudience is the TRUSTED server-side constant APP_BASE_URL — never a request header — so a
    // ticket can only be redeemed by the app. it was minted for (the audience match is in consume's WHERE).
    consume: (ticket) => consumeSessionExchange(app, ticket, hasher, APP_BASE_URL),
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
