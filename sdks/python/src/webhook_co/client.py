"""The public client: a typed, hardened facade over the webhook.co REST API.

It composes the HTTP core (bearer + retries + timeout + typed errors), the redactor, and the cursor
paginator, and exposes the API surface grouped by resource. Responses are parsed into validated pydantic
models; a shape that violates the contract surfaces as a :class:`WebhookUnexpectedResponseError`.
Idempotency flags mirror the server's semantics — a call is only marked retry-safe when a blind retry
after a lost response cannot cause a duplicate side effect.
"""

from __future__ import annotations

import base64
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, TypeVar
from urllib.parse import quote

import httpx
import pydantic

from ._advisory import WebhookAdvisory, make_advisory_reporter
from ._config import resolve_base_url
from ._errors import WebhookConfigError, WebhookUnexpectedResponseError
from ._generated import models as m
from ._http import HttpClient
from ._pagination import Page, Paginator
from ._query import with_query
from ._retry import DEFAULT_TIMEOUT_S

M = TypeVar("M", bound=pydantic.BaseModel)


def _enc(value: str) -> str:
    return quote(value, safe="")


def _parse(model: type[M], data: Any) -> M:
    try:
        return model.model_validate(data)
    except pydantic.ValidationError:
        # Do NOT chain the ValidationError: its string embeds the raw input, which for some responses
        # includes secondary secrets (a rotated `whsec_`, an ingest URL). `from None` drops the
        # cause so no unredacted response body can reach a traceback.
        raise WebhookUnexpectedResponseError(
            "the API returned an unexpected response shape"
        ) from None


@dataclass
class EventPayload:
    """The decoded result of ``events.get_payload``: the content type + the exact raw body bytes."""

    content_type: str | None
    body: bytes


class _Requester:
    """The thin request layer each resource is built on; parses the HTTP core's JSON into a model."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def get(self, path: str, model: type[M]) -> M:
        return _parse(model, self._http.request("GET", path, idempotent=True))

    def post(self, path: str, body: Any | None, idempotent: bool, model: type[M]) -> M:
        return _parse(
            model, self._http.request("POST", path, body=body, idempotent=idempotent)
        )

    def patch(self, path: str, body: Any | None, idempotent: bool, model: type[M]) -> M:
        return _parse(
            model, self._http.request("PATCH", path, body=body, idempotent=idempotent)
        )

    def delete(self, path: str, idempotent: bool, model: type[M]) -> M:
        return _parse(model, self._http.request("DELETE", path, idempotent=idempotent))

    def paginate(
        self, build_path: Callable[[str | None], str], response_model: type[M]
    ) -> Paginator[Any]:
        def fetch(cursor: str | None) -> Page[Any]:
            resp = _parse(
                response_model,
                self._http.request("GET", build_path(cursor), idempotent=True),
            )
            return Page(items=list(resp.items), next_cursor=resp.next_cursor)  # type: ignore[attr-defined]

        return Paginator(fetch)

    def page(self, path: str, response_model: type[M]) -> Page[Any]:
        resp = _parse(response_model, self._http.request("GET", path, idempotent=True))
        return Page(items=list(resp.items), next_cursor=resp.next_cursor)  # type: ignore[attr-defined]


class _ProviderSecretsResource:
    def __init__(self, req: _Requester) -> None:
        self._req = req

    def add(
        self,
        *,
        endpoint_id: str,
        provider: str,
        secret: str,
        label: str | None = None,
        kind: str | None = None,
    ) -> m.AddedProviderSecret:
        """Register a provider signing secret (or a ``verify_token`` / ``braintree_public_key``). NOT
        idempotent — each call adds a secret.
        """
        body: dict[str, Any] = {"provider": provider, "secret": secret}
        if label is not None:
            body["label"] = label
        if kind is not None:
            body["kind"] = kind
        return self._req.post(
            f"/v1/endpoints/{_enc(endpoint_id)}/provider-secrets",
            body,
            False,
            m.AddedProviderSecret,
        )

    def list(self, endpoint_id: str) -> list[m.ProviderSecretSummary]:
        """An endpoint's provider secrets as metadata (not paginated)."""
        resp = self._req.get(
            f"/v1/endpoints/{_enc(endpoint_id)}/provider-secrets",
            m.EndpointsListProviderSecretsResponse,
        )
        return list(resp.items)

    def revoke(self, *, endpoint_id: str, secret_id: str) -> m.RevokedProviderSecret:
        """Revoke a provider secret. NOT idempotent — a re-revoke is NOT_FOUND, so never blind-retried."""
        return self._req.delete(
            f"/v1/endpoints/{_enc(endpoint_id)}/provider-secrets/{_enc(secret_id)}",
            False,
            m.RevokedProviderSecret,
        )


