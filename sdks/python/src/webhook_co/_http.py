"""The HTTP core: one hardened request path shared by every SDK method.

It injects the bearer, bounds each request with a wall-clock timeout, retries only IDEMPOTENT requests on
transient failures (jittered backoff, honouring ``Retry-After``), performs a single reactive bearer
refresh on a 401, and resolves every non-2xx response — a JSON ``{error,message}`` envelope, an empty-body
401/403, or a text/plain router miss — into a typed error. Every human-facing string is redacted first.
Redirects are never followed (the ``httpx.Client`` is built with ``follow_redirects=False``), so the
Authorization header can't be replayed cross-origin.
"""

from __future__ import annotations

import json
import random
import time
from collections.abc import Callable
from typing import Any

import httpx

from ._errors import (
    WebhookErrorCode,
    WebhookUnexpectedResponseError,
    error_from_response,
    error_from_transport,
)
from ._redaction import make_redactor
from ._retry import (
    DEFAULT_MAX_RETRIES,
    backoff_seconds,
    is_retryable_status,
    parse_retry_after,
)

_WEBHOOK_ERROR_CODES: frozenset[str] = frozenset(
    {
        "VALIDATION_ERROR",
        "UNAUTHORIZED",
        "FORBIDDEN",
        "NOT_FOUND",
        "ENDPOINT_PAUSED",
        "RATE_LIMITED",
        "TARGET_UNREACHABLE",
    }
)


def _as_error_code(value: object) -> WebhookErrorCode | None:
    if isinstance(value, str) and value in _WEBHOOK_ERROR_CODES:
        return value  # type: ignore[return-value]
    return None


class HttpClient:
    """The hardened request path. The ``httpx.Client`` is injected (a real one in production; a
    ``MockTransport`` client in tests), as are the sleep + jitter sources (instant/deterministic in tests).
    """

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        http_client: httpx.Client,
        max_retries: int | None = None,
        timeout_s: float | None = None,
        refresh_auth: Callable[[], str | None] | None = None,
        on_debug: Callable[[str], None] | None = None,
        sleep: Callable[[float], None] | None = None,
        rand: Callable[[], float] | None = None,
    ) -> None:
        self._base_url = base_url
        self._api_key = api_key
        self._client = http_client
        self._max_retries = DEFAULT_MAX_RETRIES if max_retries is None else max_retries
        self._timeout_s = timeout_s
        self._refresh_auth = refresh_auth
        self._on_debug = on_debug
        self._sleep = sleep or time.sleep
        self._rand = rand or random.random

    def request(
        self,
        method: str,
        path: str,
        *,
        body: Any | None = None,
        idempotent: bool,
    ) -> Any:
        # The live bearer — replaced when the refresh hook hands back a rotated token. A 401 refresh+retry
        # is safe for ANY method (a 401 means the request was rejected, never processed); it fires at most
        # once. Redaction is owned here so a rotated token is added to the secret set (a non-whk_ token
        # would otherwise slip the structural backstop).
        bearer = self._api_key
        refreshed = False
        secrets = [self._api_key]
        redact = make_redactor(secrets)

        def debug(line: str) -> None:
            if self._on_debug is not None:
                self._on_debug(redact(line))

        attempt = 0
        while True:
            is_last = attempt >= self._max_retries
            debug(f"{method} {path} attempt={attempt + 1}")

            headers = {
                "authorization": f"Bearer {bearer}",
                "accept": "application/json",
            }
            content: bytes | None = None
            if body is not None:
                headers["content-type"] = "application/json"
                content = json.dumps(body).encode("utf-8")

            try:
                # follow_redirects=False per-request hard-enforces no redirect following even if a caller
                # passed an httpx.Client that opts into it — so the Authorization header can never be
                # replayed to a server-chosen (cross-origin) redirect target.
                kwargs: dict[str, Any] = {
                    "headers": headers,
                    "content": content,
                    "follow_redirects": False,
                }
                if self._timeout_s is not None:
                    kwargs["timeout"] = self._timeout_s
                res = self._client.request(method, f"{self._base_url}{path}", **kwargs)
            except httpx.TransportError:
                # A transport failure (DNS/TLS/connection) or a timeout. The cause is dropped so a raw
                # error string can't carry anything sensitive into output.
                if idempotent and not is_last:
                    delay = backoff_seconds(attempt + 1, self._rand)
                    debug(f"transport failure; retrying in {delay:.3f}s")
                    self._sleep(delay)
                    attempt += 1
                    continue
                raise error_from_transport(self._base_url) from None

            if res.is_success:
                return self._parse_success(res)

            # A 401 → one silent refresh + retry. The refreshed retry is a fresh request, not a spent
            # attempt, so the attempt counter is not advanced.
            if (
                res.status_code == 401
                and self._refresh_auth is not None
                and not refreshed
            ):
                refreshed = True
                nxt = self._refresh_auth()
                if nxt is not None:
                    bearer = nxt
                    secrets.append(nxt)
                    redact = make_redactor(secrets)
                    debug("refreshed bearer; retrying")
                    continue

            if idempotent and not is_last and is_retryable_status(res.status_code):
                delay = parse_retry_after(res.headers.get("retry-after"))
                if delay is None:
                    delay = backoff_seconds(attempt + 1, self._rand)
                debug(f"transient {res.status_code}; retrying in {delay:.3f}s")
                self._sleep(delay)
                attempt += 1
                continue

            self._raise_response_error(res, redact)

    def _parse_success(self, res: httpx.Response) -> Any:
        try:
            return res.json()
        except (ValueError, json.JSONDecodeError) as exc:
            raise WebhookUnexpectedResponseError(
                "the API returned a malformed JSON response", status=res.status_code
            ) from exc

    def _raise_response_error(
        self, res: httpx.Response, redact: Callable[[str], str]
    ) -> None:
        status = res.status_code
        request_id = res.headers.get("x-request-id")
        retry_after_s = (
            parse_retry_after(res.headers.get("retry-after")) if status == 429 else None
        )
        content_type = res.headers.get("content-type", "")

        code: WebhookErrorCode | None = None
        message: str | None = None
        if "application/json" in content_type:
            try:
                body = res.json()
            except (ValueError, json.JSONDecodeError):
                body = None
            if isinstance(body, dict):
                code = _as_error_code(body.get("error"))
                raw_message = body.get("message")
                if isinstance(raw_message, str):
                    message = redact(raw_message)
        else:
            text = res.text.strip()
            if text:
                message = redact(text)

        raise error_from_response(
            status=status,
            code=code,
            message=message,
            request_id=request_id,
            retry_after_s=retry_after_s,
        )
