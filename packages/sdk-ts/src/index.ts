// Public API of @webhook-co/sdk. Everything a consumer needs: the client, its options + filter types, the
// typed error hierarchy, the paginator, and the entity/request types derived from the OpenAPI contract.

export { WebhookClient } from "./client.js";
export type {
  WebhookClientOptions,
  EndpointsListFilters,
  EventsListFilters,
  DeliveriesListFilters,
  EventsTailParams,
  EventPayload,
} from "./client.js";

export { Paginator } from "./pagination.js";
export type { Page } from "./pagination.js";

export {
  WebhookError,
  WebhookConfigError,
  WebhookConnectionError,
  WebhookAPIError,
  WebhookAuthenticationError,
  WebhookPermissionError,
  WebhookNotFoundError,
  WebhookInvalidRequestError,
  WebhookConflictError,
  WebhookRateLimitError,
  WebhookTargetUnreachableError,
  WebhookUnexpectedResponseError,
} from "./errors.js";
export type { WebhookErrorCode } from "./errors.js";

export type {
  // Entities
  Endpoint,
  Event,
  EventSummary,
  Delivery,
  DeliveryAttempt,
  ReplayDestination,
  Subscription,
  ProviderSecretSummary,
  SigningSecretMetadata,
  AuthContext,
  VerificationResult,
  // Enums / unions
  Provider,
  DeliveryStatus,
  VerificationState,
  // Command results
  CreatedEndpoint,
  DeletedEndpoint,
  RevealedIngestUrl,
  DedupConfig,
  AddedProviderSecret,
  RevokedProviderSecret,
  CreatedReplayDestination,
  ReplayDestinationDeleted,
  RotatedSigningSecret,
  SubscriptionDeleted,
  AuditVerifyResponse,
  EventsTailResponse,
  // Request shapes
  ReplayTarget,
} from "./schema.js";