class _EndpointsResource:
    def __init__(self, req: _Requester) -> None:
        self._req = req
        self.provider_secrets = _ProviderSecretsResource(req)

    def _path(self, *, cursor: str | None, limit: int | None, name: str | None) -> str:
        return with_query(
            "/v1/endpoints", {"cursor": cursor, "limit": limit, "name": name}
        )

    def list(
        self, *, limit: int | None = None, name: str | None = None
    ) -> Paginator[m.Endpoint]:
        """Auto-paginating iterator over the org's endpoints."""
        return self._req.paginate(
            lambda cursor: self._path(cursor=cursor, limit=limit, name=name),
            m.EndpointsListResponse,
        )

    def list_page(
        self,
        *,
        cursor: str | None = None,
        limit: int | None = None,
        name: str | None = None,
    ) -> Page[m.Endpoint]:
        """A single page of endpoints (for manual cursor control)."""
        return self._req.page(
            self._path(cursor=cursor, limit=limit, name=name), m.EndpointsListResponse
        )

    def get(self, endpoint_id: str) -> m.Endpoint:
        """A single endpoint by id."""
        return self._req.get(f"/v1/endpoints/{_enc(endpoint_id)}", m.Endpoint)

    def create(self, *, name: str) -> m.CreatedEndpoint:
        """Create an endpoint. NOT idempotent — each call mints a new endpoint + a fresh ingest URL.

        The returned ``ingestUrl`` is a bearer credential, but it is NOT a one-time reveal: the token is
        sealed at rest, so a lost URL is re-readable any time (``POST
        /v1/endpoints/{id}/reveal-ingest-url``, ``wbhk endpoints reveal <id>``, or the dashboard) — you do
        not have to rotate to recover it.
        """
        return self._req.post("/v1/endpoints", {"name": name}, False, m.CreatedEndpoint)

    def delete(self, endpoint_id: str) -> m.DeletedEndpoint:
        """Soft-delete an endpoint. Idempotent — a re-delete returns the recorded ``deletedAt``."""
        return self._req.delete(
            f"/v1/endpoints/{_enc(endpoint_id)}", True, m.DeletedEndpoint
        )

    def update(
        self, endpoint_id: str, *, dedup_config: dict[str, Any] | None
    ) -> m.Endpoint:
        """Update an endpoint's dedup config (ADR-0104).

        Idempotent — it sets the config to a fixed value, so a transient failure is safe to retry.
        ``dedup_config=None`` RESETS to the default (off — log every request).
        """
        return self._req.patch(
            f"/v1/endpoints/{_enc(endpoint_id)}",
            {"dedupConfig": dedup_config},
            True,
            m.Endpoint,
        )

    def reveal_ingest_url(self, endpoint_id: str) -> m.EndpointsRevealIngestUrlResponse:
        """Reveal an endpoint's current ingest URL — non-destructive: it does NOT rotate.

        This is how you recover a FORGOTTEN url. Rotating instead would revoke a live credential and break
        every sender still posting to the old one. The token is sealed at rest (ADR-0101), so the URL is
        re-readable any time — it is NOT a one-time secret.

        ``ingest_url`` is None ONLY for endpoints created before sealed storage (their plaintext is gone —
        rotate to mint a fresh, re-readable one).

        Gated on ``endpoints:write``; every disclosure writes a tamper-evident audit row and is
        rate-limited. Sent idempotent=False so a blind retry cannot double-audit.
        """
        return self._req.post(
            f"/v1/endpoints/{_enc(endpoint_id)}/reveal-ingest-url",
            None,
            False,
            m.EndpointsRevealIngestUrlResponse,
        )

    def rotate(self, endpoint_id: str) -> m.CreatedEndpoint:
        """Rotate an endpoint's ingest URL (hard cutover — the old URL stops accepting events at once).

        For a LEAKED URL: a merely forgotten one can be re-read instead (see :meth:`create`). NOT
        idempotent — never blind-retried.
        """
        return self._req.post(
            f"/v1/endpoints/{_enc(endpoint_id)}/rotate", None, False, m.CreatedEndpoint
        )


