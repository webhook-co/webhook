import type { McpEnv } from "./env";

// The default (non-API) handler. The OAuthProvider serves PRM, RFC 8414 metadata,
// the /token endpoint, and DCR itself; everything NOT under an apiRoute falls here. The only OAuth
// surface this handler owns is the interactive /authorize UI (login + consent).
//
// Today that /authorize is a STUB: the real flow authenticates the user against Better Auth on
// auth. (the identity origin) and then calls `env.OAUTH_PROVIDER.completeAuthorization()` to mint
// the grant with `{ orgId, userId, scopes }` props. That login/consent UI + magic-link email is a
// human-UI hard stop, so it is intentionally not implemented here yet.

export const mcpDefaultHandler = {
  async fetch(request: Request, _env: McpEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/authorize") {
      // Pending: render login (federate to Better Auth on auth.) + consent, then call
      // env.OAUTH_PROVIDER.completeAuthorization({ request, userId, scope, props }).
      return new Response("authorization UI is not yet implemented", { status: 501 });
    }
    if (pathname === "/healthz") {
      return new Response("mcp ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<McpEnv>;
