// Ergonomic type aliases over the generated OpenAPI types. The generated `components["schemas"]` tree
// (src/generated/schema.d.ts) is the single source of truth — these aliases just give it public,
// discoverable names. Regenerate the source with `pnpm --filter @webhook-co/sdk generate`.

import type { components } from "./generated/schema.js";

type Schemas = components["schemas"];

// Entities
export type Endpoint = Schemas["Endpoint"];
export type Event = Schemas["Event"];
export type EventSummary = Schemas["EventSummary"];
export type Delivery = Schemas["Delivery"];
export type DeliveryAttempt = Schemas["DeliveryAttempt"];
export type ReplayDestination = Schemas["ReplayDestination"];
export type Subscription = Schemas["Subscription"];
export type ProviderSecretSummary = Schemas["ProviderSecretSummary"];
export type SigningSecretMetadata = Schemas["SigningSecretMetadata"];
export type AuthContext = Schemas["AuthContext"];
export type VerificationResult = Schemas["VerificationResult"];

// Enums / unions
export type Provider = Schemas["Provider"];
export type DeliveryStatus = Schemas["DeliveryStatus"];
export type VerificationState = Schemas["VerificationState"];

// Command results
export type CreatedEndpoint = Schemas["CreatedEndpoint"];
export type RevealedIngestUrl = Schemas["EndpointsRevealIngestUrlResponse"];
export type DedupConfig = Schemas["Endpoint"]["dedupConfig"];
export type DeletedEndpoint = Schemas["DeletedEndpoint"];
export type DeletedEvent = Schemas["EventsDeleteResponse"];
export type Usage = Schemas["UsageGetResponse"];
export type Trigger = Schemas["TriggersCreateResponse"];
export type TriggersList = Schemas["TriggersListResponse"];
export type RevokedTrigger = Schemas["TriggersRevokeResponse"];
export type TriggersWaitResult = Schemas["TriggersWaitResponse"];
export type AddedProviderSecret = Schemas["AddedProviderSecret"];
export type RevokedProviderSecret = Schemas["RevokedProviderSecret"];
export type CreatedReplayDestination = Schemas["CreatedReplayDestination"];
export type ReplayDestinationDeleted = Schemas["ReplayDestinationDeleted"];
export type RotatedSigningSecret = Schemas["RotatedSigningSecret"];
export type SubscriptionDeleted = Schemas["SubscriptionDeleted"];
export type AuditVerifyResponse = Schemas["AuditVerifyResponse"];
export type EventsGetPayloadResponse = Schemas["EventsGetPayloadResponse"];
export type EventsTailResponse = Schemas["EventsTailResponse"];

// Request bodies (as the SDK accepts them)
export type EndpointsCreateRequest = Schemas["EndpointsCreateRequest"];
export type EndpointsAddProviderSecretRequest = Schemas["EndpointsAddProviderSecretRequest"];
export type EventsReplayRequest = Schemas["EventsReplayRequest"];
export type ReplayTarget = EventsReplayRequest["target"];
export type ReplayDestinationsCreateRequest = Schemas["ReplayDestinationsCreateRequest"];
export type SubscriptionsCreateRequest = Schemas["SubscriptionsCreateRequest"];
