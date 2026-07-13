"""The server-driven version advisory: the SDK identifies itself, the server answers on a response the
caller already made. No PyPI polling from inside someone's Lambda, no extra request."""

from __future__ import annotations

import httpx
import pytest

from webhook_co import WebhookClient
from webhook_co._advisory import (
    make_advisory_reporter,
    parse_advisory,
    user_agent,
)


class TestUserAgent:
    def test_identifies_client_and_version(self):
        ua = user_agent()
        assert ua.startswith("webhook-co-python/")
        assert "python/" in ua


class TestParseAdvisory:
    def test_parses_an_update(self):
        a = parse_advisory("update-available; current=0.2.0; latest=0.3.0", None)
        assert a is not None and a.current == "0.2.0" and a.latest == "0.3.0"
        assert a.deprecated is False

    def test_deprecation_is_louder_than_an_update(self):
        a = parse_advisory("deprecated; current=0.1.0; latest=0.3.0", "true")
        assert a is not None and a.deprecated is True
        assert "no longer supported" in a.message

    def test_absent_or_malformed_returns_none_and_never_raises(self):
        # The server is not this SDK's parser. A garbled header must never raise in a caller's request path.
        for bad in [
            None,
            "",
            "garbage",
            "update-available",
            "update-available; current=; latest=",
        ]:
            assert parse_advisory(bad, None) is None


class TestReporter:
    def test_reports_once_however_many_requests(self):
        seen = []
        report = make_advisory_reporter(seen.append)
        for _ in range(5):
            report("update-available; current=0.2.0; latest=0.3.0", None)
        assert len(seen) == 1  # a per-request nag is a bug, not a feature

    def test_falls_back_to_a_single_warning_with_no_handler(self):
        warned = []
        report = make_advisory_reporter(None, warn=warned.append)
        report("update-available; current=0.2.0; latest=0.3.0", None)
        report("update-available; current=0.2.0; latest=0.3.0", None)
        assert len(warned) == 1 and "0.2.0 -> 0.3.0" in warned[0]

    def test_silent_says_nothing_at_all(self):
        warned = []
        report = make_advisory_reporter(None, silent=True, warn=warned.append)
        report("deprecated; current=0.1.0; latest=0.3.0", "true")
        assert warned == []

    def test_a_throwing_handler_never_breaks_the_request(self):
        def boom(_a):
            raise RuntimeError("caller's logging bug")

        report = make_advisory_reporter(boom)
        report("update-available; current=0.2.0; latest=0.3.0", None)  # must not raise


class TestEndToEnd:
    """Through the real client: we send the UA, the server rides an advisory, we surface it ONCE."""

    # A valid whoami body: the SDK validates responses, so a thin stub is (correctly) rejected.
    WHOAMI = {
        "orgId": "22222222-2222-4222-8222-222222222222",
        "userId": None,
        "scopes": [],
    }

    def _client(self, headers, seen, **kw):
        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json=self.WHOAMI, headers=headers)

        return WebhookClient(
            api_key="whk_advisory_test_key_abc",
            http_client=httpx.Client(transport=httpx.MockTransport(handler)),
            **kw,
        )

    def test_sends_a_versioned_user_agent(self):
        seen = []
        client = self._client({}, seen)
        client.whoami()
        assert seen[0].headers["user-agent"].startswith("webhook-co-python/")

    def test_surfaces_the_advisory_exactly_once(self):
        got, seen = [], []
        client = self._client(
            {"x-webhook-advisory": "update-available; current=0.0.0; latest=9.9.9"},
            seen,
            on_advisory=got.append,
        )
        client.whoami()
        client.whoami()
        client.whoami()
        assert len(got) == 1  # once per client, not once per request
        assert got[0].latest == "9.9.9"

    def test_silent_when_the_server_sends_no_advisory(self):
        got, seen = [], []
        client = self._client({}, seen, on_advisory=got.append)
        client.whoami()
        assert got == []

    def test_can_be_silenced(self):
        got, seen = [], []
        client = self._client(
            {"x-webhook-advisory": "update-available; current=0.0.0; latest=9.9.9"},
            seen,
            on_advisory=got.append,
            silence_advisories=True,
        )
        client.whoami()
        assert got == []
