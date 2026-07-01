import {
  canonicalizeAndValidateUrl,
  CONFIGURED_HEADER_PROVIDERS,
  DeliveryAttemptSchema,
  DeliverySchema,
  DeliveryStatusSchema,
  EndpointSchema,
  EventSchema,
  EventSummarySchema,
  isUsableConfiguredHeaderSecret,
  isUsableStandardWebhooksSecret,
  LagSchema,
  ProviderSchema,
  ReplayDestinationSchema,
  SubscriptionSchema,
  SW_SECRET_PROVIDERS,
  VERIFY_TOKEN_PROVIDERS,
  VerificationStateSchema,
  WATERMARK_DELTA_MS,
} from "@webhook-co/shared";
import { z } from "zod";

import { defineCapability, type AnyCapability } from "./capability";
import { TargetSchema } from "./target";

// A multi-select filter field: accepts a single enum value OR a non-empty array. Accepting the scalar
// keeps the events.list input backward-compatible for a direct consumer that passed the pre-multi-select
// single value; the array is the canonical form every surface now sends. NB no `.transform` to normalize
// here — a transform can't be represented in JSON Schema and would break the MCP tool inputSchema (the
// same constraint as z.coerce.date); the shared read-handler normalizes a scalar to an array instead.
function multiEnum<T extends z.ZodTypeAny>(schema: T) {
  return z.union([schema, z.array(schema).min(1)]);
}

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
/**
 * replayDestinations.* mcp exemption — the allowlist GATES which remote URLs the server may deliver to
 * (the SSRF-egress control). An MCP agent must not be able to register/mutate it, or it could steer the
 * server at an attacker-controlled destination — the confused-deputy vector ADR-0005 names explicitly.
 * (A DIFFERENT rationale than events.replay's "localhost is CLI-intrinsic" — recorded distinctly.)
 */
const REPLAY_DEST_MCP_EXEMPT =
  "the replay allowlist gates SSRF egress targets — an agent must not register/mutate it (confused-deputy, ADR-0005)";
/**
 * subscriptions.* mcp exemption (S3 Slice 3) — a subscription configures AUTO-DELIVERY routing of an org's
 * captured events to an egress destination. An MCP agent must not reconfigure where an org's event stream is
 * delivered (it would let an agent steer the org's data at a destination of its choosing — the same
 * confused-deputy / egress-control concern as the replay allowlist, ADR-0005).
 */
const SUBSCRIPTIONS_MCP_EXEMPT =
  "subscriptions route an org's events to egress destinations — an agent must not reconfigure event routing (confused-deputy, ADR-0005)";

function paged<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), nextCursor: cursor.nullable() });
}

export const endpointsList = defineCapability({
  name: "endpoints.list",
  input: z.object({
    cursor: cursor.optional(),
    limit: z.number().int().positive().max(200).optional(),
    // Optional substring name filter (case-insensitive). The endpoint set is small/capped per org, so
    // this is an unindexed residual filter by design — no migration needed.
    filter: z.object({ name: z.string().trim().min(1).max(200).optional() }).optional(),
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
    // All filter fields are optional and AND together. `provider` is index-covered
    // (events_provider_idx); the received-at range is sargable on events_tunnel_idx. The range bounds
    // are RFC3339 instant STRINGS (receivedAfter inclusive `>=`, receivedBefore exclusive `<`) — a plain
    // string keeps the MCP tool inputSchema JSON-Schema-clean (z.coerce.date() emits a ZodDate the
    // JSON-Schema converter can't represent, which breaks mcp tools/list). The shared read-handler
    // parses + validates each bound into a Date (a malformed value → VALIDATION_ERROR, never a raw
    // string handed to SQL → a Postgres 22P02), so the check lives in exactly one place.
    filter: z
      .object({
        // provider + verificationState are MULTI-select (OR'd within each, AND'd across fields):
        // `provider=[stripe,github]` → `provider in (...)`. multiEnum accepts a scalar or a non-empty
        // array (normalized to an array) — JSON-Schema-clean for the MCP inputSchema. Omit = no filter.
        provider: multiEnum(ProviderSchema).optional(),
        receivedAfter: z.string().optional(),
        receivedBefore: z.string().optional(),
        // The truthful verification tri-state (verified | failed | unattempted), multi-select.
        verificationState: multiEnum(VerificationStateSchema).optional(),
        // Case-insensitive substring search across the event's ID fields (provider_event_id, external_id,
        // dedup_key) + the request HEADER names/values, plus an exact match on the event id when the term
        // is a uuid. A plain string (no coerce) → JSON-Schema-clean. The ID fields are backed by trigram
        // GIN indexes (migration 0023); the headers jsonb is a residual scan.
        search: z.string().trim().min(1).max(256).optional(),
      })
      .optional(),
  }),
  // events.list is a newest-first browse; it carries headCursor only (the watermark-bounded resumable
  // position) — caughtUp/lag are forward-tail concepts that don't map onto a DESC browse.
  output: paged(EventSummarySchema).extend({ headCursor: cursor.nullable().optional() }),
  errors: ["NOT_FOUND", "UNAUTHORIZED", "VALIDATION_ERROR", "RATE_LIMITED"],
  auth: { scope: "events:read" },
  semantics: { paginated: true },
  // Bound on api + cli + mcp + web (the dashboard events list, slice 3 of the dashboard epic).
});

