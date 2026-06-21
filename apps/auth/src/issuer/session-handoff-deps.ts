// A-SX-2b — wires /session/handoff's seams: the session (makeAuth) + the org resolution + the exchange mint
// (both webhook_app). No provider helpers, so no `cloudflare:workers`; mounted in issuer-handler for
// consistency. I/O glue — typecheck-/build:cf-/deploy:dry-verified.

import {
  createClient,
  createCredentialHasherFromBase64,
  getConsentOrg,
  mintSessionExchange,
} from "@webhook-co/db";
import { readSecretBinding } from "@webhook-co/shared";

import type { SessionHandoffRouteDeps } from "./session-handoff-route";
import { makeAuth, type AuthExecutionContext, type RuntimeAuth } from "../runtime/auth";
import type { AuthEnv } from "../runtime/env";
import { APP_BASE_URL, LOGIN_PATH } from "../runtime/urls";

// Short — the handoff happens immediately after login; a tight window bounds the front-running exposure of
// the ticket that transits app.'s callback URL (ADR-0033).
const EXCHANGE_TTL_SECONDS = 60;

export interface SessionHandoffDeps {
  deps: SessionHandoffRouteDeps;
  close: () => Promise<void>;
}

/** Build the /session/handoff deps for one request. The handoff env is just AuthEnv (session + tenant +
 * pepper), so the mount reads it with readAuthEnv. */
export async function makeSessionHandoffDeps(
  env: AuthEnv,
  ctx?: AuthExecutionContext,
): Promise<SessionHandoffDeps> {
  const hasher = createCredentialHasherFromBase64(await readSecretBinding(env.CREDENTIAL_PEPPER));

  // The app. origin the ticket targets + is audience-bound to. Defaults to the prod host; set
  // APP_BASE_URL in dev (.dev.vars) so the handoff redirects to localhost:3000 instead of app.webhook.co.
  const appBaseUrl = env.APP_BASE_URL ?? APP_BASE_URL;

  // The session runtime + tenant pool are the expensive parts; build lazily so a no-session visit (the
  // login bounce) pays for neither beyond the session check.
  let auth: RuntimeAuth | undefined;
  const getAuth = async () => (auth ??= await makeAuth(env, ctx));
  let app: ReturnType<typeof createClient> | undefined;
  const getApp = () => (app ??= createClient(env.HYPERDRIVE_TENANT.connectionString, { max: 2 }));

  const deps: SessionHandoffRouteDeps = {
    getSessionUserId: async (request) =>
      (await (await getAuth()).getSession(request))?.userId ?? null,
    resolveOrg: (userId) => getConsentOrg(getApp(), userId),
    mint: async (orgId, userId) => {
      const minted = await mintSessionExchange(
        getApp(),
        { orgId, userId, audience: appBaseUrl, ttlSeconds: EXCHANGE_TTL_SECONDS },
        hasher,
      );
      return minted.plaintext;
    },
    loginUrl: (returnTo) => `${LOGIN_PATH}?redirect=${encodeURIComponent(returnTo)}`,
    appCallbackUrl: (ticket) => `${appBaseUrl}/auth/callback?ticket=${encodeURIComponent(ticket)}`,
    log: (event, fields) => console.log(JSON.stringify({ message: event, ...fields })),
  };

  return {
    deps,
    close: async () => {
      await Promise.allSettled([app?.end(), auth?.close()].filter(Boolean) as Promise<unknown>[]);
    },
  };
}
