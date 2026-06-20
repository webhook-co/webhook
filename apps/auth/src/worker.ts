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
import { readIntrospectEnv } from "./runtime/env";

export default new OAuthProvider({
  ...oauthIssuerConfig,
  defaultHandler: makeIssuerDefaultHandler(openNextHandler),
});

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