export const eventsGet = defineCapability({
  name: "events.get",
  input: z.object({ eventId: uuid }),
  output: EventSchema,
  errors: ["NOT_FOUND", "UNAUTHORIZED", "RATE_LIMITED"],
  auth: { scope: "events:read" },
  semantics: {},
  // Bound on api + cli + mcp + web (the dashboard event detail, slice 3 of the dashboard epic).
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
  // Bound on api + cli + web (the dashboard payload viewer + download, slice 3b); mcp is exempt (no R2 binding).
  surfaceExempt: { mcp: PAYLOAD_MCP_EXEMPT },
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
      // What KIND of secret this is. `signing_secret` (default, back-compat) = the payload-signing/auth
      // secret the verify path uses. `verify_token` = a user-chosen GET-handshake compare-token (Meta
      // `hub.verify_token`, ADR-0086) — a SECOND secret that coexists with the signing secret under the
      // same provider slug, so it is sealed as a typed blob the engine recognizes pre-capture.
      kind: z.enum(["signing_secret", "verify_token"]).default("signing_secret"),
    })
    // A Standard-Webhooks-family secret is base64 key material (optionally `whsec_`-prefixed, and a
    // `v1,` version tag for Supabase). The verify path strips those and base64-decodes the remainder.
    // Validate at the schema boundary with the SAME decoder (isUsableStandardWebhooksSecret) for every
    // SW-family provider (SW_SECRET_PROVIDERS, derived from the configs) so a value that matches the
    // base64 alphabet but isn't valid base64 (a length ≡ 1 mod 4 paste, hex, or raw) is rejected up
    // front — otherwise it would store fine yet decode to nothing and verify as NO_MATCHING_KEY forever
    // (indistinguishable from "no secret"). Single-sourced here so every surface (api/mcp) matches.
    .superRefine((val, ctx) => {
      // A verify-token is an OPAQUE user-chosen string (no base64/JSON shape), valid only for a provider
      // that does a verify-token handshake — so it bypasses the signing-secret shape refines below.
      if (val.kind === "verify_token") {
        if (!VERIFY_TOKEN_PROVIDERS.has(val.provider)) {
          ctx.addIssue({
            code: "custom",
            path: ["provider"],
            message:
              "this provider has no verify-token handshake; omit kind (or use signing_secret) to register a signing secret",
          });
        }
        return;
      }
      if (SW_SECRET_PROVIDERS.has(val.provider) && !isUsableStandardWebhooksSecret(val.secret)) {
        ctx.addIssue({
          code: "custom",
          path: ["secret"],
          message:
            "a Standard Webhooks secret must be base64 key material (optionally whsec_-prefixed)",
        });
      }
      // A Tier-4 operator-configured-header provider's secret is a JSON `{header, token}` (the operator
      // chose the header name). Reject a malformed/empty one up front (same rationale as the SW refine):
      // otherwise it stores fine yet can never match, verifying as NO_MATCHING_KEY forever.
      if (
        CONFIGURED_HEADER_PROVIDERS.has(val.provider) &&
        !isUsableConfiguredHeaderSecret(val.secret)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["secret"],
          message:
            'this provider expects a JSON secret {"header":"...","token":"..."} with a non-empty header name and token',
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

// ── Replay-destination allowlist (ADR-0081) ──────────────────────────────────────────────────────
// The org-level allowlist of HTTPS URLs that events.replay's `{kind:"destination"}` target may deliver
// to (the server-side remote-delivery arm lands in 1b). A SAFETY/trust control: keeping the replay
// target closed (a destinationId reference, never a free-form URL) is what contains the SSRF + confused-
// deputy surface (ADR-0005). create/list/delete reuse the endpoints:* scopes (no new grantable scope);
// web is deferred to the dashboard epic; mcp is exempt (an agent must not mutate the egress allowlist).

/**
 * A newly-created replay destination PLUS its one-time Standard Webhooks signing secret (S3 Slice 2,
 * ADR-0084). A destination is born with a signing secret so the server can sign its deliveries; the
 * `whsec_` plaintext is revealed EXACTLY ONCE on first creation (configure it in your receiver's verifier)
 * and is never returned again — only the seal is kept. Mirrors the endpoints.create one-time ingestUrl
 * reveal. `signingSecret` is OPTIONAL because create is idempotent: re-registering an existing URL returns
 * the destination WITHOUT re-revealing (the secret was shown once) — use rotateSigningSecret for a fresh one.
 */
export const CreatedReplayDestinationSchema = ReplayDestinationSchema.extend({
  signingSecret: z.string().optional(),
});
export type CreatedReplayDestination = z.infer<typeof CreatedReplayDestinationSchema>;

export const replayDestinationsCreate = defineCapability({
  name: "replayDestinations.create",
  // The URL is validated STRUCTURALLY at the contract boundary (canonicalizeAndValidateUrl): https-only,
  // no credentials, no IP-literal host (every decimal/octal/hex encoding canonicalizes to an IP literal
  // and is rejected), an allowed port, a multi-label FQDN. This is an early reject for honest mistakes +
  // UX; the AUTHORITATIVE private-range guard runs at DELIVERY time (the engine connect-time guard, 1b),
  // because DNS can rebind after registration. A label is an optional non-secret display name.
  input: z
    .object({
      url: z.string().min(1).max(2048),
      label: z.string().trim().min(1).max(200).optional(),
    })
    .superRefine((val, ctx) => {
      if (!canonicalizeAndValidateUrl(val.url).ok) {
        ctx.addIssue({
          code: "custom",
          path: ["url"],
          message:
            "must be a public https URL — no IP-literal host, credentials, disallowed port, or bare name",
        });
      }
    }),
  // Output now carries the one-time signing secret (S3 Slice 2) alongside the destination.
  output: CreatedReplayDestinationSchema,
  // FORBIDDEN: a bearer lacking endpoints:write (the api edge 403s before dispatch; on mcp — exempt here —
  // the handler scope check is the sole gate). VALIDATION_ERROR carries the structural URL rejection.
  errors: ["UNAUTHORIZED", "FORBIDDEN", "VALIDATION_ERROR", "RATE_LIMITED"],
  auth: { scope: "endpoints:write" },
  semantics: {},
  surfaceExempt: { web: WEB_DEFERRED, mcp: REPLAY_DEST_MCP_EXEMPT },
});

export const replayDestinationsList = defineCapability({
  name: "replayDestinations.list",
  input: z.object({}),
  // NOT paginated: an org's replay allowlist is a human-managed handful, returned whole (no cursor/limit
  // — don't advertise pagination the surface doesn't implement, same as endpoints.listProviderSecrets).
  output: z.object({ items: z.array(ReplayDestinationSchema) }),
  errors: ["UNAUTHORIZED", "RATE_LIMITED"],
  auth: { scope: "endpoints:read" },
  semantics: {},
  surfaceExempt: { web: WEB_DEFERRED, mcp: REPLAY_DEST_MCP_EXEMPT },
});

export const ReplayDestinationDeletedSchema = z.object({ id: uuid, deletedAt: z.coerce.date() });
export type ReplayDestinationDeleted = z.infer<typeof ReplayDestinationDeletedSchema>;

export const replayDestinationsDelete = defineCapability({
  name: "replayDestinations.delete",
  input: z.object({ destinationId: uuid }),
  output: ReplayDestinationDeletedSchema,
  // Revocability matters for a security allowlist. Soft-delete: the entry stops being a valid replay
  // target. NOT_FOUND for an unknown / cross-org / already-removed id (don't leak existence).
  errors: ["NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN", "VALIDATION_ERROR", "RATE_LIMITED"],
  auth: { scope: "endpoints:write" },
  semantics: {},
  surfaceExempt: { web: WEB_DEFERRED, mcp: REPLAY_DEST_MCP_EXEMPT },
});

// ── Replay-destination signing secrets (ADR-0084, S3 Slice 2) ─────────────────────────────────────
// Each destination's outbound Standard Webhooks signing secret. create reveals the first one; rotate
// mints a fresh one (with a bounded active+retiring overlap for zero-downtime verifier reconfiguration);
// list shows non-secret metadata. Same surface posture as the rest of replayDestinations.* (CLI+API;
// web-deferred; mcp-exempt — an agent must not mint/exfiltrate a signing secret). Reuse endpoints:* scopes.

/** A freshly-minted signing secret revealed ONCE (rotate). The whsec_ value is never returned again. */
export const RotatedSigningSecretSchema = z.object({
  destinationId: uuid,
  keyId: uuid,
  signingSecret: z.string(),
});
export type RotatedSigningSecret = z.infer<typeof RotatedSigningSecretSchema>;

/** A destination signing secret as NON-secret metadata — never the sealed bytes or the plaintext. */
export const SigningSecretMetadataSchema = z.object({
  id: uuid,
  status: z.enum(["active", "retiring", "revoked"]),
  createdAt: z.coerce.date(),
});
export type SigningSecretMetadataView = z.infer<typeof SigningSecretMetadataSchema>;

export const replayDestinationsRotateSigningSecret = defineCapability({
  name: "replayDestinations.rotateSigningSecret",
  input: z.object({ destinationId: uuid }),
  output: RotatedSigningSecretSchema,
  // NOT_FOUND for an unknown / cross-org / soft-deleted destination (don't leak existence). The new secret
  // is revealed once; the prior key enters a bounded 'retiring' grace so receivers can reconfigure with no
  // downtime (both signatures are sent, space-delimited, until the next rotation).
  errors: ["NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN", "VALIDATION_ERROR", "RATE_LIMITED"],
  auth: { scope: "endpoints:write" },
  semantics: {},
  surfaceExempt: { web: WEB_DEFERRED, mcp: REPLAY_DEST_MCP_EXEMPT },
});

export const replayDestinationsListSigningSecrets = defineCapability({
  name: "replayDestinations.listSigningSecrets",
  input: z.object({ destinationId: uuid }),
  // NOT paginated (a destination has a tiny handful of keys). Metadata only — never the sealed bytes.
  output: z.object({ items: z.array(SigningSecretMetadataSchema) }),
  errors: ["NOT_FOUND", "UNAUTHORIZED", "RATE_LIMITED"],
  auth: { scope: "endpoints:read" },
  semantics: {},
  surfaceExempt: { web: WEB_DEFERRED, mcp: REPLAY_DEST_MCP_EXEMPT },
});

// ── Delivery subscriptions (S3 Slice 3) ───────────────────────────────────────────────────────────
// The Tier-3 routing rules that bind a source endpoint's captured events to a destination, selected on
// provider + event_types + require_verified. create/list/delete reuse the endpoints:* scopes (no new
// grantable scope); web is deferred to the dashboard epic; mcp is exempt (an agent must not reconfigure
// where an org's events are delivered — see SUBSCRIPTIONS_MCP_EXEMPT).

export const subscriptionsCreate = defineCapability({
  name: "subscriptions.create",
  // create UPSERTS the routing for (sourceEndpoint, destination): provider null = any; eventTypes default
  // ['*'] (match-all) when omitted; requireVerified default false. No z.coerce/.transform here (keeps the
  // input toJSONSchema-clean even though this cap is mcp-exempt).
  input: z.object({
    sourceEndpointId: uuid,
    destinationId: uuid,
    provider: z.string().min(1).max(80).nullable().optional(),
    eventTypes: z.array(z.string().min(1).max(200)).max(100).optional(),
    requireVerified: z.boolean().optional(),
  }),
  output: SubscriptionSchema,
  // NOT_FOUND: the source endpoint or destination is missing/deleted/cross-org (binding to a target the
  // ingest resolver would exclude is rejected, not silently created as an undeliverable rule).
  errors: ["NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN", "VALIDATION_ERROR", "RATE_LIMITED"],
  auth: { scope: "endpoints:write" },
  semantics: {},
  surfaceExempt: { web: WEB_DEFERRED, mcp: SUBSCRIPTIONS_MCP_EXEMPT },
});

export const subscriptionsList = defineCapability({
  name: "subscriptions.list",
  // optional source-endpoint filter. NOT paginated — an org's subscriptions are a human-managed handful.
  input: z.object({ sourceEndpointId: uuid.optional() }),
  output: z.object({ items: z.array(SubscriptionSchema) }),
  // VALIDATION_ERROR: a non-uuid sourceEndpointId filter fails input parse (mirrors endpoints.list).
  errors: ["UNAUTHORIZED", "VALIDATION_ERROR", "RATE_LIMITED"],
  auth: { scope: "endpoints:read" },
  semantics: {},
  surfaceExempt: { web: WEB_DEFERRED, mcp: SUBSCRIPTIONS_MCP_EXEMPT },
});

export const SubscriptionDeletedSchema = z.object({ id: uuid });
export type SubscriptionDeleted = z.infer<typeof SubscriptionDeletedSchema>;

export const subscriptionsDelete = defineCapability({
  name: "subscriptions.delete",
  input: z.object({ subscriptionId: uuid }),
  output: SubscriptionDeletedSchema,
  // Hard delete. NOT_FOUND for an unknown / cross-org / already-removed id (don't leak existence).
  errors: ["NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN", "VALIDATION_ERROR", "RATE_LIMITED"],
  auth: { scope: "endpoints:write" },
  semantics: {},
  surfaceExempt: { web: WEB_DEFERRED, mcp: SUBSCRIPTIONS_MCP_EXEMPT },
});

// ── Deliveries (S3 Slice 3 PR3) — the outbound-delivery OBSERVABILITY reads ─────────────────────────
// Read a delivery's status/attempt/retry-clock, and browse the org's delivery history filtered by
// destination/subscription/status. The history spans auto-deliveries (to subscribed destinations) AND manual
// replay attempts (a localhost-forward row carries no destination/subscription). READS reuse events:read (are
// event history) and are FULL-PARITY incl. mcp — unlike the subscriptions/destinations WRITE caps (which
// reconfigure egress and are mcp-exempt), reading delivery status steers nothing. Web is deferred to the
// dashboard epic. Handlers live in the SHARED read-handler map, so mcp binds them automatically.

export const deliveriesGet = defineCapability({
  name: "deliveries.get",
  input: z.object({ deliveryId: uuid }),
  output: DeliverySchema,
  // NOT_FOUND: unknown / cross-org / not-yet-created id (RLS hides cross-org — don't leak existence).
  errors: ["NOT_FOUND", "UNAUTHORIZED", "RATE_LIMITED"],
  auth: { scope: "events:read" },
  semantics: {},
  surfaceExempt: { web: WEB_DEFERRED },
});

export const deliveriesList = defineCapability({
  name: "deliveries.list",
  // Newest-first browse of the org's deliveries; all filters optional + AND together. `status` is
  // MULTI-select (scalar or non-empty array → `status in (...)`); a cross-org/unknown destinationId or
  // subscriptionId filter simply yields an empty page under RLS (no existence oracle). No z.coerce here —
  // keeps the mcp tool inputSchema JSON-Schema-clean.
  input: z.object({
    destinationId: uuid.optional(),
    subscriptionId: uuid.optional(),
    status: multiEnum(DeliveryStatusSchema).optional(),
    cursor: cursor.optional(),
    limit: z.number().int().positive().max(200).optional(),
  }),
  output: paged(DeliverySchema),
  errors: ["UNAUTHORIZED", "VALIDATION_ERROR", "RATE_LIMITED"],
  auth: { scope: "events:read" },
  semantics: { paginated: true },
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
  replayDestinationsCreate,
  replayDestinationsList,
  replayDestinationsDelete,
  replayDestinationsRotateSigningSecret,
  replayDestinationsListSigningSecrets,
  subscriptionsCreate,
  subscriptionsList,
  subscriptionsDelete,
  deliveriesGet,
  deliveriesList,
];

/** Registry keyed by stable capability name. */
export const CAPABILITY_REGISTRY: ReadonlyMap<string, AnyCapability> = new Map(
  CAPABILITIES.map((c) => [c.name, c]),
);
