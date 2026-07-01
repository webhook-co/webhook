// The declarative HTTP route manifest — the SINGLE source of truth for the public REST surface.
//
// Both the runtime router (apps/api) AND the OpenAPI generator consume this table, so the HTTP
// envelope (verb, path, capability, success status, body/param locations) cannot drift between the
// server and the published spec. The matching is exact (segment-count + literal positions), so route
// order is irrelevant and no request can match two rows (asserted by the manifest tests).
//
// What lives HERE: the transport shape + the query/path → capability-input construction (ported
// verbatim from the former hand-written matchRoute, incl. the empty-filter stripping that keeps a
// cleared filter from tripping the contract's `.min(1)`). What lives in apps/api: auth, JSON-body
// reading + merge, and the per-dispatch handler wiring (R2 payload, replay, the dedicated maps).

import type { CapabilityError } from "@webhook-co/contract";

export type HttpMethod = "GET" | "POST" | "DELETE";

/**
 * The canonical capability-error → HTTP status map. SINGLE-SOURCED here so the runtime router
 * (apps/api) and the OpenAPI generator map the closed error taxonomy to a status identically — the spec
 * can't claim a status the server doesn't return. Total over CAPABILITY_ERRORS (a compile error if the
 * taxonomy grows without a mapping). NB 401/403 faults are emitted by the bearer gate as EMPTY-body
 * responses with a WWW-Authenticate header (RFC 6750); the other statuses carry the JSON {error,message}.
 */
export const CAPABILITY_ERROR_STATUS: Record<CapabilityError, number> = {
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  VALIDATION_ERROR: 400,
  RATE_LIMITED: 429,
  ENDPOINT_PAUSED: 409,
  TARGET_UNREACHABLE: 502,
};

export function httpStatusForCapabilityError(code: CapabilityError): number {
  return CAPABILITY_ERROR_STATUS[code];
}

/**
 * How apps/api dispatches a matched route. `shared`/`replayDestinations`/`subscriptions` pick a handler
 * map; `payload`/`replay` are the two R2/write special-cases; `whoami` is the scope-free identity route.
 */
export type DispatchKind =
  "shared" | "payload" | "replay" | "replayDestinations" | "subscriptions" | "whoami";

/** A query parameter, described once for the spec and consumed by the route's buildInput. */
export interface QueryParamDef {
  readonly name: string;
  /** Repeatable (`?x=a&x=b` → array) — a multi-select filter. */
  readonly multi?: boolean;
  readonly description: string;
  /**
   * Dotted path into the capability input schema to source this param's OpenAPI schema (e.g. "limit" or
   * "filter.provider"). Keeps the query-param schema contract-derived instead of hand-declared.
   */
  readonly schemaFrom: string;
}

export interface RouteDef {
  readonly method: HttpMethod;
  /** Full path template incl. the `/v1` prefix and `{param}` placeholders. */
  readonly path: string;
  /** The dispatched capability, or null for the whoami identity route (scope-free, not a capability). */
  readonly capability: string | null;
  /** Always 200 today — explicit so the spec + a no-201/204 guard stay data-driven. */
  readonly successStatus: 200;
  readonly dispatch: DispatchKind;
  /** Whether the route reads + merges a JSON request body (path/query input stays authoritative). */
  readonly body: boolean;
  /** One-line OpenAPI summary. */
  readonly summary: string;
  readonly query?: readonly QueryParamDef[];
  /** Construct the capability input from the matched path params + the query string. */
  readonly buildInput: (
    params: Readonly<Record<string, string>>,
    query: URLSearchParams,
  ) => Record<string, unknown>;
}

export interface MatchedRoute {
  readonly def: RouteDef;
  readonly input: Record<string, unknown>;
}

// ── input-building helpers (ported verbatim from apps/api/src/router.ts) ────────────────────────────

function numParam(value: string | null): number | undefined {
  return value === null ? undefined : Number(value);
}

/** The optional pagination input shared by list capabilities (omit absent keys). */
function listInput(query: URLSearchParams, base: Record<string, unknown>): Record<string, unknown> {
  const input = { ...base };
  const cursor = query.get("cursor");
  if (cursor !== null) input.cursor = cursor;
  const limit = numParam(query.get("limit"));
  if (limit !== undefined) input.limit = limit;
  return input;
}

const PAGINATION_QUERY: readonly QueryParamDef[] = [
  {
    name: "cursor",
    description: "Opaque keyset cursor from a prior page's nextCursor.",
    schemaFrom: "cursor",
  },
  { name: "limit", description: "Max items to return (1–200, default 50).", schemaFrom: "limit" },
];

// ── the manifest ────────────────────────────────────────────────────────────────────────────────

