// A1b-1 — the Better Auth runtime mount. This catch-all serves every /api/auth/* endpoint (social
// sign-in + callbacks, magic-link send + verify, session, sign-out). On workerd the bindings/secrets
// are only available per-request, so the auth instance is built per-request from the validated
// Cloudflare env and the request is handed to Better Auth's own router. The per-request pg pool is
// closed after the response (ctx.waitUntil) to match the repo norm — never leak a pooled connection.

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { makeAuth } from "@/runtime/auth";
import { readAuthEnv } from "@/runtime/env";

async function handle(request: Request): Promise<Response> {
  const { env, ctx } = await getCloudflareContext({ async: true });
  const { handler, close } = makeAuth(readAuthEnv(env as unknown as Record<string, unknown>));
  try {
    return await handler(request);
  } finally {
    // Drain the per-request pool AFTER the response: never block the response on teardown, and never
    // lose a successful response to a teardown hiccup. This is safe because every handler on this mount
    // returns a fully-buffered body before resolving — a future STREAMED route mounted here (e.g. the
    // OAuth-issuer routes) must revisit this so the pool isn't ended mid-stream. A drain failure goes to
    // observability rather than vanishing as a silent unhandled rejection.
    ctx.waitUntil(
      close().catch((error) =>
        console.log(JSON.stringify({ message: "auth.pool_close_failed", error: String(error) })),
      ),
    );
  }
}

// Better Auth routes internally by method; export every verb it may serve so a future endpoint
// (e.g. the OAuth-issuer routes mounted here later) can't silently 405 at the Next layer.
export { handle as GET, handle as POST, handle as PATCH, handle as PUT, handle as DELETE };