class _EventsResource:
    def __init__(self, req: _Requester) -> None:
        self._req = req

    def _path(
        self,
        endpoint_id: str,
        *,
        cursor: str | None,
        limit: int | None,
        provider: Sequence[str] | None,
        verification_state: Sequence[str] | None,
        received_after: str | None,
        received_before: str | None,
        search: str | None,
    ) -> str:
        return with_query(
            f"/v1/endpoints/{_enc(endpoint_id)}/events",
            {
                "cursor": cursor,
                "limit": limit,
                "provider": list(provider) if provider is not None else None,
                "verificationState": (
                    list(verification_state) if verification_state is not None else None
                ),
                "receivedAfter": received_after,
                "receivedBefore": received_before,
                "search": search,
            },
        )

    def list(
        self,
        endpoint_id: str,
        *,
        limit: int | None = None,
        provider: Sequence[str] | None = None,
        verification_state: Sequence[str] | None = None,
        received_after: str | None = None,
        received_before: str | None = None,
        search: str | None = None,
    ) -> Paginator[m.EventSummary]:
        """Auto-paginating iterator over an endpoint's captured events."""
        return self._req.paginate(
            lambda cursor: self._path(
                endpoint_id,
                cursor=cursor,
                limit=limit,
                provider=provider,
                verification_state=verification_state,
                received_after=received_after,
                received_before=received_before,
                search=search,
            ),
            m.EventsListResponse,
        )

    def list_page(
        self,
        endpoint_id: str,
        *,
        cursor: str | None = None,
        limit: int | None = None,
        provider: Sequence[str] | None = None,
        verification_state: Sequence[str] | None = None,
        received_after: str | None = None,
        received_before: str | None = None,
        search: str | None = None,
    ) -> Page[m.EventSummary]:
        """A single page of an endpoint's events."""
        return self._req.page(
            self._path(
                endpoint_id,
                cursor=cursor,
                limit=limit,
                provider=provider,
                verification_state=verification_state,
                received_after=received_after,
                received_before=received_before,
                search=search,
            ),
            m.EventsListResponse,
        )

    def get(self, event_id: str) -> m.Event:
        """A single event in full fidelity."""
        return self._req.get(f"/v1/events/{_enc(event_id)}", m.Event)

    def get_payload(self, event_id: str) -> EventPayload:
        """The event's raw body bytes (base64 envelope decoded + length-checked against the declared size)."""
        env = self._req.get(
            f"/v1/events/{_enc(event_id)}/payload", m.EventsGetPayloadResponse
        )
        try:
            body = base64.b64decode(env.body_base64, validate=True)
        except ValueError as exc:  # binascii.Error subclasses ValueError
            raise WebhookUnexpectedResponseError(
                "the API returned a malformed base64 payload"
            ) from exc
        if len(body) != env.bytes:
            raise WebhookUnexpectedResponseError(
                "the API returned a corrupted payload response"
            )
        return EventPayload(content_type=env.content_type, body=body)

    def tail(
        self,
        endpoint_id: str,
        *,
        since: str | None = None,
        since_cursor: str | None = None,
    ) -> m.EventsTailResponse:
        """Poll the newest events for an endpoint (a single tail read; use the tunnel for live streaming)."""
        path = with_query(
            f"/v1/endpoints/{_enc(endpoint_id)}/events/tail",
            {"sinceCursor": since_cursor, "since": since},
        )
        return self._req.get(path, m.EventsTailResponse)

    def delete(self, event_id: str) -> m.EventsDeleteResponse:
        """Permanently delete ONE captured event.

        Its content is redacted immediately and its stored payload body is purged shortly after, so it can
        no longer be read or replayed, and it stops appearing in listings. There is no bulk or filter
        delete. Idempotent — re-deleting is a no-op, so a retry is safe.

        This does NOT reduce your metered usage: the event was already counted when it was received.
        """
        return self._req.delete(
            f"/v1/events/{_enc(event_id)}", True, m.EventsDeleteResponse
        )

    def replay(
        self,
        event_id: str,
        *,
        target: dict[str, Any],
        idempotency_key: str | None = None,
    ) -> m.DeliveryAttempt:
        """Replay a captured event. Idempotency-keyed → safe to retry a transient failure. If no key is
        given, a random one is generated (so the SDK's own retries dedup, and each call is distinct).
        """
        key = idempotency_key if idempotency_key is not None else str(uuid.uuid4())
        return self._req.post(
            f"/v1/events/{_enc(event_id)}/replay",
            {"target": target, "idempotencyKey": key},
            True,
            m.DeliveryAttempt,
        )


