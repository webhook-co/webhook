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

import { makeAuthorizeDeps } from "./authorize-deps";
import { handleAuthorize, handleConsentDecision } from "./authorize-route";
import { makeDeviceAuthorizeDeps } from "./device-authorize-deps";
import { handleDeviceAuthorization } from "./device-authorize-route";
import { redeemDeviceCode } from "./device-token-core";
import { makeDeviceVerifyDeps } from "./device-verify-deps";
import { handleDeviceVerify } from "./device-verify-route";
import { makeRevokeDeps } from "./revoke-deps";
import { handleRevokeRequest } from "./revoke-route";
import { redeemAuthCode, redeemRefresh } from "./token-core";
import { makeTokenDeps } from "./token-deps";
import { handleTokenRequest } from "./token-route";
import {
  readAuthorizeEnv,
  readDeviceAuthorizeEnv,
  readDeviceVerifyEnv,
  readRevokeEnv,
  readTokenEnv,
} from "../runtime/env";

/** The minimal shape of a Worker fetch handler (the generated OpenNext handler + what we export). */
export interface FetchHandler {
  fetch: (request: Request, env: unknown, ctx: ExecutionLike) => Response | Promise<Response>;
}

/** The slice of ExecutionContext we use (kept structural to avoid a Workers-global lib dependency). */
export interface ExecutionLike {
  waitUntil: (promise: Promise<unknown>) => void;
}

/** Drain a per-request pool after the response — never blocking it; a drain failure goes to observability. */
function drain(ctx: ExecutionLike, close: () => Promise<void>, event: string): void {
  ctx.waitUntil(
    close().catch((error: unknown) =>
      console.log(JSON.stringify({ message: event, error: String(error) })),
    ),
  );
}

/**
 * Wrap the OpenNext handler: intercept Lane C's issuer endpoints — POST /token, POST /revoke, GET
 * /authorize, POST /consent/decision — which use the provider helpers / cross-org credential resolution /
 * the session runtime and so must run in the wrangler layer — and delegate everything else to OpenNext
 * (the pages, /api/auth/*, and Lane E's consent SCREEN at /consent, which is served by Next).
 */
export function makeIssuerDefaultHandler(openNextHandler: FetchHandler): FetchHandler {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const rawEnv = env as Record<string, unknown>;

      // GET /authorize — the interactive consent entry point (A3). Resolves the session, builds a signed
      // consent ticket, and redirects to Lane E's /consent screen (served by OpenNext, below).
      if (request.method === "GET" && url.pathname === "/authorize") {
        const { deps, close } = await makeAuthorizeDeps(readAuthorizeEnv(rawEnv), ctx);
        try {
          return await handleAuthorize(deps, request);
        } finally {
          drain(ctx, close, "authorize.pool_close_failed");
        }
      }

      // POST /consent/decision — record the user's approve/deny (A3).
      if (request.method === "POST" && url.pathname === "/consent/decision") {
        const { deps, close } = await makeAuthorizeDeps(readAuthorizeEnv(rawEnv), ctx);
        try {
          return await handleConsentDecision(deps, request);
        } finally {
          drain(ctx, close, "consent_decision.pool_close_failed");
        }
      }

      // POST /device_authorization — the RFC 8628 device-code request (A4b). No pool: it only validates the
      // client (KV) + mints a device code (KV); a key is minted later at the /token poll.
      if (request.method === "POST" && url.pathname === "/device_authorization") {
        const deps = makeDeviceAuthorizeDeps(readDeviceAuthorizeEnv(rawEnv), request.url);
        return await handleDeviceAuthorization(deps, request);
      }

      // POST /device/verify — the device browser approval entry (A4c-3): rate-limited + session-gated, it
      // resolves the user-code → builds the consent ticket → redirects to the shared /consent screen.
      if (request.method === "POST" && url.pathname === "/device/verify") {
        const { deps, close } = await makeDeviceVerifyDeps(readDeviceVerifyEnv(rawEnv), ctx);
        try {
          return await handleDeviceVerify(deps, request);
        } finally {
          drain(ctx, close, "device_verify.pool_close_failed");
        }
      }

      if (request.method === "POST" && url.pathname === "/token") {
        const { authCode, refresh, device, close } = await makeTokenDeps(
          readTokenEnv(rawEnv),
          request.url,
        );
        try {
          return await handleTokenRequest(
            {
              redeemAuthCode: (req) => redeemAuthCode(authCode, req),
              redeemRefresh: (req) => redeemRefresh(refresh, req),
              redeemDevice: (req) => redeemDeviceCode(device, req),
            },
            request,
          );
        } finally {
          drain(ctx, close, "token.pool_close_failed");
        }
      }

      if (request.method === "POST" && url.pathname === "/revoke") {
        const { deps, close } = await makeRevokeDeps(readRevokeEnv(rawEnv));
        try {
          return await handleRevokeRequest(deps, request);
        } finally {
          drain(ctx, close, "revoke.pool_close_failed");
        }
      }

      return openNextHandler.fetch(request, env, ctx);
    },
  };
}
