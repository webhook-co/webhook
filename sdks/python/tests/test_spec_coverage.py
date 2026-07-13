"""The SDK route-coverage RATCHET (Python) — the twin of packages/sdk-ts/src/spec-coverage.test.ts.

Every route in the OpenAPI spec MUST be reachable from a public SDK method, or be listed in EXEMPTIONS with
a reason. This exists because NOTHING enforced SDK coverage: ``endpoints.revealIngestUrl`` shipped on the
api, cli and mcp surfaces, but no SDK ever got a method — so "the ingest URL is re-readable" stayed
accidentally FALSE for SDK users, and the stale "capture it now" docs stayed accidentally TRUE. The
contract's parity.test.ts only covers SURFACES = api|cli|mcp|web; the SDKs are not surfaces.

Coverage is EXECUTABLE, not declared: each covered route maps to a thunk that actually CALLS the SDK method
against a mock transport, and the test asserts the request really landed on that route with that HTTP
method. A hand-kept list of "routes we cover" can lie (add the route, forget the method); a thunk that must
issue the request cannot.

A ratchet, not a snapshot: entries may be DELETED as they are implemented. Adding one needs a reviewed
reason — and a new spec route with neither a thunk nor an exemption fails CI.
"""

from __future__ import annotations

import json
import pathlib
import re
from typing import Any, Callable

import httpx
import pytest

import webhook_co as w
from tests.test_client import (
    _added_secret,
    _deleted_endpoint,
    _delivery,
    _delivery_attempt,
    _endpoint,
    _event,
    _provider_secret,
    _replay_destination,
    _signing_secret_meta,
    _subscription,
)

SPEC = (
    pathlib.Path(__file__).resolve().parents[3]
    / "packages"
    / "openapi"
    / "src"
    / "openapi.json"
)

_METHODS = {"get", "post", "put", "patch", "delete"}

# Routes with no SDK method yet. DELETE an entry as you implement it — never add one without a reason.
# EMPTY: the Python SDK now reaches every route in the spec.
EXEMPTIONS: dict[str, str] = {}

ID = "11111111-1111-4111-8111-111111111111"

_PAGE: dict[str, Any] = {"items": [], "nextCursor": None}
_ITEMS: dict[str, Any] = {"items": []}
_USAGE: dict[str, Any] = {
    "periodStart": "2026-07-01T00:00:00Z",
    "periodEnd": None,
    "capKind": "lifetime",
    "events": 0,
    "eventCap": 5000,
    "pausePolicy": "pause",
    "paused": False,
}
_TRIGGER: dict[str, Any] = {
    "id": ID,
    "orgId": ID,
    "endpointId": ID,
    "name": None,
    "createdAt": "2026-07-01T00:00:00Z",
    "revokedAt": None,
}
_CREATED_ENDPOINT: dict[str, Any] = {
    **_endpoint(),
    "ingestUrl": "https://wbhk.my/whep_x",
}

