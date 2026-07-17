from __future__ import annotations

import base64

import httpx
import pytest

from webhook_co import WebhookClient
from webhook_co._errors import WebhookNotFoundError, WebhookUnexpectedResponseError
from webhook_co._http import HttpClient

API_KEY = "whk_client_test_key_abcdefgh"
UUID = "11111111-1111-4111-8111-111111111111"
TS = "2026-01-01T00:00:00Z"


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


def _client(responses):
    state = {"i": 0}

    def handler(request):
        item = responses[state["i"]]
        state["i"] += 1
        return item

    transport = httpx.MockTransport(handler)
    return httpx.Client(transport=transport, follow_redirects=False)


def wc(responses, **overrides):
    return WebhookClient(
        API_KEY,
        http_client=_client(responses),
        sleep=lambda s: None,
        rand=lambda: 0.0,
        **overrides,
    )


def http(responses, **overrides):
    return HttpClient(
        base_url="https://api.webhook.co",
        api_key=API_KEY,
        http_client=_client(responses),
        sleep=lambda s: None,
        rand=lambda: 0.0,
        **overrides,
    )


def jr(status, body, headers=None):
    return httpx.Response(status, json=body, headers=headers or {})


class TestHttpErrorBodyEdges:
    def test_non_string_error_code_falls_back_to_status(self):
        # error is not a valid code string → resolve by status (404 → NOT_FOUND)
        c = http([jr(404, {"error": 123, "message": "gone"})])
        with pytest.raises(WebhookNotFoundError):
            c.request("GET", "/v1/endpoints/x", idempotent=True)

    def test_malformed_json_error_body_falls_back_to_status(self):
        bad = httpx.Response(
            404, content=b"{broken", headers={"content-type": "application/json"}
        )
        c = http([bad])
        with pytest.raises(WebhookNotFoundError):
            c.request("GET", "/v1/endpoints/x", idempotent=True)


class TestClientEdges:
    def test_parse_validation_failure_is_unexpected(self):
        # A body missing required Endpoint fields fails model validation.
        client = wc([jr(200, {"id": UUID})])
        with pytest.raises(WebhookUnexpectedResponseError):
            client.endpoints.get("e1")

    def test_validation_failure_does_not_leak_response_secrets(self):
        import traceback

        secret = "whsec_super_secret_revealed_once_abcdef"
        # A CreatedReplayDestination body carrying a signing secret but missing required fields → the
        # pydantic ValidationError embeds the input; the SDK must not surface it in the raised error chain.
        client = wc([jr(200, {"signingSecret": secret, "id": "not-a-valid-uuid"})])
        try:
            client.replay_destinations.create(url="https://ex.test/hook")
        except WebhookUnexpectedResponseError as exc:
            tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
            assert secret not in tb
            assert exc.__cause__ is None
        else:
            raise AssertionError("expected WebhookUnexpectedResponseError")

    def test_get_payload_malformed_base64(self):
        client = wc(
            [jr(200, {"contentType": None, "bytes": 3, "bodyBase64": "not*base64*"})]
        )
        with pytest.raises(WebhookUnexpectedResponseError):
            client.events.get_payload("ev1")

    def test_events_list_page(self):
        client = wc([jr(200, {"items": [], "nextCursor": "n"})])
        page = client.events.list_page(endpoint_id="e1", limit=5, search="x")
        assert page.next_cursor == "n"

    def test_deliveries_list_page(self):
        client = wc([jr(200, {"items": [], "nextCursor": None})])
        page = client.deliveries.list_page(status=["failed"])
        assert page.next_cursor is None

    def test_close_and_context_manager(self):
        client = wc([jr(200, _endpoint())])
        with client as c:
            c.endpoints.get("e1")
        # idempotent double-close is harmless
        client.close()

    def test_does_not_follow_redirects_even_with_a_follow_client(self):
        # An injected client that opts into redirects must still be overridden per-request, so the
        # Authorization header is never replayed to a redirect target.
        state = {"i": 0}

        def handler(request):
            item = [httpx.Response(302, headers={"location": "https://evil.test/"})][
                state["i"]
            ]
            state["i"] += 1
            return item

        client = WebhookClient(
            API_KEY,
            http_client=httpx.Client(
                transport=httpx.MockTransport(handler), follow_redirects=True
            ),
            sleep=lambda s: None,
            rand=lambda: 0.0,
        )
        with pytest.raises(WebhookUnexpectedResponseError):
            client.whoami()

    def test_close_owned_client(self):
        # No injected client → the SDK owns the httpx.Client and closes it (no network made).
        client = WebhookClient(API_KEY)
        client.close()

    def test_get_payload_success(self):
        client = wc(
            [
                jr(
                    200,
                    {
                        "contentType": "text/plain",
                        "bytes": 2,
                        "bodyBase64": base64.b64encode(b"hi").decode(),
                    },
                )
            ]
        )
        assert client.events.get_payload("ev1").body == b"hi"
