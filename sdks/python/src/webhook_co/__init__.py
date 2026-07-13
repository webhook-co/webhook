"""The official Python SDK for the webhook.co API.

from webhook_co import WebhookClient

client = WebhookClient(api_key="whk_...")
for endpoint in client.endpoints.list():
    print(endpoint.id, endpoint.name)
"""

from __future__ import annotations

from ._errors import (
    WebhookAPIError,
    WebhookAuthenticationError,
    WebhookConfigError,
    WebhookConflictError,
    WebhookConnectionError,
    WebhookError,
    WebhookInvalidRequestError,
    WebhookNotFoundError,
    WebhookPermissionError,
    WebhookRateLimitError,
    WebhookTargetUnreachableError,
    WebhookUnexpectedResponseError,
)
from ._generated.models import (
    AddedProviderSecret,
    AuditVerifyResponse,
    AuthContext,
    CreatedEndpoint,
    CreatedReplayDestination,
    DeletedEndpoint,
    Delivery,
    DeliveryAttempt,
    Endpoint,
    EndpointsRevealIngestUrlResponse,
    Event,
    EventsDeleteResponse,
    EventsTailResponse,
    EventSummary,
    ProviderSecretSummary,
    ReplayDestination,
    ReplayDestinationDeleted,
    RevokedProviderSecret,
    RotatedSigningSecret,
    SigningSecretMetadata,
    Subscription,
    SubscriptionDeleted,
    TriggersCreateResponse,
    TriggersListResponse,
    TriggersRevokeResponse,
    TriggersWaitResponse,
    UsageGetResponse,
)
from ._pagination import Page, Paginator
from .client import EventPayload, WebhookClient

__all__ = [
    "EndpointsRevealIngestUrlResponse",
    "EventsDeleteResponse",
    "TriggersCreateResponse",
    "TriggersListResponse",
    "TriggersRevokeResponse",
    "TriggersWaitResponse",
    "UsageGetResponse",
    "WebhookClient",
    "EventPayload",
    "Page",
    "Paginator",
    # errors
    "WebhookError",
    "WebhookConfigError",
    "WebhookConnectionError",
    "WebhookAPIError",
    "WebhookAuthenticationError",
    "WebhookPermissionError",
    "WebhookNotFoundError",
    "WebhookInvalidRequestError",
    "WebhookConflictError",
    "WebhookRateLimitError",
    "WebhookTargetUnreachableError",
    "WebhookUnexpectedResponseError",
    # models
    "Endpoint",
    "CreatedEndpoint",
    "DeletedEndpoint",
    "Event",
    "EventSummary",
    "EventsTailResponse",
    "Delivery",
    "DeliveryAttempt",
    "ReplayDestination",
    "CreatedReplayDestination",
    "ReplayDestinationDeleted",
    "RotatedSigningSecret",
    "SigningSecretMetadata",
    "Subscription",
    "SubscriptionDeleted",
    "AddedProviderSecret",
    "ProviderSecretSummary",
    "RevokedProviderSecret",
    "AuditVerifyResponse",
    "AuthContext",
]
