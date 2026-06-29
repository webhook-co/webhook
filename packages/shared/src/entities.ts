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
});
export type EventSummary = z.infer<typeof EventSummarySchema>;

/** The full-fidelity event (events.get): ordered unscrubbed headers + body ref + the
 *  structured verification diagnostic. */
export const EventSchema = EventSummarySchema.extend({
  payloadR2Key: z.string(),
  payloadBytes: z.number().int().nonnegative(),
  contentType: z.string().nullable(),
  headers: z.array(HeaderPair),
  providerEventId: z.string().nullable(),
  externalId: z.string().nullable(),
  verification: VerificationResultSchema.nullable(),
});
export type Event = z.infer<typeof EventSchema>;

export const DeliveryAttemptSchema = z.object({
  id: uuid,
  orgId: uuid,
  eventId: uuid,
  target: z.string(),
  idempotencyKey: z.string().nullable(),
  status: z.string(),
  statusCode: z.number().int().nullable(),
  attempt: z.number().int().positive(),
  error: z.string().nullable(),
  createdAt: z.coerce.date(),
});
export type DeliveryAttempt = z.infer<typeof DeliveryAttemptSchema>;

/** Soft-cap limits view (org_limits). No prices — cap + behavior only. */
export const OrgLimitsSchema = z.object({
  orgId: uuid,
  eventCap: z.number().int().nonnegative().nullable(),
  pausePolicy: PausePolicySchema,
  updatedAt: z.coerce.date(),
});
export type OrgLimits = z.infer<typeof OrgLimitsSchema>;
