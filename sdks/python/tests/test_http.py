from __future__ import annotations

import json

import httpx
import pytest

from webhook_co._errors import (
    WebhookAuthenticationError,
    WebhookConnectionError,
    WebhookError,
    WebhookNotFoundError,
    WebhookPermissionError,
    WebhookRateLimitError,
    WebhookTargetUnreachableError,
    WebhookUnexpectedResponseError,
)
from webhook_co._http import HttpClient

API_KEY = "whk_test_key_abcdefghijklmnop"
BASE = "https://api.webhook.co"

# Sentinel: the queued handler should raise a transport error for this entry.
TRANSPORT_ERROR = object()


def make_http(queue, **overrides):
    calls: list[httpx.Request] = []
    state = {"i": 0}
    sleeps: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        item = queue[state["i"]]
        state["i"] += 1
        if item is TRANSPORT_ERROR:
            raise httpx.ConnectError("boom", request=request)
        return item

    client = httpx.Client(
        transport=httpx.MockTransport(handler), follow_redirects=False
    )
    http = HttpClient(
        base_url=BASE,
        api_key=API_KEY,
        http_client=client,
        sleep=lambda s: sleeps.append(s),
        rand=lambda: 0.0,
        **overrides,
    )
    return http, calls, sleeps


def jr(status, body, headers=None):
    return httpx.Response(status, json=body, headers=headers or {})


def tr(status, text, headers=None):
    return httpx.Response(status, text=text, headers=headers or {})


def er(status, headers=None):
    return httpx.Response(status, headers=headers or {})


