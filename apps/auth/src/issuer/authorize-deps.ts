// A3d — wires authorize-route's injected seams to the REAL provider + Better Auth session + Lane B db +
// the consent cores. I/O glue (provider helpers, the session runtime, a DB pool, Secrets Store), so it's
// not unit-tested; it's typecheck- + build:cf- + deploy:dry-verified. All the testable logic (the consent
// cores, the ticket codec, getConsentOrg) is covered in its own modules.
//
// Like token-deps (ADR-0029), this runs in the wrangler layer (getOAuthApi eagerly imports
// `cloudflare:workers`), so it's imported only by issuer-handler/worker.ts, never by `next build`.

import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { CAPABILITY_REGISTRY } from "@webhook-co/contract";
import { API_RESOURCE, MCP_RESOURCE, createClient, getConsentOrg } from "@webhook-co/db";
import { b64ToBytes, readSecretBinding } from "@webhook-co/shared";

import { buildConsent, decideConsent } from "./consent-core";
import { importConsentTicketKey, signConsentTicket, verifyConsentTicket } from "./consent-ticket";
import { oauthIssuerConfig } from "./oauth-config";
import type { AuthorizeRouteDeps } from "./authorize-route";
import { LOGIN_PATH } from "../runtime/urls";
import { makeAuth, type AuthExecutionContext, type RuntimeAuth } from "../runtime/auth";
import type { AuthorizeEnv } from "../runtime/env";

const KEY_TTL_SECONDS = 86_400; // the 24h whk_ key the screen advertises (matches token-deps).
const GRANT_TTL_SECONDS = 7_776_000; // ~90d grant/refresh ceiling (matches token-deps GRANT_TTL_SECONDS).
// The consent ticket is short-lived: the user has 5 min to decide (mirrors the magic-link window). The
// resulting auth code is single-use (the provider), so this only bounds the decision round-trip.
const TICKET_TTL_SECONDS = 300;
const CONSENT_PATH = "/consent";

/** The capability scope set a consent may ever grant — the SoT (matches oauth-config + token-deps). */
const CAPABILITY_SCOPES = [
  ...new Set([...CAPABILITY_REGISTRY.values()].map((c) => c.auth.scope)),
].sort();

// getOAuthApi needs a full OAuthProviderOptions; the helpers we use (parseAuthRequest/lookupClient/
// completeAuthorization) work off OAUTH_KV + the request and never invoke defaultHandler, so a never-called
// 404 stub completes the options without pulling the OpenNext handler into this module.
const HELPERS_DEFAULT_HANDLER = { fetch: async () => new Response(null, { status: 404 }) };

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** A best-effort request-origin trust signal from the edge headers (no @cloudflare/workers-types needed). */
function resolveOrigin(request: Request): { ip: string; location: string | null } {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const country = request.headers.get("cf-ipcountry");
  // CF uses "XX"/"T1" for unknown/Tor — treat those as no location rather than a misleading code.
  const location = country && !["XX", "T1"].includes(country) ? country : null;
  return { ip, location };
}

export interface AuthorizeDeps {
  deps: AuthorizeRouteDeps;
  /** Drain the per-request pools (call via ctx.waitUntil after the response). */
  close: () => Promise<void>;
}

/** Build the consent-flow deps for one /authorize or /consent/decision request. */
export async function makeAuthorizeDeps(
  env: AuthorizeEnv,
  ctx?: AuthExecutionContext,
): Promise<AuthorizeDeps> {
  const ticketKey = await importConsentTicketKey(
    b64ToBytes(await readSecretBinding(env.CONSENT_TICKET_KEY)),
  );
  // getOAuthApi only wires KV-backed helpers (no pool, no secret) — cheap, and parseAuthRequest needs it
  // first, so it's eager.
  const helpers = getOAuthApi(
    { ...oauthIssuerConfig, defaultHandler: HELPERS_DEFAULT_HANDLER },
    env as never,
  );

  // The Better Auth runtime (7 secret reads + a pool) and the tenant pool are the expensive parts, and the
  // unauthenticated GET /authorize (the hot first hit) only redirects to login — and a parse failure 400s
  // even earlier. So build both LAZILY, on first use: a parse-failure pays for neither; an unauthenticated
  // hit pays only for the session runtime; only an authenticated, valid request opens the tenant pool.
  // (Durable rate-limiting is still the primary DoS mitigation — deferred to the deploy slice.)
  let auth: RuntimeAuth | undefined;
  const getAuth = async () => (auth ??= await makeAuth(env, ctx));
  let app: ReturnType<typeof createClient> | undefined;
  const getApp = () => (app ??= createClient(env.HYPERDRIVE_TENANT.connectionString, { max: 2 }));

  const log = (event: string, fields?: Record<string, unknown>) =>
    console.log(JSON.stringify({ message: event, ...fields }));

  const deps: AuthorizeRouteDeps = {
    parseAuthRequest: (request) => helpers.parseAuthRequest(request),
    getSessionUserId: async (request) =>
      (await (await getAuth()).getSession(request))?.userId ?? null,
    resolveOrigin,
    loginUrl: (returnTo) => `${LOGIN_PATH}?redirect=${encodeURIComponent(returnTo)}`,

    buildConsent: (request, userId, origin) =>
      buildConsent(
        {
          allowedAudiences: [API_RESOURCE, MCP_RESOURCE],
          allowedScopes: CAPABILITY_SCOPES,
          keyTtlSeconds: KEY_TTL_SECONDS,
          grantTtlSeconds: GRANT_TTL_SECONDS,
          ticketTtlSeconds: TICKET_TTL_SECONDS,
          consentPath: CONSENT_PATH,
          lookupClientName: async (clientId) =>
            (await helpers.lookupClient(clientId))?.clientName ?? null,
          getConsentOrg: (uid) => getConsentOrg(getApp(), uid),
          signTicket: (payload) => signConsentTicket(payload, ticketKey),
          newCsrf: () => crypto.randomUUID(),
          nowSeconds,
          log,
        },
        request,
        userId,
        origin,
      ),

    decideConsent: (input) =>
      decideConsent(
        {
          verifyTicket: (ticket) => verifyConsentTicket(ticket, ticketKey, nowSeconds()),
          completeAuthorization: (opts) => helpers.completeAuthorization(opts),
          log,
        },
        input,
      ),
  };

  return {
    deps,
    // Drain whatever was actually opened (either may be undefined if its path wasn't taken).
    close: async () => {
      await Promise.allSettled([app?.end(), auth?.close()].filter(Boolean) as Promise<unknown>[]);
    },
  };
}
