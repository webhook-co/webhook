import {
  DeliveryAttemptSchema,
  EndpointSchema,
  EventSchema,
  EventSummarySchema,
  LagSchema,
  ProviderSchema,
  WATERMARK_DELTA_MS,
} from "@webhook-co/shared";
import { z } from "zod";

import { defineCapability, type AnyCapability } from "./capability";
import { TargetSchema } from "./target";

// The six wedge capabilities. Inputs are small Zod objects; outputs
// reuse the shared entity schemas (one definition). The cursor is the opaque string
// from packages/shared (HMAC-signed); pagination wraps items + nextCursor.

const uuid = z.uuid();
const cursor = z.string();

// Documented parity exemptions (each capability declares which GA surfaces it is NOT yet bound
// on, with a reason — see parity.ts). These are the durable, dated reasons the conformance gate
// reads back; lifting one is the checklist item that fails the build if a surface forgets to bind.
/** The browser dashboard (read views) is deferred to the frontend epic — no web binding yet. */
const WEB_DEFERRED = "dashboard read views deferred to the frontend epic";
/** events.replay's mcp exemption — the localhost-tunnel target is CLI-intrinsic (no agent localhost). */
const REPLAY_MCP_EXEMPT =
  "the localhost-tunnel target is CLI-intrinsic — an agent has no user-localhost session (remote targets are a future Target kind per ADR-0005)";
/**
 * events.getPayload is exempt on mcp: raw payload bytes don't fit the MCP text-tool model, and the
 * McpAgent has no R2 binding — an agent reads event metadata via events.get. Revisit if an agent
 * payload-preview is needed (would add R2 to apps/mcp + a text/base64 representation). See ADR-0015.
 */
const PAYLOAD_MCP_EXEMPT =
  "raw payload bytes; the McpAgent has no R2 binding (agents use events.get)";

function paged<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), nextCursor: cursor.nullable() });
}

export const endpointsList = defineCapability({
  name: "endpoints.list",
  input: z.object({
    cursor: cursor.optional(),
    limit: z.number().int().positive().max(200).optional(),
  }),
  output: paged(EndpointSchema),
  errors: ["UNAUTHORIZED", "VALIDATION_ERROR", "RATE_LIMITED"],
  auth: { scope: "endpoints:read" },
  semantics: { paginated: true },
  surfaceExempt: { web: WEB_DEFERRED },
});

export const endpointsGet = defineCapability({
  name: "endpoints.get",
  input: z.object({ endpointId: uuid }),
  output: EndpointSchema,
  errors: ["NOT_FOUND", "UNAUTHORIZED", "RATE_LIMITED"],
  auth: { scope: "endpoints:read" },
  semantics: {},
  surfaceExempt: { web: WEB_DEFERRED },
});

// endpoints.create is the one WRITE capability bound on api+cli+mcp (web stays deferred with the
// dashboard epic). Its output is the standard EndpointSchema PLUS `ingestUrl` — the wbhk.my/<token>
// URL that embeds the freshly-minted ingest token. The token is a secret shown EXACTLY ONCE: the
// endpoints table stores only its hash and has no token column, so the URL is unrecoverable after
// creation (rotation = create a new endpoint). It is therefore never returned by endpoints.get/list.
export const CreatedEndpointSchema = EndpointSchema.extend({ ingestUrl: z.url() });
export type CreatedEndpoint = z.infer<typeof CreatedEndpointSchema>;

export const endpointsCreate = defineCapability({
  name: "endpoints.create",
  input: z.object({ name: z.string().trim().min(1).max(200) }),
  output: CreatedEndpointSchema,
  // FORBIDDEN: a bearer lacking endpoints:write (the api edge returns 403 before dispatch; mcp has no
  // edge scope gate, so the handler's scope check is the sole gate there). RATE_LIMITED: the per-org
  // endpoint soft cap (ADR-0074) — an abuse backstop, since there is no endpoints.delete yet. Not
  // idempotent: each call mints a new endpoint + token (the api-client never blind-retries this POST).
  errors: ["UNAUTHORIZED", "FORBIDDEN", "VALIDATION_ERROR", "RATE_LIMITED"],
  auth: { scope: "endpoints:write" },
  semantics: {},
  surfaceExempt: { web: WEB_DEFERRED },
});

export const eventsList = defineCapability({
  name: "events.list",
  input: z.object({
    endpointId: uuid,
    cursor: cursor.optional(),
    limit: z.number().int().positive().max(200).optional(),
    filter: z.object({ provider: ProviderSchema }).optional(),
  }),
  // events.list is a newest-first browse; it carries headCursor only (the watermark-bounded resumable
  // position) — caughtUp/lag are forward-tail concepts that don't map onto a DESC browse.
  output: paged(EventSummarySchema).extend({ headCursor: cursor.nullable().optional() }),
  errors: ["NOT_FOUND", "UNAUTHORIZED", "VALIDATION_ERROR", "RATE_LIMITED"],
  auth: { scope: "events:read" },
  semantics: { paginated: true },
  surfaceExempt: { web: WEB_DEFERRED },
});

export const eventsGet = defineCapability({
  name: "events.get",
  input: z.object({ eventId: uuid }),
  output: EventSchema,
  errors: ["NOT_FOUND", "UNAUTHORIZED", "RATE_LIMITED"],
  auth: { scope: "events:read" },
  semantics: {},
  surfaceExempt: { web: WEB_DEFERRED },
});

