import {
  AuthContextSchema,
  CapabilityFault,
  OrganizationSchema,
  type AuthContext,
  type OrgIdentity,
} from "@webhook-co/contract";
import type { CapabilityHandlers, ReplayHandler } from "@webhook-co/db";
import { matchRoute, type RouteDef } from "@webhook-co/openapi/routes";

import { handleActivationReview, type ActivationReviewDep } from "./activation-review.js";
import {
  ADVISORY_HEADER,
  DEPRECATION_HEADER,
  buildAdvisory,
  bytesToB64,
  parseClientUserAgent,
} from "@webhook-co/shared";

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
   * Internal founder-only weekly activation review (activation follow-up). Route-specific, bound ONLY by
   * apps/api, and present only when both the reviewer Hyperdrive binding and the `INTERNAL_REVIEW_TOKEN`
   * secret exist — absent → `GET /v1/internal/activation/weekly` returns 404 (ships dark).
   */
  readonly activationReview?: ActivationReviewDep;
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
  /**
   * Resolves an org's public identity {id, slug, name} from its id — used ONLY by `whoami` to enrich the
   * response so a bound client can see which org it acts in. Optional in the bag: production (index.ts)
   * wires it over the tenant pool; when absent or on a read fault, `whoami` degrades to the base principal
   * (orgId is still present). It is NOT on the request hot path — verifyBearer never calls it.
   */
  readonly resolveOrgIdentity?: (orgId: string) => Promise<OrgIdentity | null>;
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

/**
 * Attach the client version advisory to a response.
 *
 * Server-driven, so a library never has to poll a package registry from inside someone's Worker or Lambda:
 * the SDK identifies itself in its User-Agent and we answer on a response the caller ALREADY asked for —
 * zero extra requests. Silent unless the caller is one of OUR clients AND is behind; `Deprecation: true` is
 * reserved for versions below the supported floor (genuinely broken, not merely old).
 *
 * Applied to EVERY /v1 response including errors: a broken old client is precisely the one hitting errors,
 * so advising only on 200s would miss exactly the people who most need to hear it.
 */
function withClientAdvisory(request: Request, response: Response): Response {
  const advisory = buildAdvisory(parseClientUserAgent(request.headers.get("user-agent")));
  if (advisory === null) return response; // the common case: cost nothing, say nothing
  const headers = new Headers(response.headers);
  headers.set(ADVISORY_HEADER, advisory.headerValue);
  if (advisory.deprecated) headers.set(DEPRECATION_HEADER, "true");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function handleRequest(request: Request, deps: ApiDeps): Promise<Response> {
  return withClientAdvisory(request, await routeRequest(request, deps));
}

async function routeRequest(request: Request, deps: ApiDeps): Promise<Response> {
  const url = new URL(request.url);

  // Internal founder-only weekly review — matched HERE, before the spec-driven `matchRoute`, because it is
  // deliberately NOT a public capability (it returns platform-wide aggregates and must stay out of the
  // OpenAPI spec/SDKs). Token-gated; unconfigured → 404 (dark).
  if (request.method === "GET" && url.pathname === "/v1/internal/activation/weekly") {
    return handleActivationReview(request, deps.activationReview);
  }

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
    // Enrich with the bound org's identity {id,slug,name} so a multi-org caller can see WHICH org this
    // credential acts in. Best-effort: the principal is already resolved (orgId present), so NEITHER a read
    // fault NOR a degenerate org row (e.g. an empty `name`, which the wire schema rejects) may take down
    // `whoami` — this is the surface the CLI validates keys against. Both failure modes log a signal (so a
    // persistent org-read outage isn't silently dark) and degrade to the base principal. We validate the
    // resolved row through OrganizationSchema BEFORE merging, so the final parse below can never throw on it.
    //
    // Cost: one extra tenant-pool read per whoami. Proportionate — whoami is a low-QPS identity/key-check
    // surface, not a data path, and the capability routes are untouched. Deliberately NOT cached: slugs are
    // mutable (a rename retires the old slug, org-URL lane), so a cache would serve a stale slug post-rename.
    let organization: OrgIdentity | undefined;
    if (deps.resolveOrgIdentity) {
      try {
        const resolved = await deps.resolveOrgIdentity(authn.ctx.orgId);
        organization = resolved ? OrganizationSchema.parse(resolved) : undefined;
      } catch (err) {
        console.log(
          JSON.stringify({ message: "api.whoami_org_enrich_failed", error: String(err) }),
        );
        organization = undefined; // degrade to base identity; orgId is still reported
      }
    }
    // Shape the response through the shared schema so it can't drift from the AuthContext contract.
    return Response.json(AuthContextSchema.parse({ ...authn.ctx, organization }));
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