class _DeliveriesResource:
    def __init__(self, req: _Requester) -> None:
        self._req = req

    def _path(
        self,
        *,
        cursor: str | None,
        limit: int | None,
        destination_id: str | None,
        subscription_id: str | None,
        status: Sequence[str] | None,
    ) -> str:
        return with_query(
            "/v1/deliveries",
            {
                "cursor": cursor,
                "limit": limit,
                "destinationId": destination_id,
                "subscriptionId": subscription_id,
                "status": list(status) if status is not None else None,
            },
        )

    def list(
        self,
        *,
        limit: int | None = None,
        destination_id: str | None = None,
        subscription_id: str | None = None,
        status: Sequence[str] | None = None,
    ) -> Paginator[m.Delivery]:
        """Auto-paginating iterator over the org's outbound deliveries."""
        return self._req.paginate(
            lambda cursor: self._path(
                cursor=cursor,
                limit=limit,
                destination_id=destination_id,
                subscription_id=subscription_id,
                status=status,
            ),
            m.DeliveriesListResponse,
        )

    def list_page(
        self,
        *,
        cursor: str | None = None,
        limit: int | None = None,
        destination_id: str | None = None,
        subscription_id: str | None = None,
        status: Sequence[str] | None = None,
    ) -> Page[m.Delivery]:
        """A single page of deliveries."""
        return self._req.page(
            self._path(
                cursor=cursor,
                limit=limit,
                destination_id=destination_id,
                subscription_id=subscription_id,
                status=status,
            ),
            m.DeliveriesListResponse,
        )

    def get(self, delivery_id: str) -> m.Delivery:
        """A single delivery by id."""
        return self._req.get(f"/v1/deliveries/{_enc(delivery_id)}", m.Delivery)


class _ReplayDestinationsResource:
    def __init__(self, req: _Requester) -> None:
        self._req = req

    def create(
        self, *, url: str, label: str | None = None
    ) -> m.CreatedReplayDestination:
        """Register an allowed replay destination. Idempotent server-side (a re-add returns the existing row)."""
        body: dict[str, Any] = {"url": url}
        if label is not None:
            body["label"] = label
        return self._req.post(
            "/v1/replay-destinations", body, True, m.CreatedReplayDestination
        )

    def list(self) -> list[m.ReplayDestination]:
        """The org's live replay-destination allowlist (not paginated)."""
        resp = self._req.get(
            "/v1/replay-destinations", m.ReplayDestinationsListResponse
        )
        return list(resp.items)

    def delete(self, destination_id: str) -> m.ReplayDestinationDeleted:
        """Remove (soft-delete) a replay destination. NOT idempotent — a re-delete is NOT_FOUND."""
        return self._req.delete(
            f"/v1/replay-destinations/{_enc(destination_id)}",
            False,
            m.ReplayDestinationDeleted,
        )

    def enable(self, destination_id: str) -> m.ReplayDestination:
        """Clear a persistent-failure auto-disable. NOT idempotent — it also resets the failure tally, so a
        blind retry could wipe failures that accrued between the first call and the retry.
        """
        return self._req.post(
            f"/v1/replay-destinations/{_enc(destination_id)}/enable",
            {},
            False,
            m.ReplayDestination,
        )

    def set_ordered(self, destination_id: str, ordered: bool) -> m.ReplayDestination:
        """Set strict-FIFO (``ordered``) mode. Idempotent — converges to the same state on retry."""
        return self._req.post(
            f"/v1/replay-destinations/{_enc(destination_id)}/ordered",
            {"ordered": ordered},
            True,
            m.ReplayDestination,
        )

    def rotate_signing_secret(self, destination_id: str) -> m.RotatedSigningSecret:
        """Rotate the destination's signing secret (revealed once). NOT idempotent — each call mints a new one."""
        return self._req.post(
            f"/v1/replay-destinations/{_enc(destination_id)}/signing-secret",
            {},
            False,
            m.RotatedSigningSecret,
        )

    def list_signing_secrets(
        self, destination_id: str
    ) -> list[m.SigningSecretMetadata]:
        """A destination's signing-secret metadata (not paginated)."""
        resp = self._req.get(
            f"/v1/replay-destinations/{_enc(destination_id)}/signing-secrets",
            m.ReplayDestinationsListSigningSecretsResponse,
        )
        return list(resp.items)


