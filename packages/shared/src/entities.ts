import { ProviderSchema, VerificationResultSchema } from "@webhook-co/webhooks-spec";
import { z } from "zod";

import { DedupStrategySchema, MembershipRoleSchema, PausePolicySchema } from "./enums";

// Cross-surface entity schemas + inferred types. One definition consumed by
// CLI/API/web/MCP and mapped to/from the DB by packages/db repositories. snake_case
// columns become camelCase fields at this boundary. Dates accept ISO strings or Date
// (z.coerce.date) so the same schema validates DB rows and JSON over the wire.

const uuid = z.uuid();
const HeaderPair = z.tuple([z.string(), z.string()]);

export const OrgSchema = z.object({
  id: uuid,
  slug: z.string(),
  name: z.string(),
  region: z.string(),
  createdAt: z.coerce.date(),
});
export type Org = z.infer<typeof OrgSchema>;

export const MembershipSchema = z.object({
  orgId: uuid,
  userId: z.string(),
  role: MembershipRoleSchema,
  createdAt: z.coerce.date(),
});
export type Membership = z.infer<typeof MembershipSchema>;

export const EndpointSchema = z.object({
  id: uuid,
  orgId: uuid,
  name: z.string(),
  paused: z.boolean(),
  createdAt: z.coerce.date(),
});
export type Endpoint = z.infer<typeof EndpointSchema>;

/**
 * The truthfully-distinguishable verification outcome of a stored event, derived from
 * (`verified`, `verification`): `verified` (an adapter matched the signature) / `failed` (an
 * adapter ran and rejected — `verified=false` AND `verification` non-null) / `unattempted`
 * (`verification IS NULL` — no signature was checked: no secret, header absent, or a rare
 * KMS/internal error; these collapse to one bucket the row can't tell apart, so `unattempted`
 * must never be presented as a failure).
 */
// "authenticated" is a DISTINCT, weaker state than "verified": the source was proven by a shared static
// token / HTTP Basic credential (Tier-4 providers), NOT a cryptographic signature over the payload. The
// stored verification carries `authenticity` (token/basic) for these; everything else that's `verified`
// is cryptographically signature-verified.
export const VerificationStateSchema = z.enum([
  "verified",
  "authenticated",
  "failed",
  "unattempted",
]);
export type VerificationState = z.infer<typeof VerificationStateSchema>;
/** The canonical verification-state vocabulary (single source for CLI/web filter controls). */
export const VERIFICATION_STATES = VerificationStateSchema.options;

/** Derive the verification state from the stored pair. A `verified` result with an `authenticity` of
 *  token/basic is the weaker "authenticated" (non-crypto); other `verified` is signature-verified.
 *  `verification` non-null with `verified=false` is the genuine "failed" case; null is "unattempted". */
export function deriveVerificationState(
  verified: boolean,
  verification: unknown,
): VerificationState {
  if (verified) {
    // Mirrors the summary SQL CASE EXACTLY (`verification->>'authenticity' is not null`, reads.ts) so
    // listEvents (SQL) and getEvent/listen (this) can never disagree on a row. Any authenticity marker
    // means non-cryptographic → the weaker "authenticated"; default the unknown to the WEAKER state
    // (never overstate a non-signature as "verified"). Today the field is only ever "token"/"basic".
    const authenticity = (verification as { authenticity?: unknown } | null)?.authenticity;
    return authenticity != null ? "authenticated" : "verified";
  }
  return verification != null ? "failed" : "unattempted";
}

/** The list view of an event (events.list) — no body, no full headers. */
export const EventSummarySchema = z.object({
  id: uuid,
  orgId: uuid,
  endpointId: uuid,
  receivedAt: z.coerce.date(),
  provider: ProviderSchema.nullable(),
  dedupKey: z.string(),
  dedupStrategy: DedupStrategySchema,
  verified: z.boolean(),
  // OPTIONAL on purpose: under producer/consumer version skew a `wbhk listen` frame from an older
  // engine would lack this field, and EventFrameSchema embeds EventSummarySchema with parseServerFrame
  // doing safeParse → a REQUIRED field would fail the parse and SILENTLY DROP the frame (event loss on
  // the tail). Optional keeps an old frame valid. Every current read projects it (the db CASE / the
  // getEvent derive), so it is always present in practice; absent is treated as "unknown".
  verificationState: VerificationStateSchema.optional(),
});
export type EventSummary = z.infer<typeof EventSummarySchema>;

/** The full-fidelity event (events.get): ordered unscrubbed headers + body ref + the
 *  structured verification diagnostic. */
export const EventSchema = EventSummarySchema.extend({
  payloadR2Key: z.string(),
  payloadBytes: z.number().int().nonnegative(),
  contentType: z.string().nullable(),
  // The captured request's HTTP method (accept-all-verbs). nullable: legacy rows captured under the old
  // POST-only gate have no recorded method (NULL = unrecorded, not an inferred 'POST'). optional: an
  // OLDER api (deployed before this field) omits the key entirely, and the CLI/MCP parse the api
  // response against this schema — optional keeps that cross-version response valid instead of throwing
  // (same forward-compat reasoning as EventSummarySchema.verificationState). Detail-view ONLY —
  // deliberately NOT on EventSummarySchema, whose `wbhk listen` frame is safeParse'd (a required new
  // field there would silently DROP frames under producer/consumer skew).
  method: z.string().nullable().optional(),
  headers: z.array(HeaderPair),
  providerEventId: z.string().nullable(),
  externalId: z.string().nullable(),
  verification: VerificationResultSchema.nullable(),
});
export type Event = z.infer<typeof EventSchema>;

