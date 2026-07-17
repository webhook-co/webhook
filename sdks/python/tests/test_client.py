from __future__ import annotations

import base64
import json

import httpx
import pytest

from webhook_co import WebhookClient
from webhook_co._errors import (
    WebhookConfigError,
    WebhookTargetUnreachableError,
    WebhookUnexpectedResponseError,
)

API_KEY = "whk_client_test_key_abcdefgh"
UUID = "11111111-1111-4111-8111-111111111111"
TS = "2026-01-01T00:00:00Z"


# --- fixture factories (complete, so the validated response models accept them) ---
def _endpoint(**o):
    return {
        "id": UUID,
        "orgId": UUID,
        "name": "n",
        "paused": False,
        "createdAt": TS,
        "dedupConfig": None,
        **o,
    }


def _deleted_endpoint():
    return {"id": UUID, "deletedAt": TS}


def _event():
    return {
        "id": UUID,
        "orgId": UUID,
        "endpointId": UUID,
        "receivedAt": TS,
        "provider": "stripe",
        "dedupKey": "dk",
        "dedupStrategy": "content_hash",
        "verified": True,
        "payloadR2Key": "k",
        "payloadBytes": 10,
        "contentType": "application/json",
        "headers": [],
        "providerEventId": None,
        "externalId": None,
        "verification": None,
    }


def _delivery_attempt():
    return {
        "id": UUID,
        "orgId": UUID,
        "eventId": UUID,
        "target": "s1",
        "idempotencyKey": "idem-1",
        "status": "delivered",
        "statusCode": 200,
        "attempt": 1,
        "error": None,
        "createdAt": TS,
    }


def _delivery():
    return {
        "id": UUID,
        "eventId": UUID,
        "destinationId": UUID,
        "subscriptionId": None,
        "status": "delivered",
        "statusCode": 200,
        "attempt": 1,
        "error": None,
        "nextRetryAt": None,
        "createdAt": TS,
        "sourceVerificationState": "verified",
    }


def _replay_destination():
    return {
        "id": UUID,
        "orgId": UUID,
        "url": "https://ex.test/hook",
        "label": "prod",
        "status": "active",
        "createdAt": TS,
        "lastValidatedAt": None,
        "ordered": False,
        "disabledAt": None,
    }


def _subscription():
    return {
        "id": UUID,
        "orgId": UUID,
        "sourceEndpointId": UUID,
        "destinationId": UUID,
        "provider": None,
        "eventTypes": ["*"],
        "requireVerified": False,
        "enabled": True,
        "createdAt": TS,
        "updatedAt": TS,
    }


def _added_secret():
    return {"id": UUID, "provider": "stripe", "status": "active"}


def _provider_secret():
    return {
        "id": UUID,
        "provider": "stripe",
        "status": "active",
        "label": None,
        "createdAt": TS,
    }


def _signing_secret_meta():
    return {"id": UUID, "status": "active", "createdAt": TS}


