import { AuthContextSchema, CapabilityFault, type AuthContext } from "@webhook-co/contract";
import type { ReadHandlers, ReplayHandler } from "@webhook-co/db";
import { bytesToB64 } from "@webhook-co/shared";

import { authenticate, authorize, type ApiAuthDeps } from "./auth.js";
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
  if (
    method === "GET" &&
    rest.length === 4 &&
    rest[0] === "endpoints" &&
    rest[2] === "events" &&
    rest[3] === "tail"
  ) {
    // events.tail is cursor-pull: one watermark-bounded forward page per request. The opaque
    // sinceCursor resumes; omit it to start from the oldest visible event.
    const input: Record<string, unknown> = { endpointId: rest[1] };
    const sinceCursor = query.get("sinceCursor");
    if (sinceCursor !== null) input.sinceCursor = sinceCursor;
    return { capability: "events.tail", input };
  }
  if (method === "GET" && rest.length === 2 && rest[0] === "events") {
    return { capability: "events.get", input: { eventId: rest[1] } };
  }
  if (method === "GET" && rest.length === 3 && rest[0] === "events" && rest[2] === "payload") {
    // events.getPayload: the raw stored body (base64 envelope). Not a DB ReadHandler — dispatched
    // specially in handleRequest (it does the RLS metadata read THEN an R2 GET). ADR-0015.
    return { capability: "events.getPayload", input: { eventId: rest[1] } };
  }
  if (method === "POST" && rest.length === 3 && rest[0] === "events" && rest[2] === "replay") {
    // events.replay: eventId from the path; target + idempotencyKey come from the JSON body (merged
    // in handleReplay). A WRITE — records a delivery_attempt; dispatched specially, not via `handlers`.
    return { capability: "events.replay", input: { eventId: rest[1] } };
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

  // The identity endpoint: authenticated but scope-free (NOT a capability — see ADR-0012). Returns
  // the caller's own resolved principal so the CLI can validate a key + show `whoami`. Handled before
  // capability routing because it has no scope and binds no read handler.
  if (
    request.method === "GET" &&
    segments.length === 2 &&
    segments[0] === "v1" &&
    segments[1] === "whoami"
  ) {
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

  // Dispatch inside the fault-mapping try/catch. events.getPayload is special-cased: it is NOT a DB
  // ReadHandler — it does the RLS metadata read (via the events.get handler) then streams the R2 body.
  try {
    if (route.capability === "events.getPayload") {
      return await handlePayload(deps, authz.ctx, String(route.input.eventId));
    }
    if (route.capability === "events.replay") {
      return await handleReplay(deps, authz.ctx, String(route.input.eventId), request);
    }
    const handler = deps.handlers.get(route.capability);
    if (handler === undefined) {
      // A routed capability with no bound handler is a wiring bug, not a client error.
      throw new Error(`no handler bound for capability: ${route.capability}`);
    }
    return Response.json(await handler(authz.ctx, route.input));
  } catch (err) {
    if (err instanceof CapabilityFault) {
      return jsonError(err.code, err.message, httpStatusForCapabilityError(err.code));
    }
    throw err; // operational -> the fetch boundary maps it to 5xx
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
  // than yielding an undefined key. The cast only narrows the ReadHandler's `unknown` return.
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

/**
 * events.replay: a WRITE. The eventId comes from the path; target + idempotencyKey from the JSON body.
 * We merge them (the path eventId is authoritative) and hand the full input to the bound replay
 * handler, which enforces the events:replay scope, validates the body against the capability schema
 * (bad/missing fields → VALIDATION_ERROR), and records the delivery_attempt. The api NEVER contacts
 * the localhost target — the CLI does that and calls this after a local 2xx.
 */
async function handleReplay(
  deps: ApiDeps,
  ctx: AuthContext,
  eventId: string,
  request: Request,
): Promise<Response> {
  if (deps.replay === undefined) {
    throw new Error("no replay handler bound"); // wiring bug -> 5xx
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new CapabilityFault("VALIDATION_ERROR", "invalid JSON body");
  }
  const input = { ...(typeof body === "object" && body !== null ? body : {}), eventId };
  return Response.json(await deps.replay(ctx, input));
}