class _SubscriptionsResource:
    def __init__(self, req: _Requester) -> None:
        self._req = req

    def create(
        self,
        *,
        source_endpoint_id: str,
        destination_id: str,
        provider: str | None = None,
        event_types: Sequence[str] | None = None,
        require_verified: bool | None = None,
    ) -> m.Subscription:
        """Create/upsert a delivery subscription. NOT idempotent — the upsert appends a tamper-evident
        audit row on each call, so a blind retry would write a phantom audit entry for one user action.
        """
        body: dict[str, Any] = {
            "sourceEndpointId": source_endpoint_id,
            "destinationId": destination_id,
        }
        if provider is not None:
            body["provider"] = provider
        if event_types is not None:
            body["eventTypes"] = list(event_types)
        if require_verified is not None:
            body["requireVerified"] = require_verified
        return self._req.post("/v1/subscriptions", body, False, m.Subscription)

    def list(self, source_endpoint_id: str | None = None) -> list[m.Subscription]:
        """The org's delivery subscriptions, optionally filtered by source endpoint (not paginated)."""
        path = with_query("/v1/subscriptions", {"sourceEndpointId": source_endpoint_id})
        resp = self._req.get(path, m.SubscriptionsListResponse)
        return list(resp.items)

    def delete(self, subscription_id: str) -> m.SubscriptionDeleted:
        """Remove a delivery subscription. NOT idempotent — a re-delete is NOT_FOUND."""
        return self._req.delete(
            f"/v1/subscriptions/{_enc(subscription_id)}", False, m.SubscriptionDeleted
        )


class _UsageResource:
    def __init__(self, req: _Requester) -> None:
        self._req = req

    def get(self) -> m.UsageGetResponse:
        """The current period's metered usage: events counted, the cap, and whether the org is paused."""
        return self._req.get("/v1/usage", m.UsageGetResponse)


class _TriggersResource:
    """Agent triggers (ADR-0106): the webhook->agent primitive behind :meth:`wait`."""

    def __init__(self, req: _Requester) -> None:
        self._req = req

    def list(self, *, endpoint_id: str | None = None) -> m.TriggersListResponse:
        """The org's triggers, optionally narrowed to one endpoint."""
        return self._req.get(
            with_query("/v1/triggers", {"endpointId": endpoint_id}),
            m.TriggersListResponse,
        )

    def create(
        self, *, endpoint_id: str, name: str | None = None
    ) -> m.TriggersCreateResponse:
        """Create a trigger. NOT idempotent — each call mints a new one, so it is never blind-retried."""
        body: dict[str, Any] = {"endpointId": endpoint_id}
        if name is not None:
            body["name"] = name
        return self._req.post("/v1/triggers", body, False, m.TriggersCreateResponse)

    def revoke(self, trigger_id: str) -> m.TriggersRevokeResponse:
        """Revoke a trigger. Idempotent."""
        return self._req.delete(
            f"/v1/triggers/{_enc(trigger_id)}", True, m.TriggersRevokeResponse
        )

    def wait(
        self,
        trigger_id: str,
        *,
        cursor: str | None = None,
        limit: int | None = None,
        include_body: bool | None = None,
        max_body_bytes: int | None = None,
    ) -> m.TriggersWaitResponse:
        """Wait for a trigger's events — ack-by-cursor (ADR-0106).

        SHORT-poll, not long-poll: it returns immediately with whatever is past ``cursor``, so there is no
        held connection and no special timeout handling. Drain a backlog by re-calling promptly while
        ``caught_up`` is False, then poll on your own cadence once caught up.

        ``cursor`` accepts None so a None ``next_cursor`` round-trips straight back in. Read the semantics
        carefully: ``next_cursor`` is None ONLY when you sent no cursor and there were no events — an empty
        page ECHOES the cursor you sent. So None means "start from the oldest retained event", NOT "caught
        up". ``caught_up`` is the caught-up signal; never infer it from a None cursor. (Passing None back is
        safe: you re-read from the oldest, which is at-least-once by design — dedup on the event id.)::

            cursor = None
            while True:
                page = client.triggers.wait(trigger_id, cursor=cursor)
                for event in page.events:
                    handle(event)
                cursor = page.next_cursor  # feed straight back in
                if page.caught_up:  # <- the caught-up signal
                    time.sleep(1)

        At-least-once: a crash before you persist ``next_cursor`` re-reads, never loses — dedup on the event
        id. ``include_body`` DEFAULTS TO TRUE server-side (pass False for summary-only, skipping the payload
        fetch); ``max_body_bytes`` clamps the inline body (<= 64 KiB). ``limit`` is capped at 200.
        """
        return self._req.get(
            with_query(
                f"/v1/triggers/{_enc(trigger_id)}/wait",
                {
                    "cursor": cursor,
                    "limit": limit,
                    "includeBody": include_body,
                    "maxBodyBytes": max_body_bytes,
                },
            ),
            m.TriggersWaitResponse,
        )


