// The OpenAPI 3.1 generator: derives the spec from the Zod v4 capability contract + the declarative
// route manifest. Schemas come straight from the contract (z.toJSONSchema, so they can't drift from the
// runtime validators); the HTTP envelope (verbs/paths/status/errors) comes from ROUTES (the same table the
// router consumes). The committed src/openapi.json is the golden artifact the drift-guard test re-derives.
//
// Correctness boundaries the derive approach cannot cover on its own — encoded deliberately here and
// re-checked by the runtime conformance test in apps/api:
//   • the two `.superRefine` request bodies lose their predicate (SW-secret base64 / URL canonicalization)
//     in JSON Schema — re-added as prose in the request-body description, never a fabricated `pattern`;
//   • 401/403 are EMPTY-body responses with a WWW-Authenticate header (not the JSON {error,message});
//   • every success is 200 (no 201/204) — a manifest fact, asserted by the drift guard.

import {
  AuthContextSchema,
  CAPABILITIES,
  CreatedEndpointSchema,
  CreatedReplayDestinationSchema,
  DeletedEndpointSchema,
  AddedProviderSecretSchema,
  ProviderSecretSummarySchema,
  ReplayDestinationDeletedSchema,
  RevokedProviderSecretSchema,
  RotatedSigningSecretSchema,
  SigningSecretMetadataSchema,
  SubscriptionDeletedSchema,
  type AnyCapability,
} from "@webhook-co/contract";
import {
  DeliveryAttemptSchema,
  DeliverySchema,
  DeliveryStatusSchema,
  EndpointSchema,
  EventSchema,
  EventSummarySchema,
  ProviderSchema,
  ReplayDestinationSchema,
  SubscriptionSchema,
  VerificationResultSchema,
  VerificationStateSchema,
} from "@webhook-co/shared";
import { z } from "zod";

import {
  ROUTES,
  httpStatusForCapabilityError,
  pathParamNames,
  type QueryParamDef,
  type RouteDef,
} from "./routes.js";

export type JsonObject = Record<string, unknown>;
export interface OpenApiDocument extends JsonObject {
  openapi: "3.1.0";
  info: JsonObject;
  paths: JsonObject;
  components: JsonObject;
}

/** The published API version stamped into `info.version` (see the release automation slice). */
export const API_VERSION = "1.0.0";
const API_BASE_URL = "https://api.webhook.co";

// ── schema → JSON Schema plumbing ───────────────────────────────────────────────────────────────

/**
 * Upgrade `z.coerce.date()` (a `ZodDate`, otherwise unrepresentable) to `{type:"string",format:"date-time"}`.
 * FAIL-CLOSED allowlist: `unrepresentable:"any"` globally suppresses the throw for every unrepresentable
 * node (turning it into `{}`), so this override MUST throw on anything it doesn't explicitly render — else a
 * future `.transform()`/`bigint` would silently emit an empty (any) schema. Dates are the only expected case.
 */
function dateOverride(ctx: {
  zodSchema: { _zod: { def: { type: string } } };
  jsonSchema: JsonObject;
}): void {
  const type = ctx.zodSchema._zod.def.type;
  if (type === "date") {
    ctx.jsonSchema.type = "string";
    ctx.jsonSchema.format = "date-time";
    return;
  }
  // A `{}` (any) node means an unrepresentable schema slipped through — the only sanctioned one is a date.
  if (Object.keys(ctx.jsonSchema).length === 0) {
    throw new Error(
      `openapi: refusing to emit an empty (any) schema for an unrepresentable Zod node of type "${type}" — ` +
        "add an explicit override before shipping a lossy schema",
    );
  }
}

const REF_URI = (id: string): string => `#/components/schemas/${id}`;

/** Strip the per-document keywords Zod stamps on each registered schema (invalid inside OpenAPI components). */
function stripSchemaMeta(schema: JsonObject): JsonObject {
  const { $schema, $id, ...rest } = schema;
  void $schema;
  void $id;
  return rest;
}