def make(queue, **overrides):
    calls: list[httpx.Request] = []
    state = {"i": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        item = queue[state["i"]]
        state["i"] += 1
        return item

    client = httpx.Client(
        transport=httpx.MockTransport(handler), follow_redirects=False
    )
    return (
        WebhookClient(
            API_KEY,
            http_client=client,
            sleep=lambda s: None,
            rand=lambda: 0.0,
            **overrides,
        ),
        calls,
    )


def jr(status, body, headers=None):
    return httpx.Response(status, json=body, headers=headers or {})


def unreachable():
    return jr(502, {"error": "TARGET_UNREACHABLE", "message": "x"})


def body_of(request):
    return json.loads(request.content) if request.content else None


class TestConstructor:
    def test_rejects_missing_api_key(self):
        with pytest.raises(WebhookConfigError):
            WebhookClient("")

    def test_rejects_plaintext_non_loopback_base_url(self):
        with pytest.raises(WebhookConfigError):
            WebhookClient(API_KEY, base_url="http://api.webhook.co")


class TestWhoami:
    def test_reads_identity(self):
        wc, calls = make([jr(200, {"orgId": UUID, "scopes": ["endpoints:read"]})])
        assert wc.whoami().org_id == UUID
        assert str(calls[0].url) == "https://api.webhook.co/v1/whoami"


class TestEndpoints:
    def test_get(self):
        wc, calls = make([jr(200, _endpoint())])
        wc.endpoints.get("e 1")
        assert str(calls[0].url) == "https://api.webhook.co/v1/endpoints/e%201"

    def test_create_posts_name_not_retried(self):
        wc, calls = make([unreachable()])
        with pytest.raises(WebhookTargetUnreachableError):
            wc.endpoints.create(name="prod")
        assert len(calls) == 1
        assert body_of(calls[0]) == {"name": "prod"}
        assert calls[0].method == "POST"

    def test_delete_is_idempotent(self):
        wc, calls = make([unreachable(), jr(200, _deleted_endpoint())])
        wc.endpoints.delete(UUID)
        assert len(calls) == 2
        assert calls[0].method == "DELETE"

    def test_reveal_ingest_url_posts_no_body_and_is_NOT_retried(self):
        # Every reveal writes a tamper-evident disclosure row, so a blind retry would double-audit.
        wc, calls = make([unreachable()])
        with pytest.raises(WebhookTargetUnreachableError):
            wc.endpoints.reveal_ingest_url(UUID)
        assert len(calls) == 1
        assert calls[0].method == "POST"
        assert str(calls[0].url).endswith("/reveal-ingest-url")
        assert calls[0].content == b""

    def test_reveal_ingest_url_returns_none_for_pre_sealed_endpoint(self):
        wc, _ = make([jr(200, {"ingestUrl": None})])
        assert wc.endpoints.reveal_ingest_url(UUID).ingest_url is None

    def test_update_patches_the_dedup_config_and_is_retried(self):
        wc, calls = make([unreachable(), jr(200, _endpoint())])
        wc.endpoints.update(UUID, dedup_config=None)
        assert len(calls) == 2  # idempotent -> a transient failure is retried
        assert calls[0].method == "PATCH"
        assert json.loads(calls[0].content) == {"dedupConfig": None}

    def test_rotate_posts_no_body_not_retried(self):
        wc, calls = make([unreachable()])
        with pytest.raises(WebhookTargetUnreachableError):
            wc.endpoints.rotate(UUID)
        assert len(calls) == 1
        assert calls[0].content == b""
        assert str(calls[0].url).endswith("/rotate")

    def test_list_auto_paginates(self):
        wc, _ = make(
            [
                jr(
                    200,
                    {
                        "items": [_endpoint(name="a"), _endpoint(name="b")],
                        "nextCursor": "c1",
                    },
                ),
                jr(200, {"items": [_endpoint(name="c")], "nextCursor": None}),
            ]
        )
        assert [e.name for e in wc.endpoints.list()] == ["a", "b", "c"]

    def test_list_threads_filters(self):
        wc, calls = make([jr(200, {"items": [], "nextCursor": None})])
        wc.endpoints.list(name="prod", limit=10).collect()
        assert (
            str(calls[0].url)
            == "https://api.webhook.co/v1/endpoints?limit=10&name=prod"
        )

    def test_list_page(self):
        wc, _ = make([jr(200, {"items": [_endpoint()], "nextCursor": "next"})])
        page = wc.endpoints.list_page(limit=1)
        assert page.next_cursor == "next"
        assert len(page.items) == 1

    def test_provider_secrets_add_optional_fields(self):
        wc, calls = make([jr(200, _added_secret())])
        wc.endpoints.provider_secrets.add(
            endpoint_id="e1", provider="stripe", secret="whsec_x"
        )
        assert body_of(calls[0]) == {"provider": "stripe", "secret": "whsec_x"}

    def test_provider_secrets_add_with_kind(self):
        wc, calls = make([jr(200, _added_secret())])
        wc.endpoints.provider_secrets.add(
            endpoint_id="e1",
            provider="braintree",
            secret="pk_x",
            label="prod",
            kind="braintree_public_key",
        )
        assert body_of(calls[0]) == {
            "provider": "braintree",
            "secret": "pk_x",
            "label": "prod",
            "kind": "braintree_public_key",
        }

    def test_provider_secrets_list_unwraps(self):
        wc, _ = make([jr(200, {"items": [_provider_secret()]})])
        assert len(wc.endpoints.provider_secrets.list("e1")) == 1

    def test_provider_secrets_revoke_not_retried(self):
        wc, calls = make([unreachable()])
        with pytest.raises(WebhookTargetUnreachableError):
            wc.endpoints.provider_secrets.revoke(endpoint_id="e1", secret_id="ps1")
        assert len(calls) == 1
        assert str(calls[0].url).endswith("/provider-secrets/ps1")


class TestEvents:
    def test_list_multi_select_query(self):
        wc, calls = make([jr(200, {"items": [], "nextCursor": None})])
        wc.events.list(
            endpoint_id="e1",
            provider=["stripe", "github"],
            verification_state=["verified"],
            search="checkout",
            method=["GET", "POST"],
            limit=25,
        ).collect()
        url = str(calls[0].url)
        assert "/v1/events?" in url  # canonical route
        assert "endpointId=e1" in url
        assert "provider=stripe&provider=github" in url
        assert "verificationState=verified" in url
        assert "search=checkout" in url
        assert "method=GET&method=POST" in url
        assert "limit=25" in url

    def test_list_org_wide_omits_endpoint_id(self):
        wc, calls = make([jr(200, {"items": [], "nextCursor": None})])
        wc.events.list(provider=["stripe"]).collect()
        url = str(calls[0].url)
        assert "/v1/events?" in url
        assert "endpointId" not in url

    def test_list_by_endpoint_uses_deprecated_nested_route(self):
        wc, calls = make([jr(200, {"items": [], "nextCursor": None})])
        wc.events.list_page_by_endpoint("e1", limit=1)
        assert "/v1/endpoints/e1/events" in str(calls[0].url)

    def test_list_by_endpoint_iterator_uses_deprecated_nested_route(self):
        wc, calls = make([jr(200, {"items": [], "nextCursor": None})])
        wc.events.list_by_endpoint("e1", provider=["stripe"]).collect()
        url = str(calls[0].url)
        assert "/v1/endpoints/e1/events" in url
        assert "provider=stripe" in url

    def test_get(self):
        wc, calls = make([jr(200, _event())])
        wc.events.get("ev1")
        assert str(calls[0].url) == "https://api.webhook.co/v1/events/ev1"

    def test_get_payload_decodes(self):
        wc, _ = make(
            [
                jr(
                    200,
                    {
                        "contentType": "application/json",
                        "bytes": 5,
                        "bodyBase64": base64.b64encode(b"hello").decode(),
                    },
                )
            ]
        )
        payload = wc.events.get_payload("ev1")
        assert payload.content_type == "application/json"
        assert payload.body == b"hello"

    def test_get_payload_rejects_length_mismatch(self):
        wc, _ = make(
            [
                jr(
                    200,
                    {
                        "contentType": None,
                        "bytes": 999,
                        "bodyBase64": base64.b64encode(b"hello").decode(),
                    },
                )
            ]
        )
        with pytest.raises(WebhookUnexpectedResponseError):
            wc.events.get_payload("ev1")

    def test_tail(self):
        wc, calls = make([jr(200, {"items": [], "nextCursor": None})])
        wc.events.tail("e1", since="now", since_cursor="cur")
        assert (
            str(calls[0].url)
            == "https://api.webhook.co/v1/endpoints/e1/events/tail?sinceCursor=cur&since=now"
        )

    def test_replay_posts_target_and_key_retried(self):
        wc, calls = make([unreachable(), jr(200, _delivery_attempt())])
        wc.events.replay(
            "ev1",
            target={"kind": "localhost-tunnel", "sessionId": "s1"},
            idempotency_key="idem-1",
        )
        assert len(calls) == 2
        assert body_of(calls[0]) == {
            "target": {"kind": "localhost-tunnel", "sessionId": "s1"},
            "idempotencyKey": "idem-1",
        }

    def test_replay_auto_generates_idempotency_key(self):
        wc, calls = make([jr(200, _delivery_attempt())])
        wc.events.replay("ev1", target={"kind": "localhost-tunnel", "sessionId": "s1"})
        sent = body_of(calls[0])
        assert (
            isinstance(sent["idempotencyKey"], str) and len(sent["idempotencyKey"]) > 0
        )


class TestDeliveries:
    def test_list_filters(self):
        wc, calls = make([jr(200, {"items": [], "nextCursor": None})])
        wc.deliveries.list(
            destination_id="d1", status=["failed", "delivered"]
        ).collect()
        url = str(calls[0].url)
        assert "destinationId=d1" in url
        assert "status=failed&status=delivered" in url

    def test_get(self):
        wc, calls = make([jr(200, _delivery())])
        wc.deliveries.get("del1")
        assert str(calls[0].url) == "https://api.webhook.co/v1/deliveries/del1"


class TestReplayDestinations:
    def test_create_idempotent(self):
        wc, calls = make([unreachable(), jr(200, _replay_destination())])
        wc.replay_destinations.create(url="https://ex.test/hook", label="prod")
        assert len(calls) == 2
        assert body_of(calls[0]) == {"url": "https://ex.test/hook", "label": "prod"}

    def test_list_unwraps(self):
        wc, _ = make([jr(200, {"items": [_replay_destination()]})])
        assert len(wc.replay_destinations.list()) == 1

    def test_delete_not_retried(self):
        wc, calls = make([unreachable()])
        with pytest.raises(WebhookTargetUnreachableError):
            wc.replay_destinations.delete("d1")
        assert len(calls) == 1

    def test_enable_empty_body_not_retried(self):
        wc, calls = make([unreachable()])
        with pytest.raises(WebhookTargetUnreachableError):
            wc.replay_destinations.enable("d1")
        assert body_of(calls[0]) == {}
        assert str(calls[0].url).endswith("/enable")

    def test_set_ordered_idempotent(self):
        wc, calls = make([unreachable(), jr(200, _replay_destination())])
        wc.replay_destinations.set_ordered("d1", True)
        assert len(calls) == 2
        assert body_of(calls[0]) == {"ordered": True}

    def test_rotate_signing_secret_not_retried(self):
        wc, calls = make([unreachable()])
        with pytest.raises(WebhookTargetUnreachableError):
            wc.replay_destinations.rotate_signing_secret("d1")
        assert str(calls[0].url).endswith("/signing-secret")

    def test_list_signing_secrets_unwraps(self):
        wc, _ = make(
            [jr(200, {"items": [_signing_secret_meta(), _signing_secret_meta()]})]
        )
        assert len(wc.replay_destinations.list_signing_secrets("d1")) == 2


class TestSubscriptions:
    def test_create_minimal_not_retried(self):
        wc, calls = make([unreachable()])
        with pytest.raises(WebhookTargetUnreachableError):
            wc.subscriptions.create(source_endpoint_id="e1", destination_id="d1")
        assert len(calls) == 1
        assert body_of(calls[0]) == {"sourceEndpointId": "e1", "destinationId": "d1"}

    def test_create_with_optional_fields(self):
        wc, calls = make([jr(200, _subscription())])
        wc.subscriptions.create(
            source_endpoint_id="e1",
            destination_id="d1",
            provider="stripe",
            event_types=["a", "b"],
            require_verified=True,
        )
        assert body_of(calls[0]) == {
            "sourceEndpointId": "e1",
            "destinationId": "d1",
            "provider": "stripe",
            "eventTypes": ["a", "b"],
            "requireVerified": True,
        }

    def test_list_filter_and_unwrap(self):
        wc, calls = make([jr(200, {"items": [_subscription()]})])
        subs = wc.subscriptions.list(source_endpoint_id="e1")
        assert len(subs) == 1
        assert (
            str(calls[0].url)
            == "https://api.webhook.co/v1/subscriptions?sourceEndpointId=e1"
        )

    def test_delete_not_retried(self):
        wc, calls = make([unreachable()])
        with pytest.raises(WebhookTargetUnreachableError):
            wc.subscriptions.delete("sub1")
        assert len(calls) == 1


class TestAudit:
    def test_verify_idempotent_no_body(self):
        wc, calls = make([unreachable(), jr(200, {"ok": True, "rowsVerified": 3})])
        wc.audit.verify()
        assert len(calls) == 2
        assert calls[0].content == b""
        assert str(calls[0].url) == "https://api.webhook.co/v1/audit/verify"


class TestUsageAndTriggers:
    def test_events_delete_is_retried(self):
        wc, calls = make([unreachable(), jr(200, {"id": UUID, "deletedAt": TS})])
        wc.events.delete(UUID)
        assert len(calls) == 2  # idempotent: re-deleting is a no-op
        assert calls[0].method == "DELETE"

    def test_usage_get(self):
        wc, calls = make(
            [
                jr(
                    200,
                    {
                        "periodStart": TS,
                        "periodEnd": None,
                        "capKind": "lifetime",
                        "events": 12,
                        "eventCap": 5000,
                        "pausePolicy": "pause",
                        "paused": False,
                    },
                )
            ]
        )
        assert wc.usage.get().events == 12
        assert str(calls[0].url).endswith("/v1/usage")

    def test_triggers_create_not_retried(self):
        wc, calls = make([unreachable()])
        with pytest.raises(WebhookTargetUnreachableError):
            wc.triggers.create(endpoint_id=UUID, name="orders")
        assert len(calls) == 1  # each call mints a trigger
        assert json.loads(calls[0].content) == {"endpointId": UUID, "name": "orders"}

    def test_triggers_list_filter(self):
        wc, calls = make([jr(200, {"items": []})])
        wc.triggers.list(endpoint_id=UUID)
        assert str(calls[0].url).endswith(f"/v1/triggers?endpointId={UUID}")

    # The ack-by-cursor loop from the docstring must actually run: a caught-up page returns next_cursor=None,
    # and the contract makes the input nullable so THAT value feeds straight back in. If None serialised we
    # would send the literal string "None"/"null" and earn a VALIDATION_ERROR.
    def test_triggers_wait_round_trips_a_caught_up_none_cursor(self):
        wc, calls = make(
            [
                jr(200, {"events": [], "nextCursor": "c1", "caughtUp": False}),
                jr(200, {"events": [], "nextCursor": None, "caughtUp": True}),
                jr(200, {"events": [], "nextCursor": None, "caughtUp": True}),
            ]
        )
        cursor = None
        for _ in range(3):
            page = wc.triggers.wait(UUID, cursor=cursor)
            cursor = (
                page.next_cursor
            )  # None once caught up — must be accepted next call
        assert "cursor" not in str(calls[0].url)
        assert "cursor=c1" in str(calls[1].url)
        assert "cursor" not in str(calls[2].url)

    def test_triggers_wait_sends_lowercase_booleans(self):
        # boolParam accepts ONLY "true"/"1"/"false"/"0" — "False" is silently ignored and the server default
        # (includeBody=true) applies, so a summary-only caller would get full bodies anyway.
        wc, calls = make(
            [jr(200, {"events": [], "nextCursor": None, "caughtUp": True})]
        )
        wc.triggers.wait(UUID, include_body=False, limit=10, max_body_bytes=4096)
        url = str(calls[0].url)
        assert "includeBody=false" in url
        assert "limit=10" in url
        assert "maxBodyBytes=4096" in url
