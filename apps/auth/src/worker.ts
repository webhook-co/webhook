// A2b-1 — the auth.webhook.co Worker entry: wrap the OpenNext handler with the OAuth issuer.
//
// `@cloudflare/workers-oauth-provider` serves its own /oauth/token (opaque, server-side), DCR /register,
// the /authorize parse, and discovery + RFC 9728 PRM (.well-known/*); every other request falls through to
// the OpenNext handler — the pages, /api/auth/* (Better Auth), and Lane C's frozen /token + /authorize
// consent + /device/* + /revoke (later A2b/A3/A4 slices, plain Next routes). Pure issuer: no apiHandler
// (this Worker is the authorization server, not a resource server).
//
// This file is EXCLUDED from tsconfig: it imports the generated `.open-next/worker.js` (produced by
// `opennextjs-cloudflare build`, gitignored, absent at CI typecheck). The workerd bundle is gated by the
// `build-cf` CI job (build:cf) + verified end-to-end by `deploy:dry` (wrangler bundles this entry). The
// type-checkable config lives in ./issuer/oauth-config (unit-tested).

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";

import openNextHandler from "../.open-next/worker.js";
import { oauthIssuerConfig } from "./issuer/oauth-config";

export default new OAuthProvider({
  ...oauthIssuerConfig,
  defaultHandler: openNextHandler,
});