// ── component schema names ──────────────────────────────────────────────────────────────────────

/** "endpoints.list" → "EndpointsList"; "replayDestinations.rotateSigningSecret" → "ReplayDestinationsRotateSigningSecret". */
function pascalOfCapability(name: string): string {
  return name
    .split(".")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}
/** A clean SDK method name: "endpoints.list" → "endpointsList". */
function operationIdOf(name: string): string {
  const p = pascalOfCapability(name);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

// The stable, named entity/enum components. Registering a schema instance under one id makes every
// reference to it a $ref (shared model + no inlined 130-provider enum), which is what a codegen tool needs
// to emit clean, named model classes.
const ENTITY_COMPONENTS: ReadonlyArray<readonly [z.ZodTypeAny, string]> = [
  [EndpointSchema, "Endpoint"],
  [CreatedEndpointSchema, "CreatedEndpoint"],
  [DeletedEndpointSchema, "DeletedEndpoint"],
  [EventSummarySchema, "EventSummary"],
  [EventSchema, "Event"],
  [AddedProviderSecretSchema, "AddedProviderSecret"],
  [ProviderSecretSummarySchema, "ProviderSecretSummary"],
  [RevokedProviderSecretSchema, "RevokedProviderSecret"],
  [DeliveryAttemptSchema, "DeliveryAttempt"],
  [DeliverySchema, "Delivery"],
  [ReplayDestinationSchema, "ReplayDestination"],
  [CreatedReplayDestinationSchema, "CreatedReplayDestination"],
  [ReplayDestinationDeletedSchema, "ReplayDestinationDeleted"],
  [RotatedSigningSecretSchema, "RotatedSigningSecret"],
  [SigningSecretMetadataSchema, "SigningSecretMetadata"],
  [SubscriptionSchema, "Subscription"],
  [SubscriptionDeletedSchema, "SubscriptionDeleted"],
  [AuthContextSchema, "AuthContext"],
  // Shared enums / structured values — as components so they become named, reused types.
  [ProviderSchema, "Provider"],
  [VerificationStateSchema, "VerificationState"],
  [DeliveryStatusSchema, "DeliveryStatus"],
  [VerificationResultSchema, "VerificationResult"],
];

// ── request-body descriptions for the constraints JSON Schema can't carry ─────────────────────────
// The two `.superRefine` inputs lose their predicate in derivation; we state it as prose (never a fake
// pattern) so a consumer isn't misled into thinking any string is accepted.
const REQUEST_BODY_NOTES: Record<string, string> = {
  "endpoints.addProviderSecret":
    "The server additionally validates the secret shape per provider (e.g. a Standard-Webhooks secret must be base64 key material); a malformed value is rejected with 400 VALIDATION_ERROR.",
  "replayDestinations.create":
    "`url` must be a public HTTPS URL (no IP-literal host, credentials, disallowed port, or bare hostname); the server rejects a non-conforming URL with 400 VALIDATION_ERROR.",
};

// ── input JSON-schema helpers ─────────────────────────────────────────────────────────────────────

function inputJsonSchema(cap: AnyCapability): JsonObject {
  return stripSchemaMeta(
    z.toJSONSchema(cap.input, {
      target: "draft-2020-12",
      io: "input",
      unrepresentable: "any",
      override: dateOverride,
    }) as JsonObject,
  );
}

/** Walk a dotted path (e.g. "filter.provider") into an input JSON schema's nested `properties`. */
function resolveInputPath(inputJson: JsonObject, dotted: string): JsonObject | undefined {
  let node: JsonObject | undefined = inputJson;
  for (const key of dotted.split(".")) {
    const props = node?.properties as Record<string, JsonObject> | undefined;
    node = props?.[key];
    if (node === undefined) return undefined;
  }
  return node;
}

/** For a repeatable query param, the item schema of the `anyOf[..array..]` branch of a multiEnum field. */
function multiItemSchema(node: JsonObject): JsonObject {
  const anyOf = node.anyOf as JsonObject[] | undefined;
  const arrayBranch = anyOf?.find((b) => b.type === "array");
  return (arrayBranch?.items as JsonObject) ?? { type: "string" };
}

/**
 * Resolve a param's schema from the capability input, FAIL-CLOSED: a `schemaFrom`/path-param name that
 * doesn't resolve (a stale/mistyped manifest reference) throws at build time rather than silently emitting a
 * lossy untyped `{type:"string"}` — the same fail-closed posture as dateOverride. Otherwise a renamed
 * contract field would quietly downgrade an enum-typed param to an unconstrained string with no test failure.
 */
function requireInputSchema(
  inputJson: JsonObject,
  capabilityName: string,
  dotted: string,
): JsonObject {
  const source = resolveInputPath(inputJson, dotted);
  if (source === undefined) {
    throw new Error(
      `openapi: ${capabilityName} has no input field "${dotted}" to source a parameter schema from — ` +
        "the manifest references a field the contract input doesn't define (fix the schemaFrom/path param)",
    );
  }
  return source;
}

function queryParameter(
  inputJson: JsonObject,
  capabilityName: string,
  q: QueryParamDef,
): JsonObject {
  const source = requireInputSchema(inputJson, capabilityName, q.schemaFrom);
  if (q.multi) {
    return {
      name: q.name,
      in: "query",
      required: false,
      description: q.description,
      style: "form",
      explode: true,
      schema: { type: "array", items: multiItemSchema(source) },
    };
  }
  return {
    name: q.name,
    in: "query",
    required: false,
    description: q.description,
    schema: source,
  };
}

function pathParameter(inputJson: JsonObject, capabilityName: string, name: string): JsonObject {
  return {
    name,
    in: "path",
    required: true,
    schema: requireInputSchema(inputJson, capabilityName, name),
  };
}

/** The request body schema = the capability input minus the path-param properties. */
function requestBodySchema(cap: AnyCapability, path: string): JsonObject {
  const json = inputJsonSchema(cap);
  const pathParams = new Set(pathParamNames(path));
  const properties = { ...(json.properties as Record<string, JsonObject> | undefined) };
  for (const p of pathParams) delete properties[p];
  const required = ((json.required as string[] | undefined) ?? []).filter(
    (r) => !pathParams.has(r),
  );
  const body: JsonObject = { type: "object", properties };
  if (required.length > 0) body.required = required;
  return body;
}

// ── components ────────────────────────────────────────────────────────────────────────────────────

function buildComponentSchemas(): { schemas: JsonObject; responseRef: Map<string, string> } {
  const reg = z.registry<{ id: string }>();
  const idOf = new Map<z.ZodTypeAny, string>();
  for (const [schema, id] of ENTITY_COMPONENTS) {
    reg.add(schema, { id });
    idOf.set(schema, id);
  }
  // Each capability response: reuse the entity component if the output IS one, else register a wrapper.
  const responseRef = new Map<string, string>();
  for (const cap of CAPABILITIES) {
    const existing = idOf.get(cap.output);
    if (existing !== undefined) {
      responseRef.set(cap.name, existing);
      continue;
    }
    const id = `${pascalOfCapability(cap.name)}Response`;
    reg.add(cap.output, { id });
    idOf.set(cap.output, id);
    responseRef.set(cap.name, id);
  }

  const emitted = z.toJSONSchema(reg, {
    target: "draft-2020-12",
    io: "output",
    unrepresentable: "any",
    uri: REF_URI,
    override: dateOverride,
  }).schemas as Record<string, JsonObject>;

  const schemas: JsonObject = {};
  for (const [id, schema] of Object.entries(emitted)) schemas[id] = stripSchemaMeta(schema);

  // Request-body components (one per body-bearing route), inserted alongside the response schemas.
  for (const route of ROUTES) {
    if (!route.body || route.capability === null) continue;
    const cap = CAPABILITIES.find((c) => c.name === route.capability);
    if (cap === undefined) continue;
    const body = requestBodySchema(cap, route.path);
    const note = REQUEST_BODY_NOTES[route.capability];
    if (note) body.description = note;
    schemas[`${pascalOfCapability(route.capability)}Request`] = body;
  }

  // The JSON error envelope ({error,message}) returned by capability faults (400/404/409/429/502).
  schemas.Error = {
    type: "object",
    description: "The JSON error envelope for capability faults.",
    properties: {
      error: { type: "string", description: "A stable capability-error code." },
      message: { type: "string", description: "A human-readable description." },
    },
    required: ["error", "message"],
  };

  return { schemas, responseRef };
}

// Shared responses. 401/403 are EMPTY-body with a WWW-Authenticate header (RFC 6750); 500 is text/plain;
// the JSON faults reference the Error schema.
function buildResponseComponents(): JsonObject {
  const jsonError = (description: string): JsonObject => ({
    description,
    content: { "application/json": { schema: { $ref: REF_URI("Error") } } },
  });
  const wwwAuthHeader: JsonObject = {
    description: "RFC 6750 Bearer challenge.",
    schema: { type: "string" },
  };
  return {
    Unauthorized: {
      description:
        "Missing or invalid bearer credential. Empty body; the WWW-Authenticate header carries the challenge.",
      headers: { "WWW-Authenticate": wwwAuthHeader },
    },
    Forbidden: {
      description:
        "The credential is valid but lacks the required scope. Empty body; WWW-Authenticate carries the challenge.",
      headers: { "WWW-Authenticate": wwwAuthHeader },
    },
    BadRequest: jsonError("The request failed validation."),
    NotFound: jsonError("The referenced resource was not found."),
    Conflict: jsonError("The request conflicts with the resource's current state."),
    TooManyRequests: jsonError("A rate limit or soft cap was exceeded."),
    BadGateway: jsonError("The delivery target was unreachable."),
    InternalError: {
      description: "An unexpected server error. The body is a plain-text sentinel.",
      content: { "text/plain": { schema: { type: "string" } } },
    },
  };
}

/** Map a capability error code to the shared response-component name for its HTTP status. */
const STATUS_RESPONSE: Record<number, string> = {
  400: "BadRequest",
  401: "Unauthorized",
  403: "Forbidden",
  404: "NotFound",
  409: "Conflict",
  429: "TooManyRequests",
  502: "BadGateway",
};

// ── tags ────────────────────────────────────────────────────────────────────────────────────────

function tagOf(route: RouteDef): string {
  if (route.capability === null) return "Identity";
  const prefix = route.capability.split(".")[0]!;
  const map: Record<string, string> = {
    endpoints: "Endpoints",
    events: "Events",
    audit: "Audit",
    deliveries: "Deliveries",
    replayDestinations: "Replay Destinations",
    subscriptions: "Subscriptions",
  };
  return map[prefix] ?? prefix;
}

// ── paths ─────────────────────────────────────────────────────────────────────────────────────────

function buildOperation(route: RouteDef, responseRef: Map<string, string>): JsonObject {
  const cap =
    route.capability === null ? null : CAPABILITIES.find((c) => c.name === route.capability);
  const capabilityName = route.capability ?? "whoami";
  const inputJson = cap ? inputJsonSchema(cap) : { type: "object", properties: {} };

  const pathParams = pathParamNames(route.path);
  const parameters: JsonObject[] = [];
  for (const name of pathParams) parameters.push(pathParameter(inputJson, capabilityName, name));
  for (const q of route.query ?? []) parameters.push(queryParameter(inputJson, capabilityName, q));

  // 200 success: reference the response component (identity route → AuthContext).
  const successRef = route.capability === null ? "AuthContext" : responseRef.get(route.capability)!;
  const responses: JsonObject = {
    "200": {
      description: "Success.",
      content: { "application/json": { schema: { $ref: REF_URI(successRef) } } },
    },
  };
  // The truthful error set is the union of the TRANSPORT-class faults (which apply by route shape,
  // independent of a capability's declared taxonomy) and the capability's DOMAIN faults. Deriving only from
  // cap.errors under-declares: the auth gate 403s EVERY scoped route (insufficient_scope), and input
  // validation 400s EVERY route that has a path param / query / body — regardless of what the taxonomy lists.
  const statuses = new Set<number>([401, 500]); // every authed route can 401 (gate) + 500 (operational).
  if (route.capability !== null) statuses.add(403); // the scope gate 403s every capability route (not whoami).
  const validatesInput = pathParams.length > 0 || (route.query?.length ?? 0) > 0 || route.body;
  if (validatesInput) statuses.add(400); // a bad path/query/body value → VALIDATION_ERROR → 400.
  if (cap) for (const code of cap.errors) statuses.add(httpStatusForCapabilityError(code)); // domain faults.
  for (const status of [...statuses].sort((a, b) => a - b)) {
    if (status === 500) {
      responses["500"] = { $ref: "#/components/responses/InternalError" };
    } else {
      const name = STATUS_RESPONSE[status];
      if (name) responses[String(status)] = { $ref: `#/components/responses/${name}` };
    }
  }

  const op: JsonObject = {
    operationId: route.capability === null ? "whoami" : operationIdOf(route.capability),
    summary: route.summary,
    tags: [tagOf(route)],
    security: [{ bearerAuth: [] }],
    responses,
  };
  if (parameters.length > 0) op.parameters = parameters;
  if (route.body && route.capability !== null) {
    op.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: REF_URI(`${pascalOfCapability(route.capability)}Request`) },
        },
      },
    };
  }
  return op;
}