/**
 * The closed delivery-attempt lifecycle vocabulary (matches the delivery_attempts status CHECK,
 * migrations 0025 + 0027). `forwarded` = the legacy localhost-replay record (the CLI did the POST). The
 * server-delivery (ADR-0081) states: `pending` (claimed/in flight) → `delivered` (a 2xx) / `failed`
 * (non-2xx / connection / transient-resolver failure — retryable) / `blocked` (the SSRF guard refused).
 * The delivery-engine (S3 Slice 3) adds `queued` (durably accepted, not yet attempted — the
 * durable-before-ACK intent) and `dead` (retries exhausted → dead-letter / DLQ; retained for history +
 * manual replay).
 */
export const DeliveryStatusSchema = z.enum([
  "queued",
  "forwarded",
  "pending",
  "delivered",
  "failed",
  "blocked",
  "dead",
  // `cancelled` = the destination was deleted while this delivery was still open, so it's terminally
  // resolved without a further attempt (distinct from `dead`/exhausted and `blocked`/SSRF-refused).
  "cancelled",
]);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;
/** The delivery-status vocabulary as a tuple — the CLI `--status` multi-select enum + parity checks. */
export const DELIVERY_STATUSES = DeliveryStatusSchema.options;

export const DeliveryAttemptSchema = z.object({
  id: uuid,
  orgId: uuid,
  eventId: uuid,
  target: z.string(),
  idempotencyKey: z.string().nullable(),
  status: DeliveryStatusSchema,
  statusCode: z.number().int().nullable(),
  attempt: z.number().int().positive(),
  error: z.string().nullable(),
  createdAt: z.coerce.date(),
});
export type DeliveryAttempt = z.infer<typeof DeliveryAttemptSchema>;

/**
 * A delivery — the tenant-facing read view of a `delivery_attempts` row for the deliveries.get/list surface
 * (S3 Slice 3 PR3). Purpose-built for auto-delivery OBSERVABILITY: it surfaces the routing link
 * (`destinationId`, `subscriptionId`) and the retry clock (`attempt`, `nextRetryAt`) — the fields the
 * DeliveryAttempt (remote-replay) view omits — and drops the internal `target`/`idempotencyKey`. Both are
 * nullable: `destinationId` is null on a legacy localhost-forward row, `subscriptionId` is null on a manual
 * replay (only auto-delivery links a subscription). `nextRetryAt` is when the delivery is next DUE — now()
 * on a freshly-queued row, the scheduled retry time while pending, and null once terminal (delivered/dead/
 * blocked) or on a legacy localhost-forward row.
 */
export const DeliverySchema = z.object({
  id: uuid,
  eventId: uuid,
  destinationId: uuid.nullable(),
  subscriptionId: uuid.nullable(),
  status: DeliveryStatusSchema,
  statusCode: z.number().int().nullable(),
  attempt: z.number().int().positive(),
  error: z.string().nullable(),
  nextRetryAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});
export type Delivery = z.infer<typeof DeliverySchema>;

/**
 * A replay destination — an org-level allowlist entry naming an HTTPS URL that `events.replay` is
 * permitted to deliver to (ADR-0081). It is a SAFETY/trust control, distinct from S3's per-endpoint
 * outbound routing (which lives in its own tables). `status` is a word (active|revoked), not a bool;
 * `lastValidatedAt` records the last time the URL passed a structural/resolve check (advisory). The
 * canonical `url` is the stored, normalized form (https, lowercased host, default port stripped).
 */
export const ReplayDestinationStatusSchema = z.enum(["active", "revoked"]);
export type ReplayDestinationStatus = z.infer<typeof ReplayDestinationStatusSchema>;

export const ReplayDestinationSchema = z.object({
  id: uuid,
  orgId: uuid,
  url: z.string(),
  label: z.string().nullable(),
  status: ReplayDestinationStatusSchema,
  createdAt: z.coerce.date(),
  lastValidatedAt: z.coerce.date().nullable(),
  // S3 Slice 3: the per-destination strict-FIFO toggle (default false = best-effort ordered-dispatch),
  // and the auto-disable marker — `disabledAt` non-null means persistent-failure auto-disable tripped and
  // the destination stops being an enqueue target until `replayDestinations.enable` clears it.
  ordered: z.boolean(),
  disabledAt: z.coerce.date().nullable(),
});
export type ReplayDestination = z.infer<typeof ReplayDestinationSchema>;

/**
 * A delivery subscription (S3 Slice 3): the Tier-3 routing rule binding a source endpoint's captured events
 * to a destination, selected on provider + event_types + require_verified. `enabled` pauses routing without
 * deleting. `provider` null = any provider; `eventTypes` patterns are exact / trailing-glob `x.*` / `*`.
 */
export const SubscriptionSchema = z.object({
  id: uuid,
  orgId: uuid,
  sourceEndpointId: uuid,
  destinationId: uuid,
  provider: z.string().nullable(),
  eventTypes: z.array(z.string()),
  requireVerified: z.boolean(),
  enabled: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

/** Soft-cap limits view (org_limits). No prices — cap + behavior only. */
export const OrgLimitsSchema = z.object({
  orgId: uuid,
  eventCap: z.number().int().nonnegative().nullable(),
  pausePolicy: PausePolicySchema,
  updatedAt: z.coerce.date(),
});
export type OrgLimits = z.infer<typeof OrgLimitsSchema>;