/** A no-arg input builder (path/query carry nothing). */
const noInput = (): Record<string, unknown> => ({});
/** A single-path-param input builder onto the given input key. */
const pathParam =
  (key: string, param: string) =>
  (params: Readonly<Record<string, string>>): Record<string, unknown> => ({ [key]: params[param] });

export const ROUTES: readonly RouteDef[] = [
  // ── endpoints.* ───────────────────────────────────────────────────────────────────────────────
  {
    method: "GET",
    path: "/v1/endpoints",
    capability: "endpoints.list",
    successStatus: 200,
    dispatch: "shared",
    body: false,
    summary: "List endpoints",
    query: [
      ...PAGINATION_QUERY,
      {
        name: "name",
        description: "Case-insensitive substring name filter (empty = no filter).",
        schemaFrom: "filter.name",
      },
    ],
    buildInput: (_params, q) => {
      const input = listInput(q, {});
      // An EMPTY `?name=` means "no name filter" (truthiness drops null and "") — the contract's min(1)
      // would otherwise 400 a clear-the-filter call.
      const name = q.get("name");
      if (name) input.filter = { name };
      return input;
    },
  },
  {
    method: "POST",
    path: "/v1/endpoints",
    capability: "endpoints.create",
    successStatus: 200,
    dispatch: "shared",
    body: true,
    summary: "Create an endpoint (returns the one-time ingest URL)",
    buildInput: noInput,
  },
  {
    method: "GET",
    path: "/v1/endpoints/{endpointId}",
    capability: "endpoints.get",
    successStatus: 200,
    dispatch: "shared",
    body: false,
    summary: "Get an endpoint",
    buildInput: pathParam("endpointId", "endpointId"),
  },
  {
    method: "DELETE",
    path: "/v1/endpoints/{endpointId}",
    capability: "endpoints.delete",
    successStatus: 200,
    dispatch: "shared",
    body: false,
    summary: "Soft-delete an endpoint (idempotent)",
    buildInput: pathParam("endpointId", "endpointId"),
  },
  {
    method: "POST",
    path: "/v1/endpoints/{endpointId}/rotate",
    capability: "endpoints.rotate",
    successStatus: 200,
    dispatch: "shared",
    body: false,
    summary: "Rotate an endpoint's ingest token (returns a new one-time ingest URL)",
    buildInput: pathParam("endpointId", "endpointId"),
  },
  {
    method: "POST",
    path: "/v1/endpoints/{endpointId}/provider-secrets",
    capability: "endpoints.addProviderSecret",
    successStatus: 200,
    dispatch: "shared",
    body: true,
    summary: "Add a provider signing/verification secret to an endpoint",
    buildInput: pathParam("endpointId", "endpointId"),
  },
  {
    method: "GET",
    path: "/v1/endpoints/{endpointId}/provider-secrets",
    capability: "endpoints.listProviderSecrets",
    successStatus: 200,
    dispatch: "shared",
    body: false,
    summary: "List an endpoint's provider secrets (metadata only)",
    buildInput: pathParam("endpointId", "endpointId"),
  },
  {
    method: "DELETE",
    path: "/v1/endpoints/{endpointId}/provider-secrets/{secretId}",
    capability: "endpoints.revokeProviderSecret",
    successStatus: 200,
    dispatch: "shared",
    body: false,
    summary: "Revoke a provider secret",
    buildInput: (params) => ({ endpointId: params.endpointId, secretId: params.secretId }),
  },
  // ── events.* ──────────────────────────────────────────────────────────────────────────────────
  {
    method: "GET",
    path: "/v1/endpoints/{endpointId}/events",
    capability: "events.list",
    successStatus: 200,
    dispatch: "shared",
    body: false,
    summary: "List captured events for an endpoint",
    query: [
      ...PAGINATION_QUERY,
      {
        name: "provider",
        multi: true,
        description: "Filter by provider (repeatable).",
        schemaFrom: "filter.provider",
      },
      {
        name: "verificationState",
        multi: true,
        description: "Filter by verification state: verified | failed | unattempted (repeatable).",
        schemaFrom: "filter.verificationState",
      },
      {
        name: "receivedAfter",
        description: "Inclusive lower bound (RFC 3339 instant).",
        schemaFrom: "filter.receivedAfter",
      },
      {
        name: "receivedBefore",
        description: "Exclusive upper bound (RFC 3339 instant).",
        schemaFrom: "filter.receivedBefore",
      },
      {
        name: "search",
        description: "Case-insensitive substring across id fields + header names/values.",
        schemaFrom: "filter.search",
      },
    ],
    buildInput: (params, q) => {
      const input = listInput(q, { endpointId: params.endpointId });
      const filter: Record<string, unknown> = {};
      // Multi-select: repeated params → an array; drop empties so a cleared filter never 400s multiEnum.
      const providers = q.getAll("provider").filter((p) => p !== "");
      if (providers.length > 0) filter.provider = providers;
      const receivedAfter = q.get("receivedAfter");
      if (receivedAfter) filter.receivedAfter = receivedAfter;
      const receivedBefore = q.get("receivedBefore");
      if (receivedBefore) filter.receivedBefore = receivedBefore;
      const verificationStates = q.getAll("verificationState").filter((s) => s !== "");
      if (verificationStates.length > 0) filter.verificationState = verificationStates;
      // A whitespace-only / empty search means "no search" (the contract trims + min(1)s it).
      const search = q.get("search");
      if (search && search.trim() !== "") filter.search = search;
      if (Object.keys(filter).length > 0) input.filter = filter;
      return input;
    },
  },
  {
    method: "GET",
    path: "/v1/endpoints/{endpointId}/events/tail",
    capability: "events.tail",
    successStatus: 200,
    dispatch: "shared",
    body: false,
    summary: "Pull a watermark-bounded forward page of events (cursor-pull tail)",
    query: [
      {
        name: "sinceCursor",
        description: "Opaque cursor to resume from (mutually exclusive with since).",
        schemaFrom: "sinceCursor",
      },
      {
        name: "since",
        description: "Server-resolved grammar: now | beginning | <duration> | <RFC3339>.",
        schemaFrom: "since",
      },
    ],
    buildInput: (params, q) => {
      const input: Record<string, unknown> = { endpointId: params.endpointId };
      const sinceCursor = q.get("sinceCursor");
      if (sinceCursor !== null) input.sinceCursor = sinceCursor;
      const since = q.get("since");
      if (since !== null) input.since = since;
      return input;
    },
  },
  {
    method: "GET",
    path: "/v1/events/{eventId}",
    capability: "events.get",
    successStatus: 200,
    dispatch: "shared",
    body: false,
    summary: "Get a captured event",
    buildInput: pathParam("eventId", "eventId"),
  },
  {
    method: "GET",
    path: "/v1/events/{eventId}/payload",
    capability: "events.getPayload",
    successStatus: 200,
    dispatch: "payload",
    body: false,
    summary: "Get a captured event's raw payload (base64 envelope)",
    buildInput: pathParam("eventId", "eventId"),
  },
  {
    method: "POST",
    path: "/v1/events/{eventId}/replay",
    capability: "events.replay",
    successStatus: 200,
    dispatch: "replay",
    body: true,
    summary: "Replay an event to a target (records a delivery attempt)",
    buildInput: pathParam("eventId", "eventId"),
  },
  // ── audit ─────────────────────────────────────────────────────────────────────────────────────
  {
    method: "POST",
    path: "/v1/audit/verify",
    capability: "audit.verify",
    successStatus: 200,
    dispatch: "shared",
    body: false,
    summary: "Verify the org's tamper-evident audit chain",
    buildInput: noInput,
  },
  // ── deliveries.* ──────────────────────────────────────────────────────────────────────────────
  {
    method: "GET",
    path: "/v1/deliveries",
    capability: "deliveries.list",
    successStatus: 200,
    dispatch: "shared",
    body: false,
    summary: "List outbound delivery attempts",
    query: [
      ...PAGINATION_QUERY,
      {
        name: "destinationId",
        description: "Filter by destination (empty = no filter).",
        schemaFrom: "destinationId",
      },
      {
        name: "subscriptionId",
        description: "Filter by subscription (empty = no filter).",
        schemaFrom: "subscriptionId",
      },
      {
        name: "status",
        multi: true,
        description: "Filter by delivery status (repeatable).",
        schemaFrom: "status",
      },
    ],
    buildInput: (_params, q) => {
      const input = listInput(q, {});
      const destinationId = q.get("destinationId");
      if (destinationId) input.destinationId = destinationId;
      const subscriptionId = q.get("subscriptionId");
      if (subscriptionId) input.subscriptionId = subscriptionId;
      const status = q.getAll("status").filter((s) => s !== "");
      if (status.length > 0) input.status = status;
      return input;
    },
  },
  {
    method: "GET",
    path: "/v1/deliveries/{deliveryId}",
    capability: "deliveries.get",
    successStatus: 200,
    dispatch: "shared",
    body: false,
    summary: "Get a delivery attempt",
    buildInput: pathParam("deliveryId", "deliveryId"),
  },
  // ── replayDestinations.* (dedicated api-only map) ───────────────────────────────────────────────
  {
    method: "GET",
    path: "/v1/replay-destinations",
    capability: "replayDestinations.list",
    successStatus: 200,
    dispatch: "replayDestinations",
    body: false,
    summary: "List replay destinations (the SSRF-egress allowlist)",
    buildInput: noInput,
  },
  {
    method: "POST",
    path: "/v1/replay-destinations",
    capability: "replayDestinations.create",
    successStatus: 200,
    dispatch: "replayDestinations",
    body: true,
    summary: "Register a replay destination (returns a one-time signing secret)",
    buildInput: noInput,
  },
  {
    method: "DELETE",
    path: "/v1/replay-destinations/{destinationId}",
    capability: "replayDestinations.delete",
    successStatus: 200,
    dispatch: "replayDestinations",
    body: false,
    summary: "Soft-delete a replay destination",
    buildInput: pathParam("destinationId", "destinationId"),
  },
  {
    method: "POST",
    path: "/v1/replay-destinations/{destinationId}/enable",
    capability: "replayDestinations.enable",
    successStatus: 200,
    dispatch: "replayDestinations",
    body: false,
    summary: "Re-enable an auto-disabled replay destination",
    buildInput: pathParam("destinationId", "destinationId"),
  },
  {
    method: "POST",
    path: "/v1/replay-destinations/{destinationId}/ordered",
    capability: "replayDestinations.setOrdered",
    successStatus: 200,
    dispatch: "replayDestinations",
    body: true,
    summary: "Toggle strict-FIFO delivery for a destination",
    buildInput: pathParam("destinationId", "destinationId"),
  },
  {
    method: "POST",
    path: "/v1/replay-destinations/{destinationId}/signing-secret",
    capability: "replayDestinations.rotateSigningSecret",
    successStatus: 200,
    dispatch: "replayDestinations",
    body: false,
    summary: "Rotate a destination's signing secret (returns the new one-time secret)",
    buildInput: pathParam("destinationId", "destinationId"),
  },
  {
    method: "GET",
    path: "/v1/replay-destinations/{destinationId}/signing-secrets",
    capability: "replayDestinations.listSigningSecrets",
    successStatus: 200,
    dispatch: "replayDestinations",
    body: false,
    summary: "List a destination's signing-secret metadata",
    buildInput: pathParam("destinationId", "destinationId"),
  },
  // ── subscriptions.* (dedicated api-only map) ────────────────────────────────────────────────────
  {
    method: "GET",
    path: "/v1/subscriptions",
    capability: "subscriptions.list",
    successStatus: 200,
    dispatch: "subscriptions",
    body: false,
    summary: "List auto-delivery subscriptions",
    query: [
      {
        name: "sourceEndpointId",
        description: "Filter by source endpoint (empty = no filter).",
        schemaFrom: "sourceEndpointId",
      },
    ],
    buildInput: (_params, q) => {
      const sourceEndpointId = q.get("sourceEndpointId");
      return sourceEndpointId ? { sourceEndpointId } : {};
    },
  },
  {
    method: "POST",
    path: "/v1/subscriptions",
    capability: "subscriptions.create",
    successStatus: 200,
    dispatch: "subscriptions",
    body: true,
    summary: "Create (upsert) an auto-delivery subscription",
    buildInput: noInput,
  },
  {
    method: "DELETE",
    path: "/v1/subscriptions/{subscriptionId}",
    capability: "subscriptions.delete",
    successStatus: 200,
    dispatch: "subscriptions",
    body: false,
    summary: "Delete an auto-delivery subscription",
    buildInput: pathParam("subscriptionId", "subscriptionId"),
  },
  // ── whoami (scope-free identity — not a capability) ─────────────────────────────────────────────
  {
    method: "GET",
    path: "/v1/whoami",
    capability: null,
    successStatus: 200,
    dispatch: "whoami",
    body: false,
    summary: "Return the authenticated principal (org, scopes, optional user)",
    buildInput: noInput,
  },
];

// ── matching ──────────────────────────────────────────────────────────────────────────────────────

/** The `{name}` placeholders in a path template, in order. */
export function pathParamNames(path: string): string[] {
  const names: string[] = [];
  for (const seg of path.split("/")) {
    if (seg.startsWith("{") && seg.endsWith("}")) names.push(seg.slice(1, -1));
  }
  return names;
}

/** Template segments for a route path, sans the leading empty segment. */
function templateSegments(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

/**
 * Match a request (method + already-split path segments) to a route, capturing path params. Exact
 * segment-count + literal matching: at most one route matches, so order is irrelevant.
 */
export function matchRoute(
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
): MatchedRoute | null {
  for (const def of ROUTES) {
    if (def.method !== method) continue;
    const tmpl = templateSegments(def.path);
    if (tmpl.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < tmpl.length; i++) {
      const t = tmpl[i]!;
      const seg = segments[i]!;
      if (t.startsWith("{") && t.endsWith("}")) {
        params[t.slice(1, -1)] = seg;
      } else if (t !== seg) {
        ok = false;
        break;
      }
    }
    if (ok) return { def, input: def.buildInput(params, query) };
  }
  return null;
}
