// A2b-5 — wires the introspection core to the provider's getOAuthApi().unwrapToken. Imported ONLY by
// src/worker.ts's WorkerEntrypoint (the wrangler layer), never by `next build` — so the getOAuthApi import
// (which eagerly pulls cloudflare:workers) is fine. Type-checked; the thin WorkerEntrypoint wrapper is the
// only untyped piece (worker.ts is tsc-excluded for the generated handler import).

import { getOAuthApi } from "@cloudflare/workers-oauth-provider";

import { introspectToken, type IntrospectionResult } from "./introspect-core";
import { oauthIssuerConfig } from "./oauth-config";
import type { ConsentProps } from "./token-core";
import type { IntrospectEnv } from "../runtime/env";

// getOAuthApi needs a full OAuthProviderOptions; the unwrapToken helper works off OAUTH_KV + the token
// encryption only and never invokes defaultHandler — a never-called 404 stub completes the options.
const HELPERS_DEFAULT_HANDLER = { fetch: async () => new Response(null, { status: 404 }) };

/** Introspect an opaque provider token using this Worker's OAUTH_KV-bound grant store. */
export async function introspect(env: IntrospectEnv, token: string): Promise<IntrospectionResult> {
  const helpers = getOAuthApi(
    { ...oauthIssuerConfig, defaultHandler: HELPERS_DEFAULT_HANDLER },
    env as never,
  );
  return introspectToken(
    {
      unwrapToken: async (t) => {
        const summary = await helpers.unwrapToken<ConsentProps>(t);
        if (!summary) return null;
        return {
          orgId: summary.grant.props.orgId,
          userId: summary.userId,
          scopes: summary.scope,
          // RFC 8707 audience may be a single value or an array — surface it FAITHFULLY (don't collapse a
          // multi-resource token to one element, which would let it pass a single-resource check at a
          // resource it shouldn't, an order-dependent cross-resource replay). The caller (mcp) binds it.
          audience: summary.audience,
          expiresAt: summary.expiresAt,
        };
      },
    },
    token,
  );
}