# route -> (response body, thunk). The thunk MUST issue exactly one request, to that route.
CALLS: dict[str, tuple[Any, Callable[[w.WebhookClient], Any]]] = {
    "GET /v1/endpoints": (_PAGE, lambda c: c.endpoints.list_page()),
    "POST /v1/endpoints": (_CREATED_ENDPOINT, lambda c: c.endpoints.create(name="n")),
    "GET /v1/endpoints/{endpointId}": (_endpoint(), lambda c: c.endpoints.get(ID)),
    "PATCH /v1/endpoints/{endpointId}": (
        _endpoint(),
        lambda c: c.endpoints.update(ID, dedup_config=None),
    ),
    "DELETE /v1/endpoints/{endpointId}": (
        _deleted_endpoint(),
        lambda c: c.endpoints.delete(ID),
    ),
    "POST /v1/endpoints/{endpointId}/rotate": (
        _CREATED_ENDPOINT,
        lambda c: c.endpoints.rotate(ID),
    ),
    "POST /v1/endpoints/{endpointId}/reveal-ingest-url": (
        {"ingestUrl": None},
        lambda c: c.endpoints.reveal_ingest_url(ID),
    ),
    "POST /v1/endpoints/{endpointId}/provider-secrets": (
        _added_secret(),
        lambda c: c.endpoints.provider_secrets.add(
            endpoint_id=ID, provider="stripe", secret="s"
        ),
    ),
    "GET /v1/endpoints/{endpointId}/provider-secrets": (
        {"items": [_provider_secret()]},
        lambda c: c.endpoints.provider_secrets.list(ID),
    ),
    "DELETE /v1/endpoints/{endpointId}/provider-secrets/{secretId}": (
        {"id": ID, "revokedAt": "2026-07-01T00:00:00Z"},
        lambda c: c.endpoints.provider_secrets.revoke(endpoint_id=ID, secret_id=ID),
    ),
    "GET /v1/endpoints/{endpointId}/events": (_PAGE, lambda c: c.events.list_page(ID)),
    "GET /v1/endpoints/{endpointId}/events/tail": (
        {
            "items": [],
            "nextCursor": None,
            "headCursor": None,
            "caughtUp": True,
            "lag": {"backlogCount": 0, "headLagMs": None},
        },
        lambda c: c.events.tail(ID),
    ),
    "GET /v1/events/{eventId}": (_event(), lambda c: c.events.get(ID)),
    "GET /v1/events/{eventId}/payload": (
        {
            "bodyBase64": "",
            "contentType": "application/json",
            "bytes": 0,
            "truncated": False,
        },
        lambda c: c.events.get_payload(ID),
    ),
    "DELETE /v1/events/{eventId}": (
        {"id": ID, "deletedAt": "2026-07-01T00:00:00Z"},
        lambda c: c.events.delete(ID),
    ),
    "POST /v1/events/{eventId}/replay": (
        _delivery_attempt(),
        lambda c: c.events.replay(ID, target={"destinationId": ID}),
    ),
    "GET /v1/deliveries": (_PAGE, lambda c: c.deliveries.list_page()),
    "GET /v1/deliveries/{deliveryId}": (_delivery(), lambda c: c.deliveries.get(ID)),
    "POST /v1/replay-destinations": (
        {**_replay_destination(), "signingSecret": "whsec_x"},
        lambda c: c.replay_destinations.create(url="https://ex.test/hook"),
    ),
    "GET /v1/replay-destinations": (
        {"items": [_replay_destination()]},
        lambda c: c.replay_destinations.list(),
    ),
    "DELETE /v1/replay-destinations/{destinationId}": (
        {"id": ID, "deletedAt": "2026-07-01T00:00:00Z"},
        lambda c: c.replay_destinations.delete(ID),
    ),
    "POST /v1/replay-destinations/{destinationId}/enable": (
        _replay_destination(),
        lambda c: c.replay_destinations.enable(ID),
    ),
    "POST /v1/replay-destinations/{destinationId}/ordered": (
        _replay_destination(),
        lambda c: c.replay_destinations.set_ordered(ID, True),
    ),
    "POST /v1/replay-destinations/{destinationId}/signing-secret": (
        {"destinationId": ID, "keyId": ID, "signingSecret": "whsec_x"},
        lambda c: c.replay_destinations.rotate_signing_secret(ID),
    ),
    "GET /v1/replay-destinations/{destinationId}/signing-secrets": (
        {"items": [_signing_secret_meta()]},
        lambda c: c.replay_destinations.list_signing_secrets(ID),
    ),
    "POST /v1/subscriptions": (
        _subscription(),
        lambda c: c.subscriptions.create(source_endpoint_id=ID, destination_id=ID),
    ),
    "GET /v1/subscriptions": (
        {"items": [_subscription()]},
        lambda c: c.subscriptions.list(),
    ),
    "DELETE /v1/subscriptions/{subscriptionId}": (
        {"id": ID, "deletedAt": "2026-07-01T00:00:00Z"},
        lambda c: c.subscriptions.delete(ID),
    ),
    "GET /v1/usage": (_USAGE, lambda c: c.usage.get()),
    "GET /v1/triggers": ({"items": [_TRIGGER]}, lambda c: c.triggers.list()),
    "POST /v1/triggers": (_TRIGGER, lambda c: c.triggers.create(endpoint_id=ID)),
    "DELETE /v1/triggers/{triggerId}": ({"id": ID}, lambda c: c.triggers.revoke(ID)),
    "GET /v1/triggers/{triggerId}/wait": (
        {"events": [], "nextCursor": None, "caughtUp": True},
        lambda c: c.triggers.wait(ID),
    ),
    "POST /v1/audit/verify": (
        {"ok": True, "rowsVerified": 3},
        lambda c: c.audit.verify(),
    ),
    "GET /v1/whoami": (
        {"orgId": ID, "userId": None, "scopes": []},
        lambda c: c.whoami(),
    ),
}


def _spec_routes() -> set[str]:
    spec = json.loads(SPEC.read_text())
    return {
        f"{method.upper()} {path}"
        for path, item in spec["paths"].items()
        for method in item
        if method in _METHODS
    }


def _template_to_regex(path: str) -> re.Pattern[str]:
    """`/v1/endpoints/{endpointId}/rotate` -> ^/v1/endpoints/[^/]+/rotate$"""
    return re.compile(
        "^"
        + re.sub(
            r"\{[^}]+\}",
            "[^/]+",
            re.escape(path).replace("\\{", "{").replace("\\}", "}"),
        )
        + "$"
    )


def _client(body: Any) -> tuple[w.WebhookClient, list[httpx.Request]]:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(
            200, json=body, headers={"content-type": "application/json"}
        )

    client = w.WebhookClient(
        api_key="whk_spec_coverage_key_abcdefgh",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        sleep=lambda _s: None,
        rand=lambda: 0.0,
    )
    return client, calls


def test_every_spec_route_has_a_method_or_a_reasoned_exemption():
    uncovered = _spec_routes() - set(CALLS) - set(EXEMPTIONS)
    assert (
        not uncovered
    ), f"spec routes with no SDK method and no exemption: {sorted(uncovered)}"


def test_no_entry_names_a_route_absent_from_the_spec():
    """Vacuity guard: a stale entry could hide a real gap."""
    stale = (set(CALLS) | set(EXEMPTIONS)) - _spec_routes()
    assert not stale, f"entries naming routes absent from the spec: {sorted(stale)}"


def test_no_route_is_both_covered_and_exempted():
    """An exemption for a route we DO cover MASKS the coverage check for it — deleting the method would not
    fail this suite. An exemption must mean "no method exists", nothing else."""
    both = sorted(set(CALLS) & set(EXEMPTIONS))
    assert (
        not both
    ), f"routes exempted despite having an SDK method — delete the exemption: {both}"


def test_every_exemption_carries_a_reason():
    blank = [route for route, reason in EXEMPTIONS.items() if not reason.strip()]
    assert not blank, f"exemptions with no reason: {blank}"


@pytest.mark.parametrize("route", sorted(CALLS))
def test_covered_route_is_really_reached_by_its_method(route: str):
    """The teeth: claimed coverage must be REAL — each thunk has to issue the request it claims."""
    method, path = route.split(" ", 1)
    body, call = CALLS[route]
    client, calls = _client(body)
    call(client)
    assert len(calls) == 1, f"{route}: expected exactly one request, got {len(calls)}"
    assert calls[0].method == method
    assert _template_to_regex(path).match(
        calls[0].url.path
    ), f"{route}: request went to {calls[0].url.path}"
