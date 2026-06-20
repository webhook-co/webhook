// A2b-2b — the OAuth-issuer request dispatch that sits in front of OpenNext as the provider's
// defaultHandler. The issuer endpoints that use the provider's in-process helpers (getOAuthApi →
// unwrapToken/revokeGrant) must run in the WRANGLER-bundled layer, not as Next routes: the provider
// eagerly imports `cloudflare:workers`, which OpenNext's esbuild can't resolve for a server function
// (wrangler externalizes it natively — see ADR-0024's A2b-2b note). So /token is handled here; everything
// else falls through to OpenNext (the pages, /api/auth/*, /authorize consent UI). This module is imported
// only by src/worker.ts (the wrangler entry), never by `next build` — so its getOAuthApi import is fine.
//
// It IS type-checked (unlike worker.ts, which is excluded for the generated .open-next import). The runtime
// types (env/ctx/handler) are kept structural so no Workers-global lib is needed under the DOM tsconfig.

import { redeemAuthCode } from "./token-core";
import { makeTokenDeps } from "./token-deps";
import { handleTokenRequest } from "./token-route";
import { readTokenEnv } from "../runtime/env";

/** The minimal shape of a Worker fetch handler (the generated OpenNext handler + what we export). */
export interface FetchHandler {
  fetch: (request: Request, env: unknown, ctx: ExecutionLike) => Response | Promise<Response>;
}

/** The slice of ExecutionContext we use (kept structural to avoid a Workers-global lib dependency). */
export interface ExecutionLike {
  waitUntil: (promise: Promise<unknown>) => void;
}

/**
 * Wrap the OpenNext handler: intercept Lane C's frozen /token (POST), delegate everything else. The
 * per-request webhook_app pool is drained after the response via waitUntil — never blocking it, a drain
 * failure going to observability rather than vanishing.
 */
export function makeIssuerDefaultHandler(openNextHandler: FetchHandler): FetchHandler {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/token") {
        const { authCode, close } = await makeTokenDeps(
          readTokenEnv(env as Record<string, unknown>),
          request.url,
        );
        try {
          return await handleTokenRequest(
            { redeemAuthCode: (req) => redeemAuthCode(authCode, req) },
            request,
          );
        } finally {
          ctx.waitUntil(
            close().catch((error: unknown) =>
              console.log(
                JSON.stringify({ message: "token.pool_close_failed", error: String(error) }),
              ),
            ),
          );
        }
      }
      return openNextHandler.fetch(request, env, ctx);
    },
  };
}
