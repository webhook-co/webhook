// A2b-1 — the auth.webhook.co Worker entry: wrap the OpenNext handler with the OAuth issuer.
//
// `@cloudflare/workers-oauth-provider` serves its own /oauth/token (opaque, server-side), DCR /register,
// the /authorize parse, and discovery + RFC 9728 PRM (.well-known/*). Everything else falls through to the
// issuer defaultHandler (A2b-2b): it intercepts Lane C's frozen /token (which uses the provider's
// getOAuthApi helpers — wrangler-bundled here, so `cloudflare:workers` resolves; OpenNext's esbuild can't)
// and delegates the rest to OpenNext — the pages, /api/auth/* (Better Auth), the /authorize consent UI.
// Pure issuer: no apiHandler (this Worker is the authorization server, not a resource server).
//
// It also exports the IssuerIntrospect WorkerEntrypoint (A2b-5): mcp (A8) RPCs it over a service binding to
// validate opaque provider tokens (KV-bound to THIS Worker, so mcp can't validate them locally). The class
// + the cloudflare:workers import live here (excluded) because apps/auth is DOM-typed; the logic is the
// type-checked ./issuer/introspect-* modules.
//
// This file is EXCLUDED from tsconfig: it imports the generated `.open-next/worker.js` (produced by
// `opennextjs-cloudflare build`, gitignored, absent at CI typecheck). The workerd bundle is gated by the
// `build-cf` CI job + verified end-to-end by `deploy:dry`. The dispatch + config live in ./issuer
// (type-checked + unit-tested).

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";

import openNextHandler from "../.open-next/worker.js";
import { listUserConnectedApps, revokeUserConnectedApp } from "./issuer/connected-apps-handler";
import { introspect } from "./issuer/introspect-handler";
import { makeIssuerDefaultHandler } from "./issuer/issuer-handler";
import { nowSeconds } from "./issuer/issuer-constants";
import { oauthIssuerConfig } from "./issuer/oauth-config";
import { augmentAsMetadataResponse } from "./issuer/as-metadata";
import { guardRegister } from "./issuer/register-guard";
import type { RateLimitKv } from "./issuer/rate-limit";
import { deleteAccountRpc } from "./issuer/account-delete-deps";
import { redeemSessionExchangeRpc } from "./issuer/session-exchange-deps";
import { readIntrospectEnv } from "./runtime/env";
import { runNotificationDrain } from "./runtime/notify-cron";
import { runAuthExpirySweep } from "./runtime/sweep-cron";

// The OAuth issuer instance — @cloudflare/workers-oauth-provider wrapping the OpenNext handler (A2b-1). We
// keep a reference rather than exporting it directly because the default export now also carries a
// scheduled() handler (the expiry cron, ADR-0055): the export below delegates fetch to this provider
// VERBATIM (so every OAuth + OpenNext route behaves exactly as before) and adds scheduled() alongside it.
const provider = new OAuthProvider({
  ...oauthIssuerConfig,
  defaultHandler: makeIssuerDefaultHandler(openNextHandler),
});

export default {
  fetch: async (request, env, ctx) => {
    // Throttle the provider-owned DCR endpoint (POST /register) before delegating — it's public,
    // unauthenticated, and otherwise unthrottled. Fails open (unbound KV / absent IP / KV fault); a
    // non-/register request returns null and falls straight through to the provider.
    const limited = await guardRegister(
      { kv: env.RATELIMIT_KV as RateLimitKv | undefined, nowSeconds },
      request,
    );
    if (limited) return limited;
    const response = await provider.fetch(request, env, ctx);
    // RFC 9207: we stamp `iss` onto every authorization response (consent-core), and an AS that does so MUST
    // advertise it. The provider generates the AS-metadata document itself and offers no hook to extend it,
    // so we merge the advertisement into its response here. Every other path passes through untouched.
    return augmentAsMetadataResponse(request, response);
  },

  // Hourly cron (crons: "0 * * * *"). Two independent, non-throwing jobs (each logs + swallows its own
  // errors); both are waitUntil'd so the isolate lives until they + their pool-close finish.
  scheduled: (event, env, ctx) => {
    // The notification drain runs EVERY hour, so an auto-disable owner email is at most ~1h late (S3 PR3c-3b).
    ctx.waitUntil(runNotificationDrain(env));
    // The cross-org expiry sweep (ADR-0055) is a DAILY job — gate it to the 04:00 UTC firing (a low-traffic
    // window; the on-access per-org sweep handles active orgs, so this only mops up churned ones).
    if (new Date(event.scheduledTime).getUTCHours() === 4) {
      ctx.waitUntil(runAuthExpirySweep(env));
    }
  },
};

/**
 * RFC 7662 token introspection over a service binding (A2b-5, the A8 dependency). mcp validates any bearer
 * it didn't mint — an opaque provider token — by calling `env.<binding>.introspect(token)`; the binding +
 * its `entrypoint: "IssuerIntrospect"` are wired on the mcp side (A8). Runs in this Worker with OAUTH_KV.
 */
export class IssuerIntrospect extends WorkerEntrypoint {
  async introspect(token) {
    return introspect(readIntrospectEnv(this.env), token);
  }
}

/**
 * The auth.→app. session-handoff redeem over a service binding — the ONLY redeem path in prod. app. (apps/web)
 * RPCs `env.AUTH_SESSION_EXCHANGE.exchange(ticket)` to redeem the single-use handoff ticket directly, never
 * touching a public HTTP route. The public POST /session/exchange route is RETIRED to a 404 on the prod host
 * (isPublicSessionExchangeRetired) and survives only for LOCAL DEV / PREVIEW, which has no service bindings.
 * Returns the principal { orgId, userId, name, email, image } or null (invalid/expired/used/wrong-audience/
 * user-missing). The binding + its `entrypoint: "SessionExchange"` are wired on the web side (deploy overlay).
 * Runs in this Worker with HYPERDRIVE_TENANT/HYPERDRIVE_AUTH + CREDENTIAL_PEPPER. Delegates to the type-checked
 * + tested redeemSessionExchangeRpc (this file is tsc-excluded), mirroring how IssuerIntrospect delegates to introspect.
 */
export class SessionExchange extends WorkerEntrypoint {
  async exchange(ticket) {
    return redeemSessionExchangeRpc(this.env, ticket);
  }
}

// AccountDeleter (slice 2.2): the web→auth account-erasure RPC. apps/web verifies the session and
// passes its OWN authenticated userId over this worker-to-worker binding (never public), so a user
// can only erase themselves. Only this Worker (webhook_auth via HYPERDRIVE_AUTH) may delete from the
// global identity realm; the web caller has already deleted any org the user solely owns first.
export class AccountDeleter extends WorkerEntrypoint {
  async deleteAccount(userId) {
    return deleteAccountRpc(this.env, userId);
  }
}

// ConnectedApps: the web→auth "connected apps" RPC. A user's active OAuth grants (the third-party MCP
// clients they authorized) live in this Worker's OAUTH_KV — the web dashboard can't read them locally, so it
// calls this binding. apps/web verifies the session and passes its OWN authenticated userId (never
// client-supplied), and the provider's revokeGrant is keyed by (grantId, userId), so a user can only ever
// list/revoke their own grants. Runs in this Worker with OAUTH_KV. Delegates to the type-checked handlers.
export class ConnectedApps extends WorkerEntrypoint {
  async list(userId) {
    return listUserConnectedApps(readIntrospectEnv(this.env), userId);
  }
  async revoke(userId, grantId) {
    return revokeUserConnectedApp(readIntrospectEnv(this.env), userId, grantId);
  }
}
