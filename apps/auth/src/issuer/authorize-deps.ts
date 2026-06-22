// A3d — wires authorize-route's injected seams to the REAL provider + Better Auth session + Lane B db +
// the consent cores. I/O glue (provider helpers, the session runtime, a DB pool, Secrets Store), so it's
// not unit-tested; it's typecheck- + build:cf- + deploy:dry-verified. All the testable logic (the consent
// cores, the ticket codec, getConsentOrg) is covered in its own modules.
//
// Like token-deps (ADR-0029), this runs in the wrangler layer (getOAuthApi eagerly imports
// `cloudflare:workers`), so it's imported only by issuer-handler/worker.ts, never by `next build`.

import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { API_RESOURCE, MCP_RESOURCE, createClient, getConsentOrg } from "@webhook-co/db";
import { b64ToBytes, readSecretBinding } from "@webhook-co/shared";

import { signLoopbackTicket, verifyLoopbackTicket } from "./completion-ticket";
import { buildConsent, decideConsent } from "./consent-core";
import { importConsentTicketKey, signConsentTicket, verifyConsentTicket } from "./consent-ticket";
import { isAllowedRedirectUri } from "./dcr";
import { makeDeviceStoreDeps } from "./device-deps";
import { setDeviceDecision } from "./device-store";
import {
  CONSENT_PATH,
  GRANT_TTL_SECONDS,
  HELPERS_DEFAULT_HANDLER,
  KEY_TTL_SECONDS,
  TICKET_TTL_SECONDS,
  nowSeconds,
  resolveOrigin,
} from "./issuer-constants";
import { CAPABILITY_SCOPES, oauthIssuerConfig } from "./oauth-config";
import type { AuthorizeRouteDeps } from "./authorize-route";
import { LOGIN_PATH } from "../runtime/urls";
import { makeAuth, type AuthExecutionContext, type RuntimeAuth } from "../runtime/auth";
import type { AuthorizeEnv } from "../runtime/env";

/** The loopback-completion bounce ticket's TTL — the bounce navigation is immediate; 2 min is ample slack. */
const COMPLETION_TICKET_TTL_SECONDS = 120;

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
          // A4c — a device-code ticket records its decision against the device store (no provider grant).
          setDeviceDecision: (userCode, decision) =>
            setDeviceDecision(makeDeviceStoreDeps(env.DEVICE_KV), userCode, decision),
          log,
        },
        input,
      ),

    // The loopback bounce: sign the server-computed loopback redirect into a same-origin /consent/complete
    // ticket; on the way back, verify it and re-assert it's a loopback literal (defense in depth — we only
    // ever sign such URLs) before GET /consent/complete 302s to it.
    sealLoopbackRedirect: async (redirectTo) => {
      const ticket = await signLoopbackTicket(
        redirectTo,
        ticketKey,
        nowSeconds() + COMPLETION_TICKET_TTL_SECONDS,
      );
      return `/consent/complete?c=${encodeURIComponent(ticket)}`;
    },
    openLoopbackRedirect: async (ticket) => {
      const url = await verifyLoopbackTicket(ticket, ticketKey, nowSeconds());
      return url && isAllowedRedirectUri(url) ? url : null;
    },
  };

  return {
    deps,
    // Drain whatever was actually opened (either may be undefined if its path wasn't taken).
    close: async () => {
      await Promise.allSettled([app?.end(), auth?.close()].filter(Boolean) as Promise<unknown>[]);
    },
  };
}
