import { AuthContextSchema, CapabilityFault, type AuthContext } from "@webhook-co/contract";
import type { CapabilityHandlers, ReplayHandler } from "@webhook-co/db";
import { matchRoute, type RouteDef } from "@webhook-co/openapi/routes";
import { bytesToB64 } from "@webhook-co/shared";

import { authenticate, authorize, type ApiAuthDeps } from "./auth.js";
import { httpStatusForCapabilityError } from "./http-status.js";

// The REST router for the contract-capability surface. It matches an HTTP request to a route in the
// DECLARATIVE manifest (@webhook-co/openapi/routes — the SAME table the OpenAPI generator reads, so the
// spec and the server can't drift), builds the capability input from the path/query, authorizes it via the
// shared bearer seam, dispatches to the bound handler, and maps the typed CapabilityFault to an HTTP status.
// All deps are injected (verifyBearer + the handler maps), so routing/auth/mapping are tested in the node
// pool with no DB; the real deps are wired in index.ts. Operational faults propagate — the caller (the
// Worker fetch) turns them into a 5xx, never masking them here.

export interface ApiDeps {
  readonly authDeps: ApiAuthDeps;
  readonly handlers: CapabilityHandlers;
  /**
   * The payloads R2 bucket — consumed ONLY by the events.getPayload route (the other routes are pure
   * DB reads through `handlers`). Optional in this router bag because it's route-specific; production
   * (index.ts) always wires it, and the payload route fails loud (5xx) if it's ever absent.
   */
  readonly payloads?: R2Bucket;
  /**
   * The events.replay handler (records a delivery_attempt). Route-specific like `payloads` — it's a
   * WRITE, NOT a shared read handler, and is bound ONLY by apps/api (mcp is exempt: the localhost
   * tunnel target is CLI-intrinsic). Optional in the bag; production wires it, the route 5xxs if absent.
   */
  readonly replay?: ReplayHandler;
  /**
   * The replayDestinations.* handlers (the SSRF-egress allowlist, ADR-0081). A DEDICATED map bound ONLY
   * by apps/api — deliberately NOT in the shared `handlers` map that mcp also builds, so the mcp
   * exemption (an agent must not mutate the allowlist) is un-driftable. Optional in the bag; production
   * wires it, the routes 5xx if absent.
   */
  readonly replayDestinations?: CapabilityHandlers;
  /**
   * The subscriptions.* handlers (S3 Slice 3 auto-delivery routing). A DEDICATED map bound ONLY by apps/api
   * — like replayDestinations, kept off the shared `handlers` map so the mcp exemption (an agent must not
   * reconfigure egress routing) is un-driftable. Optional in the bag; production wires it, the routes 5xx if absent.
   */
  readonly subscriptions?: CapabilityHandlers;
}

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: code, message }, { status });
}

/**
 * Parse a JSON request body to a plain object, or throw VALIDATION_ERROR on invalid JSON. A non-object
 * body (array/string/null) yields `{}` so path-derived fields still drive the input. Single-sourced so
 * the body-bearing WRITE routes (endpoints.create / addProviderSecret / events.replay /
 * replayDestinations.create / setOrdered / subscriptions.create) parse + reject malformed bodies identically.
 */
async function readJsonObjectBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new CapabilityFault("VALIDATION_ERROR", "invalid JSON body");
  }
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}