function buildPaths(responseRef: Map<string, string>): JsonObject {
  const paths: JsonObject = {};
  for (const route of ROUTES) {
    const item = (paths[route.path] as JsonObject | undefined) ?? {};
    item[route.method.toLowerCase()] = buildOperation(route, responseRef);
    paths[route.path] = item;
  }
  return paths;
}

// ── document ──────────────────────────────────────────────────────────────────────────────────────

const TAGS: JsonObject[] = [
  {
    name: "Endpoints",
    description: "Create, inspect, and manage ingest endpoints and their secrets.",
  },
  { name: "Events", description: "Browse, fetch, tail, and replay captured events." },
  { name: "Deliveries", description: "Observe outbound delivery attempts." },
  {
    name: "Replay Destinations",
    description: "Manage the allowlist of remote delivery destinations.",
  },
  { name: "Subscriptions", description: "Configure auto-delivery routing rules." },
  { name: "Audit", description: "Verify the tamper-evident audit chain." },
  { name: "Identity", description: "Inspect the authenticated principal." },
];

/** Build the full OpenAPI 3.1 document from the contract + the route manifest. Pure + deterministic. */
export function buildOpenApiDocument(): OpenApiDocument {
  const { schemas, responseRef } = buildComponentSchemas();
  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: {
      title: "webhook.co API",
      version: API_VERSION,
      description:
        "The webhook.co REST API: create ingest endpoints, inspect captured events, manage delivery " +
        "destinations and subscriptions, and replay events. All requests are authenticated with a bearer " +
        "`whk_` API key. Responses are JSON; every successful response is HTTP 200. Errors use a JSON " +
        "`{error, message}` envelope, except 401/403 which are empty-bodied with a WWW-Authenticate header.",
      license: { name: "Apache-2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
    },
    servers: [{ url: API_BASE_URL, description: "Production" }],
    security: [{ bearerAuth: [] }],
    tags: TAGS,
    paths: buildPaths(responseRef),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "opaque",
          description: "A `whk_`-prefixed API key (opaque; not a JWT).",
        },
      },
      responses: buildResponseComponents(),
      schemas,
    },
  };
}
