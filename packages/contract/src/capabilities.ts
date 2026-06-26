import {
  DeliveryAttemptSchema,
  EndpointSchema,
  EventSchema,
  EventSummarySchema,
  isUsableStandardWebhooksSecret,
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
});

export const endpointsGet = defineCapability({
  name: "endpoints.get",
  input: z.object({ endpointId: uuid }),
  output: EndpointSchema,
  errors: ["NOT_FOUND", "UNAUTHORIZED", "RATE_LIMITED"],
  auth: { scope: "endpoints:read" },
  semantics: {},
});

// endpoints.create + endpoints.rotate are WRITE capabilities bound on api+cli+mcp (web stays deferred
// with the dashboard epic). Their output is the standard EndpointSchema PLUS `ingestUrl` — the
// wbhk.my/<token> URL that embeds the freshly-minted ingest token. The token is a secret shown EXACTLY
// ONCE: the endpoints table stores only its hash and has no token column, so the URL is unrecoverable
// after creation/rotation. It is therefore never returned by endpoints.get/list.
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
});

// endpoints.delete SOFT-deletes an endpoint (ADR-0076): it stops resolving on the wbhk.my ingest path
// (its KV cache entry is evicted AND the cold lookup filters `deleted_at is null`, so ingest 404s) and
// no longer counts against the per-org create soft cap — while its captured events + R2 payload bodies
// are RETAINED (inspection history; a later retention job hard-purges). Idempotent (idempotent:true): a
// re-delete of an already-deleted endpoint returns its recorded deletedAt; an unknown id is NOT_FOUND.
export const DeletedEndpointSchema = z.object({ id: uuid, deletedAt: z.coerce.date() });
export type DeletedEndpoint = z.infer<typeof DeletedEndpointSchema>;

export const endpointsDelete = defineCapability({
  name: "endpoints.delete",
  input: z.object({ endpointId: uuid }),
  output: DeletedEndpointSchema,
  // FORBIDDEN: a bearer lacking endpoints:write (the api edge 403s before dispatch; on mcp the handler's
  // scope check is the sole gate). NOT_FOUND: an unknown id (a re-delete of an already-deleted endpoint
  // is a 200 idempotent success). RATE_LIMITED reserved for a future per-org delete throttle.
  errors: ["NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN", "VALIDATION_ERROR", "RATE_LIMITED"],
  auth: { scope: "endpoints:write" },
  semantics: { idempotent: true },
});