export async function handleRequest(request: Request, deps: ApiDeps): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter((s) => s.length > 0);

  const matched = matchRoute(request.method, segments, url.searchParams);
  // A routing miss is distinct from a capability NOT_FOUND fault (which carries the JSON error shape).
  if (matched === null) {
    return new Response("not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const { def } = matched;

  // The identity route: authenticated but scope-free (NOT a capability — see ADR-0012). Returns the
  // caller's own resolved principal so the CLI can validate a key + show `whoami`. Handled apart from
  // capability routing because it has no scope and binds no read handler.
  if (def.dispatch === "whoami") {
    const authn = await authenticate(deps.authDeps, request);
    if (!authn.ok) {
      return new Response(null, {
        status: authn.status,
        headers: { "www-authenticate": authn.challenge },
      });
    }
    // Shape the response through the shared schema so it can't drift from the AuthContext contract.
    return Response.json(AuthContextSchema.parse(authn.ctx));
  }

  // Authenticate + enforce the capability's scope. Auth rejections return 401/403 with the RFC 6750
  // challenge (empty body); an operational fault (DB/Hyperdrive outage) THROWS to the 5xx boundary.
  const capability = def.capability!;
  const authz = await authorize(deps.authDeps, request, capability);
  if (!authz.ok) {
    return new Response(null, {
      status: authz.status,
      headers: { "www-authenticate": authz.challenge },
    });
  }

  // Dispatch inside the fault-mapping try/catch. The JSON-body read is INSIDE it too, so a malformed body
  // (readJsonObjectBody throws VALIDATION_ERROR) maps to 400, not the 5xx boundary. The path/query-derived
  // input stays AUTHORITATIVE over the body (a forged body id can never override the path segment).
  // Everything but events.getPayload is a handler call; the payload route is special (an RLS metadata read
  // THEN an R2 GET, ADR-0015).
  try {
    const input = def.body
      ? { ...(await readJsonObjectBody(request)), ...matched.input }
      : matched.input;
    if (def.dispatch === "payload") {
      return await handlePayload(deps, authz.ctx, String(input.eventId));
    }
    const handler = resolveHandler(deps, def, capability);
    return Response.json(await handler(authz.ctx, input));
  } catch (err) {
    if (err instanceof CapabilityFault) {
      return jsonError(err.code, err.message, httpStatusForCapabilityError(err.code));
    }
    throw err; // operational -> the fetch boundary maps it to 5xx
  }
}

/**
 * Resolve the handler for a dispatched route from the right map: `replay` (the dedicated WRITE), the
 * dedicated `replayDestinations` / `subscriptions` maps (kept OFF the shared map so the mcp exemptions
 * can't drift), or the shared `handlers` map (everything else — endpoints/events/deliveries/audit, the
 * same handlers mcp binds). A routed capability with no bound handler is a wiring bug (→ 5xx), not a
 * client error, and the throw message names the capability so the boundary log points at it.
 */
function resolveHandler(
  deps: ApiDeps,
  def: RouteDef,
  capability: string,
): (ctx: AuthContext, input: Record<string, unknown>) => Promise<unknown> {
  switch (def.dispatch) {
    case "replay": {
      if (deps.replay === undefined) throw new Error("no replay handler bound"); // wiring bug -> 5xx
      return deps.replay;
    }
    case "replayDestinations": {
      const handler = deps.replayDestinations?.get(capability);
      if (handler === undefined) {
        throw new Error(`no replayDestinations handler bound for: ${capability}`);
      }
      return handler;
    }
    case "subscriptions": {
      const handler = deps.subscriptions?.get(capability);
      if (handler === undefined) {
        throw new Error(`no subscriptions handler bound for: ${capability}`);
      }
      return handler;
    }
    default: {
      const handler = deps.handlers.get(capability);
      if (handler === undefined) {
        throw new Error(`no handler bound for capability: ${capability}`);
      }
      return handler;
    }
  }
}

/**
 * events.getPayload: read the event's metadata under RLS (reusing the shared events.get handler — so
 * ownership + NOT_FOUND are enforced once, in one place), then stream its stored body from R2 as a
 * base64 envelope (ADR-0015). A missing R2 object for a row that DOES exist is a NOT_FOUND (the body
 * was pruned, or a half-completed write), not a 5xx. The api only ever GETs R2 here.
 */
async function handlePayload(deps: ApiDeps, ctx: AuthContext, eventId: string): Promise<Response> {
  if (deps.payloads === undefined) {
    // The payload route is mounted but no R2 binding was wired — an operational wiring bug, not a
    // client error; it propagates to the 5xx boundary.
    throw new Error("events.getPayload routed without an R2_PAYLOADS binding");
  }
  const eventsGet = deps.handlers.get("events.get");
  if (eventsGet === undefined) throw new Error("no handler bound for capability: events.get");
  // events.get returns an EventSchema-validated row (getEvent runs EventSchema.parse), so
  // payloadR2Key is a guaranteed string (z.string()) — a projection drift throws upstream rather
  // than yielding an undefined key. The cast only narrows the CapabilityHandler's `unknown` return.
  const event = (await eventsGet(ctx, { eventId })) as {
    payloadR2Key: string;
    contentType: string | null;
  };
  const obj = await deps.payloads.get(event.payloadR2Key);
  if (obj === null) throw new CapabilityFault("NOT_FOUND", "payload body not found");
  const bytes = new Uint8Array(await obj.arrayBuffer());
  return Response.json({
    contentType: event.contentType,
    bytes: bytes.byteLength,
    bodyBase64: bytesToB64(bytes),
  });
}
