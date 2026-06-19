import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { CAPABILITY_REGISTRY } from "@webhook-co/contract";
import {
  createClient,
  createCredentialHasherFromBase64,
  makeApiKeyAuthDeps,
  MCP_RESOURCE,
} from "@webhook-co/db";
import { readSecretBinding } from "@webhook-co/shared";
import { kvCredentialCache } from "@webhook-co/shared/kv-cache";

import { mcpDefaultHandler } from "./default-handler";
import { resolveApiKeyToProps } from "./external-token";
import { WebhookMcp } from "./mcp-agent";
import type { McpEnv } from "./env";

// The mcp. OAuth issuer + resource server, co-located on mcp.:
// @cloudflare/workers-oauth-provider runs here as our own OAuth 2.1 issuer for mcp.-scoped access
// tokens AND validates them as the resource server. Splitting the issuer onto auth. with a separate
// resource server on mcp. is infeasible — the library's tokens are opaque + KV-bound to the issuing
// Worker (no JWT/introspection/cross-Worker validation) — so mcp. issues+validates its own tokens
// and federates user LOGIN to Better Auth on auth. (the identity origin). The provider serves the
// RFC 9728 PRM, RFC 8414 metadata, RFC 7591 DCR, and the /token endpoint; it enforces RFC 8707
// resource binding and S256-only PKCE. We never hand-roll OAuth.
//
// The protected /mcp route is served by the WebhookMcp Durable Object (McpAgent), which registers
// the read capabilities as MCP tools. API-key callers (the CLI today; OAuth-token login is deferred)
// authenticate through resolveExternalToken — the provider calls it for any bearer it didn't mint,
// and we resolve it as an api key bound to MCP_RESOURCE, handing back the principal as grant props.

// MCP_RESOURCE (RFC 9728 `resource` / RFC 8707 audience) is single-sourced in @webhook-co/db.

/** The distinct capability scopes the MCP surface understands (RFC 8414 `scopes_supported`). */
export const SCOPES_SUPPORTED: string[] = [
  ...new Set([...CAPABILITY_REGISTRY.values()].map((c) => c.auth.scope)),
].sort();

// The McpAgent Durable Object class must be exported from the Worker entry so wrangler can bind it
// (durable_objects.bindings[].class_name = "WebhookMcp").
export { WebhookMcp } from "./mcp-agent";

export default new OAuthProvider({
  // The single MCP endpoint. Requests here are validated (token + RFC 8707 resource) before the
  // apiHandler runs; everything else (PRM, metadata, /token, /register, /authorize) is the provider
  // or the defaultHandler. The McpAgent serves the JSON-RPC tool transport at this path.
  apiRoute: ["/mcp"],
  apiHandler: WebhookMcp.serve("/mcp"),
  defaultHandler: mcpDefaultHandler,

  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",

  scopesSupported: SCOPES_SUPPORTED,
  // OAuth 2.1 hardening: no implicit flow, S256-only PKCE (reject `plain`).
  allowImplicitFlow: false,
  allowPlainPKCE: false,

  // The api-key bridge (ADR-0010/0011): called for any bearer NOT minted by this provider — today
  // every caller, since the /authorize login that mints provider tokens is deferred. We resolve the
  // key through the SAME verifyBearer seam apps/api uses (audience = MCP_RESOURCE) and return the
  // principal as grant props + the bound audience (the provider re-checks it against the resource).
  // A short-lived authn client per call (the pepper is decoded BEFORE it opens, so a bad secret
  // fails fast without leaking a connection); torn down in finally. null = not authenticated (401);
  // an operational fault propagates (the provider answers 5xx, never a masked 401).
  resolveExternalToken: async ({ token, env }) => {
    const e = env as McpEnv;
    const hasher = createCredentialHasherFromBase64(await readSecretBinding(e.CREDENTIAL_PEPPER));
    const authn = createClient(e.HYPERDRIVE_AUTHN.connectionString, { max: 1 });
    try {
      // The api-key bearer chain, single-sourced; resource drives the cold-lookup binding + the audience
      // stamp (KV_AUTHZ is shared with api, so a key api cached must resolve here as mcp's audience, not
      // api's — the cross-surface 401 bug, ADR-0010/0011). The resolveExternalToken/resolveApiKeyToProps
      // wrapping stays local (the provider's external-token contract).
      return await resolveApiKeyToProps(
        makeApiKeyAuthDeps({
          hasher,
          authn,
          cache: kvCredentialCache(e.KV_AUTHZ),
          resource: MCP_RESOURCE,
        }),
        token,
      );
    } finally {
      await authn.end();
    }
  },

  // RFC 9728 PRM: advertise our canonical resource + this co-located issuer as the auth server.
  // The resource identifier is the origin (the stable RFC 8707 audience), while the protected API
  // is at /mcp.
  resourceMetadata: {
    resource: MCP_RESOURCE,
    authorization_servers: [MCP_RESOURCE],
    scopes_supported: SCOPES_SUPPORTED,
    bearer_methods_supported: ["header"],
    resource_name: "webhook.co MCP",
  },
});