// endpoints.rotate replaces an endpoint's ingest token (the wbhk.my/<token> secret) IN PLACE (ADR-0076):
// it mints a NEW token, HARD-cuts over (the old token is evicted immediately and stops resolving), and
// returns the new one-time ingestUrl — exactly like create's reveal. The endpoint id, name, paused state,
// captured events, and provider secrets are PRESERVED (unlike delete+recreate). For a leaked/lost URL.
// NOT idempotent: each call mints a new token (the api-client never blind-retries it), same as create.
export const endpointsRotate = defineCapability({
  name: "endpoints.rotate",
  input: z.object({ endpointId: uuid }),
  output: CreatedEndpointSchema,
  errors: ["NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN", "VALIDATION_ERROR", "RATE_LIMITED"],
  auth: { scope: "endpoints:write" },
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

// ── Provider signing-secret management (ADR-0078, decisions D1/D2) ───────────────────────────────
// Per-endpoint inbound-verification secrets. The plaintext secret is sealed under the KMS envelope —
// api/mcp delegate sealing to the engine's ProviderSecretSealer over a service binding and NEVER hold
// the KEK (B0) — and stored as ciphertext only. The secret is accepted on add and is NEVER returned by
// any read; listProviderSecrets returns METADATA ONLY (no ciphertext). Full MCP parity (D2): add/list/
// revoke are bound on api+cli+mcp; the web (dashboard config form) is S1's, so it stays web-deferred.
const ProviderSecretStatusSchema = z.enum(["active", "retiring", "revoked"]);

export const AddedProviderSecretSchema = z.object({
  id: uuid,
  provider: ProviderSchema,
  status: ProviderSecretStatusSchema,
});
export type AddedProviderSecret = z.infer<typeof AddedProviderSecretSchema>;

/** A provider secret's NON-secret metadata — never carries the sealed bytes or the plaintext. */
export const ProviderSecretSummarySchema = z.object({
  id: uuid,
  provider: ProviderSchema,
  status: ProviderSecretStatusSchema,
  label: z.string().nullable(),
  createdAt: z.coerce.date(),
});
export type ProviderSecretSummary = z.infer<typeof ProviderSecretSummarySchema>;

export const RevokedProviderSecretSchema = z.object({ id: uuid, revokedAt: z.coerce.date() });
export type RevokedProviderSecret = z.infer<typeof RevokedProviderSecretSchema>;

export const endpointsAddProviderSecret = defineCapability({
  name: "endpoints.addProviderSecret",
  // The plaintext signing secret is the one secret IN: sealed by the engine, never persisted as
  // plaintext, never echoed back. NOT_FOUND for an unknown/cross-org endpoint; FORBIDDEN without
  // endpoints:write (mcp's sole gate is the handler scope check).
  input: z
    .object({
      endpointId: uuid,
      provider: ProviderSchema,
      label: z.string().trim().min(1).max(200).optional(),
      secret: z.string().min(1).max(4096),
    })
    // A Standard Webhooks secret is `whsec_`+base64; the verify path strips the prefix and base64-
    // decodes the remainder to the raw key. Validate at the schema boundary with the SAME decoder
    // (isUsableStandardWebhooksSecret) so a value that matches the base64 alphabet but is not valid
    // base64 (e.g. a length ≡ 1 mod 4 paste, hex, or raw) is rejected up front — otherwise it would
    // store fine yet decode to nothing and verify as NO_MATCHING_KEY forever (indistinguishable from
    // "no secret"). Single-sourced here so every surface (api/mcp) enforces it identically.
    .superRefine((val, ctx) => {
      if (val.provider === "standard_webhooks" && !isUsableStandardWebhooksSecret(val.secret)) {
        ctx.addIssue({
          code: "custom",
          path: ["secret"],
          message: "a standard_webhooks secret must be whsec_ followed by standard base64",
        });
      }
    }),
  output: AddedProviderSecretSchema,
  errors: ["NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN", "VALIDATION_ERROR", "RATE_LIMITED"],
  auth: { scope: "endpoints:write" },
  semantics: {},
  surfaceExempt: { web: WEB_DEFERRED },
});

export const endpointsListProviderSecrets = defineCapability({
  name: "endpoints.listProviderSecrets",
  input: z.object({ endpointId: uuid }),
  // Metadata only — the sealed ciphertext + plaintext are never in the output. A read scope: an agent
  // can audit which providers are configured + each secret's status without write power. NOT paginated:
  // an endpoint's provider secrets are a human-managed handful (a couple active/retiring + the revoked
  // history of rotations), so the whole set is returned at once — no cursor, no limit (don't advertise
  // pagination the surface doesn't implement).
  output: z.object({ items: z.array(ProviderSecretSummarySchema) }),
  errors: ["UNAUTHORIZED", "VALIDATION_ERROR", "RATE_LIMITED"],
  auth: { scope: "endpoints:read" },
  semantics: {},
  surfaceExempt: { web: WEB_DEFERRED },
});

export const endpointsRevokeProviderSecret = defineCapability({
  name: "endpoints.revokeProviderSecret",
  // Revoking removes the secret from the honored set AND evicts the ingest KV cache (ADR-0015) so the
  // verify path stops honoring it immediately. NOT_FOUND if the secret isn't an active/retiring one
  // belonging to this endpoint (a re-revoke of an already-revoked secret is NOT_FOUND).
  input: z.object({ endpointId: uuid, secretId: uuid }),
  output: RevokedProviderSecretSchema,
  errors: ["NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN", "VALIDATION_ERROR", "RATE_LIMITED"],
  auth: { scope: "endpoints:write" },
  semantics: {},
  surfaceExempt: { web: WEB_DEFERRED },
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
  endpointsDelete,
  endpointsRotate,
  endpointsAddProviderSecret,
  endpointsListProviderSecrets,
  endpointsRevokeProviderSecret,
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
