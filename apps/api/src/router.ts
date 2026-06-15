import { CapabilityFault } from "@webhook-co/contract";
import type { ReadHandlers } from "@webhook-co/db";

import { authorize, type ApiAuthDeps } from "./auth.js";
import { httpStatusForCapabilityError } from "./http-status.js";

// The REST router for the read-capabilities surface. It maps an HTTP request to a contract
// capability + the input built from the path/query, authorizes it via the shared bearer seam,
// dispatches to the shared read handler, and maps the typed CapabilityFault to an HTTP status.
// All deps are injected (verifyBearer + the handler map), so routing/auth/mapping are tested in
// the node pool with no DB; the real deps are wired in index.ts. Operational faults propagate —
// the caller (the Worker fetch) turns them into a 5xx, never masking them here.

export interface ApiDeps {
  readonly authDeps: ApiAuthDeps;
  readonly handlers: ReadHandlers;
}

interface Route {
  readonly capability: string;
  readonly input: Record<string, unknown>;
}

function numParam(value: string | null): number | undefined {
  return value === null ? undefined : Number(value);
}

/** Build the optional pagination input shared by the list capabilities (omit absent keys). */
function listInput(query: URLSearchParams, base: Record<string, unknown>): Record<string, unknown> {
  const input = { ...base };
  const cursor = query.get("cursor");
  if (cursor !== null) input.cursor = cursor;
  const limit = numParam(query.get("limit"));
  if (limit !== undefined) input.limit = limit;
  return input;
}

/** Match a request to a capability route + its input, or null for an unknown path/method. */
function matchRoute(
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
): Route | null {
  if (segments[0] !== "v1") return null;
  const rest = segments.slice(1);

  if (method === "GET" && rest.length === 1 && rest[0] === "endpoints") {
    return { capability: "endpoints.list", input: listInput(query, {}) };
  }
  if (method === "GET" && rest.length === 2 && rest[0] === "endpoints") {
    return { capability: "endpoints.get", input: { endpointId: rest[1] } };
  }
  if (method === "GET" && rest.length === 3 && rest[0] === "endpoints" && rest[2] === "events") {
    const input = listInput(query, { endpointId: rest[1] });
    const provider = query.get("provider");
    if (provider !== null) input.filter = { provider };
    return { capability: "events.list", input };
  }
  if (method === "GET" && rest.length === 2 && rest[0] === "events") {
    return { capability: "events.get", input: { eventId: rest[1] } };
  }
  if (method === "POST" && rest.length === 2 && rest[0] === "audit" && rest[1] === "verify") {
    return { capability: "audit.verify", input: {} };
  }
  return null;
}

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: code, message }, { status });
}

export async function handleRequest(request: Request, deps: ApiDeps): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  const route = matchRoute(request.method, segments, url.searchParams);
  // A routing miss is distinct from a capability NOT_FOUND fault (which carries the JSON error shape).
  if (route === null) {
    return new Response("not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // Authenticate + enforce the capability's scope. Auth rejections return 401/403 with the RFC 6750
  // challenge; an operational fault (DB/Hyperdrive outage) THROWS and propagates to the 5xx boundary.
  const authz = await authorize(deps.authDeps, request, route.capability);
  if (!authz.ok) {
    return new Response(null, {
      status: authz.status,
      headers: { "www-authenticate": authz.challenge },
    });
  }

  const handler = deps.handlers.get(route.capability);
  if (handler === undefined) {
    // A routed capability with no bound handler is a wiring bug, not a client error.
    throw new Error(`no handler bound for capability: ${route.capability}`);
  }

  try {
    return Response.json(await handler(authz.ctx, route.input));
  } catch (err) {
    if (err instanceof CapabilityFault) {
      return jsonError(err.code, err.message, httpStatusForCapabilityError(err.code));
    }
    throw err; // operational -> the fetch boundary maps it to 5xx
  }
}
