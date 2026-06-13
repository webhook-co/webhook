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

// The six wedge capabilities to freeze (§0.9). Inputs are small Zod objects; outputs
// reuse the shared entity schemas (one definition). The cursor is the opaque string
// from packages/shared (HMAC-signed); pagination wraps items + nextCursor.

const uuid = z.uuid();
const cursor = z.string();

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
});

export const endpointsGet = defineCapability({
  name: "endpoints.get",
  input: z.object({ endpointId: uuid }),
  output: EndpointSchema,
  errors: ["NOT_FOUND", "UNAUTHORIZED", "RATE_LIMITED"],
  auth: { scope: "endpoints:read" },
  semantics: {},
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
});

export const eventsGet = defineCapability({
  name: "events.get",
  input: z.object({ eventId: uuid }),
  output: EventSchema,
  errors: ["NOT_FOUND", "UNAUTHORIZED", "RATE_LIMITED"],
  auth: { scope: "events:read" },
  semantics: {},
});

export const eventsTail = defineCapability({
  name: "events.tail",
  input: z.object({ endpointId: uuid, sinceCursor: cursor.optional() }),
  output: paged(EventSummarySchema),
  errors: ["NOT_FOUND", "UNAUTHORIZED", "VALIDATION_ERROR", "RATE_LIMITED"],
  auth: { scope: "events:read" },
  // Canonical = cursor pull (so MCP can consume it), with the gapless watermark.
  semantics: { streaming: true, paginated: true, watermark: { deltaMs: WATERMARK_DELTA_MS } },
});

// The audit-chain verifier (§0.7, ADR-0004, H2). Walks an org's tamper-evident audit
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
});

export const eventsReplay = defineCapability({
  name: "events.replay",
  input: z.object({ eventId: uuid, target: TargetSchema, idempotencyKey: z.string().min(1) }),
  output: DeliveryAttemptSchema,
  errors: ["NOT_FOUND", "ENDPOINT_PAUSED", "TARGET_UNREACHABLE", "UNAUTHORIZED", "RATE_LIMITED"],
  auth: { scope: "events:replay" },
  semantics: { idempotent: true },
});

/**
 * The capability surface every binding implements. The six wedge capabilities (§0.9)
 * plus `audit.verify` — the compliance-by-design audit-chain verifier (§0.7, ADR-0004),
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