class TestRequest:
    def test_bearer_get_returns_parsed_json(self):
        http, calls, _ = make_http([jr(200, {"ok": True})])
        body = http.request("GET", "/v1/whoami", idempotent=True)
        assert body == {"ok": True}
        assert str(calls[0].url) == f"{BASE}/v1/whoami"
        assert calls[0].method == "GET"
        assert calls[0].headers["authorization"] == f"Bearer {API_KEY}"
        assert calls[0].headers["accept"] == "application/json"

    def test_post_serialises_body_and_content_type(self):
        http, calls, _ = make_http([jr(200, {"id": "e1"})])
        http.request("POST", "/v1/endpoints", body={"name": "x"}, idempotent=False)
        assert json.loads(calls[0].content) == {"name": "x"}
        assert calls[0].headers["content-type"] == "application/json"

    def test_no_body_no_content_type(self):
        http, calls, _ = make_http([jr(200, {})])
        http.request("POST", "/v1/audit/verify", idempotent=True)
        assert calls[0].content == b""
        assert "content-type" not in calls[0].headers

    def test_retries_idempotent_get_on_502_then_succeeds(self):
        http, calls, sleeps = make_http(
            [
                jr(502, {"error": "TARGET_UNREACHABLE", "message": "bad"}),
                jr(200, {"ok": 1}),
            ]
        )
        assert http.request("GET", "/v1/endpoints", idempotent=True) == {"ok": 1}
        assert len(calls) == 2
        assert len(sleeps) == 1

    def test_no_retry_non_idempotent_post_on_502(self):
        http, calls, _ = make_http(
            [jr(502, {"error": "TARGET_UNREACHABLE", "message": "bad"})]
        )
        with pytest.raises(WebhookTargetUnreachableError):
            http.request("POST", "/v1/endpoints", body={}, idempotent=False)
        assert len(calls) == 1

    def test_retries_idempotent_on_transport_failure(self):
        http, calls, _ = make_http([TRANSPORT_ERROR, jr(200, {"ok": 1})])
        assert http.request("GET", "/v1/endpoints", idempotent=True) == {"ok": 1}
        assert len(calls) == 2

    def test_connection_error_for_non_idempotent_transport_failure(self):
        http, calls, _ = make_http([TRANSPORT_ERROR])
        with pytest.raises(WebhookConnectionError):
            http.request("POST", "/v1/endpoints", body={}, idempotent=False)
        assert len(calls) == 1

    def test_honours_retry_after_on_429(self):
        http, _, sleeps = make_http(
            [
                jr(
                    429,
                    {"error": "RATE_LIMITED", "message": "slow"},
                    {"retry-after": "7"},
                ),
                jr(200, {"ok": 1}),
            ]
        )
        http.request("GET", "/v1/endpoints", idempotent=True)
        assert sleeps == [7.0]

    def test_gives_up_after_max_retries(self):
        http, calls, _ = make_http(
            [jr(429, {"error": "RATE_LIMITED", "message": "s"}) for _ in range(3)],
            max_retries=2,
        )
        with pytest.raises(WebhookRateLimitError):
            http.request("GET", "/v1/endpoints", idempotent=True)
        assert len(calls) == 3

    def test_refreshes_bearer_once_on_401(self):
        http, calls, _ = make_http(
            [er(401), jr(200, {"ok": 1})], refresh_auth=lambda: "whk_rotated_new_token"
        )
        assert http.request("GET", "/v1/whoami", idempotent=True) == {"ok": 1}
        assert calls[0].headers["authorization"] == f"Bearer {API_KEY}"
        assert calls[1].headers["authorization"] == "Bearer whk_rotated_new_token"

    def test_401_refresh_declines_surfaces_error(self):
        http, calls, _ = make_http([er(401)], refresh_auth=lambda: None)
        with pytest.raises(WebhookAuthenticationError):
            http.request("GET", "/v1/whoami", idempotent=True)
        assert len(calls) == 1

    def test_401_without_refresh_surfaces_immediately(self):
        http, calls, _ = make_http([er(401)])
        with pytest.raises(WebhookAuthenticationError):
            http.request("GET", "/v1/whoami", idempotent=True)
        assert len(calls) == 1

    def test_empty_403_is_permission_error_with_default_message(self):
        http, _, _ = make_http([er(403)])
        with pytest.raises(WebhookPermissionError) as exc:
            http.request("GET", "/v1/endpoints", idempotent=True)
        assert "scope" in exc.value.message

    def test_text_plain_404_is_not_found(self):
        http, _, _ = make_http([tr(404, "Not Found")])
        with pytest.raises(WebhookNotFoundError):
            http.request("GET", "/v1/nope", idempotent=True)

    def test_malformed_json_200_is_unexpected(self):
        http, _, _ = make_http(
            [
                httpx.Response(
                    200,
                    content=b"{not json",
                    headers={"content-type": "application/json"},
                )
            ]
        )
        with pytest.raises(WebhookUnexpectedResponseError):
            http.request("GET", "/v1/endpoints", idempotent=True)

    def test_threads_request_id(self):
        http, _, _ = make_http(
            [
                jr(
                    404,
                    {"error": "NOT_FOUND", "message": "gone"},
                    {"x-request-id": "req_123"},
                )
            ]
        )
        with pytest.raises(WebhookNotFoundError) as exc:
            http.request("GET", "/v1/endpoints/x", idempotent=True)
        assert exc.value.request_id == "req_123"

    def test_retry_after_s_on_non_retried_429(self):
        http, _, _ = make_http(
            [jr(429, {"error": "RATE_LIMITED", "message": "s"}, {"retry-after": "12"})]
        )
        with pytest.raises(WebhookRateLimitError) as exc:
            http.request("POST", "/v1/subscriptions", body={}, idempotent=False)
        assert exc.value.retry_after_s == 12.0

    def test_redacts_api_key_in_error_message(self):
        http, _, _ = make_http(
            [
                jr(
                    400,
                    {
                        "error": "VALIDATION_ERROR",
                        "message": f"bad token {API_KEY} sent",
                    },
                )
            ]
        )
        with pytest.raises(WebhookError) as exc:
            http.request("GET", "/v1/endpoints", idempotent=True)
        assert API_KEY not in exc.value.message
        assert "[redacted]" in exc.value.message

    def test_debug_hook_no_key_leak(self):
        seen: list[str] = []
        http, _, _ = make_http([jr(200, {"ok": 1})], on_debug=seen.append)
        http.request("GET", "/v1/whoami", idempotent=True)
        assert seen
        assert all(API_KEY not in line for line in seen)

    def test_does_not_follow_a_redirect(self):
        http, calls, _ = make_http(
            [httpx.Response(302, headers={"location": "https://evil.test/"})]
        )
        with pytest.raises(WebhookUnexpectedResponseError):
            http.request("GET", "/v1/whoami", idempotent=True)
        assert len(calls) == 1

    def test_redacts_rotated_bearer_in_error(self):
        rotated = "rotated-opaque-secret-not-whk-prefixed-123456"
        http, _, _ = make_http(
            [
                er(401),
                jr(
                    400, {"error": "VALIDATION_ERROR", "message": f"bad {rotated} sent"}
                ),
            ],
            refresh_auth=lambda: rotated,
        )
        with pytest.raises(WebhookError) as exc:
            http.request("GET", "/v1/whoami", idempotent=True)
        assert rotated not in exc.value.message
