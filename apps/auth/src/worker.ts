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
import { introspect } from "./issuer/introspect-handler";
import { makeIssuerDefaultHandler } from "./issuer/issuer-handler";
import { oauthIssuerConfig } from "./issuer/oauth-config";
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
  // Delegate every request to the OAuth provider unchanged — same fetch handler as before this PR.
  fetch: (request, env, ctx) => provider.fetch(request, env, ctx),

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
