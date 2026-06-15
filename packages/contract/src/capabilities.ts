import {
  DeliveryAttemptSchema,
  EndpointSchema,
  EventSchema,
  EventSummarySchema,
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
/** events.replay's replay-to-localhost engine lands in slice 12. */
const REPLAY_SLICE_12 = "replay-to-localhost engine lands in slice 12";

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

export const eventsList = defineCapability({
  name: "events.list",
  input: z.object({
    endpointId: uuid,
    cursor: cursor.optional(),
    limit: z.number().int().positive().max(200).optional(),
    filter: z.object({ provider: ProviderSchema }).optional(),
  }),
  output: paged(EventSummarySchema),
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

export const eventsTail = defineCapability({
  name: "events.tail",
  input: z.object({ endpointId: uuid, sinceCursor: cursor.optional() }),
  output: paged(EventSummarySchema),
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
  // Bound today only on the CLI's command tree (`replay`); the replay-to-localhost engine
  // lands in slice 12, when the api/mcp exemptions lift.
  surfaceExempt: { web: WEB_DEFERRED, api: REPLAY_SLICE_12, mcp: REPLAY_SLICE_12 },
});

/**
 * The capability surface every binding implements. The six wedge capabilities
 * plus `audit.verify` — the compliance-by-design audit-chain verifier (ADR-0004),
 * surfaced for CLI/API/web/MCP parity.
 */
export const CAPABILITIES: readonly AnyCapability[] = [
  endpointsList,
  endpointsGet,
  eventsList,
  eventsGet,
  eventsTail,
  eventsReplay,
  auditVerify,
];

/** Registry keyed by stable capability name. */
export const CAPABILITY_REGISTRY: ReadonlyMap<string, AnyCapability> = new Map(
  CAPABILITIES.map((c) => [c.name, c]),
);