export const eventsGetPayload = defineCapability({
  name: "events.getPayload",
  input: z.object({ eventId: uuid }),
  // The raw body, base64-wrapped in a JSON envelope (ADR-0015): keeps the all-JSON, schema-validated
  // contract uniform (raw bytes would need a bespoke binary transport + a non-JSON client path),
  // is lossless for binary payloads + exact-byte signature fidelity, and is MCP-shaped if ever bound
  // there. `bytes` is the decoded length (a cheap integrity check for the client).
  output: z.object({
    contentType: z.string().nullable(),
    bytes: z.number().int().nonnegative(),
    bodyBase64: z.string(),
  }),
  // Errors mirror events.get (getPayload reuses that handler's RLS read): a non-uuid id surfaces as
  // the shared get-by-id VALIDATION_ERROR (400), same as events.get — not separately enumerated.
  errors: ["NOT_FOUND", "UNAUTHORIZED", "RATE_LIMITED"],
  auth: { scope: "events:read" },
  semantics: {},
  // Bound on api + cli; web stays deferred with the dashboard epic; mcp is exempt (see above).
  surfaceExempt: { web: WEB_DEFERRED, mcp: PAYLOAD_MCP_EXEMPT },
});

export const eventsTail = defineCapability({
  name: "events.tail",
  // `since` is the server-resolved `--since` grammar (now|beginning|<duration>|<RFC3339>); mutually
  // exclusive with the opaque `sinceCursor` (enforced in the handler). MCP advertises it via inputShape.
  input: z.object({
    endpointId: uuid,
    sinceCursor: cursor.optional(),
    since: z.string().optional(),
  }),
  // Additive cursor-contract fields (the ADR amends 0014): headCursor = the watermark-bounded latest
  // (NEVER raw MAX), caughtUp = the page reached that head, lag = the capped backlog metric. Optional,
  // so existing consumers + the parity gate are unaffected; surfaced identically on api + mcp.
  output: paged(EventSummarySchema).extend({
    headCursor: cursor.nullable().optional(),
    caughtUp: z.boolean().optional(),
    lag: LagSchema.optional(),
  }),
  errors: ["NOT_FOUND", "UNAUTHORIZED", "VALIDATION_ERROR", "RATE_LIMITED"],
  auth: { scope: "events:read" },
  // Canonical = cursor pull (so MCP can consume it), with the gapless watermark. The live WS tunnel
  // (LISTEN_SESSION DO) is a separate CLI transport over the same watermark+cursor; api/mcp bind the
  // cursor-pull form. Bound on cli/api/mcp as of slice 11; the web read view stays deferred.
  semantics: { streaming: true, paginated: true, watermark: { deltaMs: WATERMARK_DELTA_MS } },
  surfaceExempt: { web: WEB_DEFERRED },
});

// The audit-chain verifier (ADR-0004). Walks an org's tamper-evident audit
// chain and reports the first break, if any. Surfaced on every GA surface (a compliance
// operator runs it from the CLI/API/web; an agent runs it over MCP). The output mirrors
// the verifyAuditChain result in packages/shared — `ok` plus, on failure, the first
// break (kind + seq + detail).
const auditBreakKind = z.enum([
  "wrong_org",
  "bad_genesis_seq",
  "bad_genesis_prev_hash",
  "duplicate_seq",
  "seq_gap",
  "broken_link",
  "hash_mismatch",
]);

export const auditVerify = defineCapability({
  name: "audit.verify",
  input: z.object({}),
  output: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), rowsVerified: z.number().int().nonnegative() }),
    z.object({
      ok: z.literal(false),
      rowsVerified: z.number().int().nonnegative(),
      break: z.object({
        kind: auditBreakKind,
        seq: z.number().int().positive(),
        detail: z.string(),
      }),
    }),
  ]),
  errors: ["UNAUTHORIZED", "FORBIDDEN", "RATE_LIMITED"],
  auth: { scope: "audit:read" },
  semantics: {},
  surfaceExempt: { web: WEB_DEFERRED },
});

export const eventsReplay = defineCapability({
  name: "events.replay",
  input: z.object({ eventId: uuid, target: TargetSchema, idempotencyKey: z.string().min(1) }),
  output: DeliveryAttemptSchema,
  errors: ["NOT_FOUND", "ENDPOINT_PAUSED", "TARGET_UNREACHABLE", "UNAUTHORIZED", "RATE_LIMITED"],
  auth: { scope: "events:replay" },
  semantics: { idempotent: true },
  // Bound on the CLI (`replay` / `listen --forward`) + api (records the delivery_attempt server-side,
  // PR3). mcp stays exempt: the localhost-tunnel target is CLI-intrinsic (an agent has no localhost).
  surfaceExempt: { web: WEB_DEFERRED, mcp: REPLAY_MCP_EXEMPT },
});

/**
 * The capability surface every binding implements. The six wedge capabilities
 * plus `audit.verify` — the compliance-by-design audit-chain verifier (ADR-0004),
 * surfaced for CLI/API/web/MCP parity.
 */
export const CAPABILITIES: readonly AnyCapability[] = [
  endpointsList,
  endpointsGet,
  endpointsCreate,
  eventsList,
  eventsGet,
  eventsGetPayload,
  eventsTail,
  eventsReplay,
  auditVerify,
];

/** Registry keyed by stable capability name. */
export const CAPABILITY_REGISTRY: ReadonlyMap<string, AnyCapability> = new Map(
  CAPABILITIES.map((c) => [c.name, c]),
);