class _AuditResource:
    def __init__(self, req: _Requester) -> None:
        self._req = req

    def verify(self) -> m.AuditVerifyResponse:
        """Verify the org's tamper-evident audit chain. A read (no mutation) → safe to retry."""
        return self._req.post("/v1/audit/verify", None, True, m.AuditVerifyResponse)


class WebhookClient:
    """A typed, hardened client for the webhook.co REST API.

    Args:
        api_key: A ``whk_``-prefixed API key. Required.
        base_url: The API origin. Defaults to the hosted API; must be https (loopback http allowed for dev).
        http_client: An optional ``httpx.Client`` (for custom transports/proxies or testing). When the
            SDK creates its own, it disables redirect following.
        max_retries: Retries after the first attempt for idempotent requests (default 2).
        timeout_s: Per-request timeout in seconds, applied to each httpx phase (connect/read/write/pool);
            default 30. Not a single total-wall-clock deadline.
        refresh_auth: Hook to swap in a rotated bearer on a 401 (OAuth flows).
        on_debug: Optional sink for redacted, single-line diagnostics (never the raw key).
        on_advisory: Called AT MOST ONCE if the server reports this SDK version is behind. The advisory
            rides an ``x-webhook-advisory`` header on a response you already made — the SDK never polls
            PyPI on your behalf. Give a handler and it is yours to log; give none and the SDK emits a
            single ``UserWarning``.
        silence_advisories: Suppress version advisories entirely, including the warning.
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str | None = None,
        http_client: httpx.Client | None = None,
        max_retries: int | None = None,
        timeout_s: float | None = None,
        refresh_auth: Callable[[], str | None] | None = None,
        on_debug: Callable[[str], None] | None = None,
        on_advisory: Callable[[WebhookAdvisory], None] | None = None,
        silence_advisories: bool = False,
        sleep: Callable[[float], None] | None = None,
        rand: Callable[[], float] | None = None,
    ) -> None:
        if not api_key:
            raise WebhookConfigError("an api_key is required")
        resolved = resolve_base_url(base_url)
        self._owns_client = http_client is None
        client = (
            http_client
            if http_client is not None
            else httpx.Client(follow_redirects=False)
        )
        self._client = client

        http = HttpClient(
            base_url=resolved,
            api_key=api_key,
            http_client=client,
            max_retries=max_retries,
            timeout_s=timeout_s if timeout_s is not None else DEFAULT_TIMEOUT_S,
            refresh_auth=refresh_auth,
            on_debug=on_debug,
            # One reporter per client: the advisory fires at most once, not once per request.
            report_advisory=make_advisory_reporter(
                on_advisory, silent=silence_advisories
            ),
            sleep=sleep,
            rand=rand,
        )
        self._http = http
        req = _Requester(http)
        self.endpoints = _EndpointsResource(req)
        self.events = _EventsResource(req)
        self.deliveries = _DeliveriesResource(req)
        self.replay_destinations = _ReplayDestinationsResource(req)
        self.subscriptions = _SubscriptionsResource(req)
        self.usage = _UsageResource(req)
        self.triggers = _TriggersResource(req)
        self.audit = _AuditResource(req)

    def whoami(self) -> m.AuthContext:
        """Resolve the caller's own identity (validates the key)."""
        return _parse(
            m.AuthContext, self._http.request("GET", "/v1/whoami", idempotent=True)
        )

    def close(self) -> None:
        """Close the underlying HTTP client (only if the SDK created it)."""
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> WebhookClient:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()
