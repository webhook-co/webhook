"""The SDK's typed error surface.

Every failure a caller can catch is a :class:`WebhookError`; the subclasses let callers narrow with
``except`` without string-matching a code. The taxonomy mirrors the API's three error representations (a
JSON ``{error,message}`` envelope, an empty-body 401/403, and a text/plain router miss) — the HTTP core
resolves those into one of these before raising.
"""

from __future__ import annotations

from typing import Literal

WebhookErrorCode = Literal[
    "VALIDATION_ERROR",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "ENDPOINT_PAUSED",
    "RATE_LIMITED",
    "TARGET_UNREACHABLE",
]

_STATUS_TO_CODE: dict[int, WebhookErrorCode] = {
    400: "VALIDATION_ERROR",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    409: "ENDPOINT_PAUSED",
    429: "RATE_LIMITED",
    502: "TARGET_UNREACHABLE",
}

#: A concise default message per code, used when the server sends no ``message`` (e.g. an empty-body 401).
DEFAULT_MESSAGE: dict[WebhookErrorCode, str] = {
    "UNAUTHORIZED": "authentication failed — the API key is invalid, expired, or revoked",
    "FORBIDDEN": "the API key is missing a required scope for this action",
    "NOT_FOUND": "the requested resource was not found",
    "VALIDATION_ERROR": "the request was rejected as invalid",
    "RATE_LIMITED": "rate limited — retry after a short delay",
    "ENDPOINT_PAUSED": "the endpoint is paused",
    "TARGET_UNREACHABLE": "the delivery target was unreachable",
}


def code_for_status(status: int) -> WebhookErrorCode | None:
    """Resolve the capability code for an HTTP status, or ``None`` when the status isn't modelled."""
    return _STATUS_TO_CODE.get(status)


class WebhookError(Exception):
    """Base class for every error the SDK raises. Catch this to handle any SDK failure uniformly."""

    def __init__(
        self,
        message: str,
        *,
        code: WebhookErrorCode | None = None,
        status: int | None = None,
        request_id: str | None = None,
        retry_after_s: float | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status
        self.request_id = request_id
        self.retry_after_s = retry_after_s


class WebhookConfigError(WebhookError):
    """The SDK was constructed with invalid options (e.g. a plaintext base URL). Raised eagerly."""


class WebhookConnectionError(WebhookError):
    """The request never reached the server (DNS/TLS/connection failure or a client-side timeout)."""


class WebhookAPIError(WebhookError):
    """The server returned an HTTP error response. Always carries a ``status``."""


class WebhookAuthenticationError(WebhookAPIError):
    """401 — the credential is invalid, expired, or revoked."""


class WebhookPermissionError(WebhookAPIError):
    """403 — the credential lacks a scope required for the action."""


class WebhookNotFoundError(WebhookAPIError):
    """404 — the resource does not exist (or is not visible to this org)."""


class WebhookInvalidRequestError(WebhookAPIError):
    """400 — the request was structurally or semantically invalid."""


class WebhookConflictError(WebhookAPIError):
    """409 — the endpoint is paused (a conflicting state)."""


class WebhookRateLimitError(WebhookAPIError):
    """429 — rate limited; inspect ``retry_after_s``."""


class WebhookTargetUnreachableError(WebhookAPIError):
    """502 — the downstream delivery target was unreachable."""


class WebhookUnexpectedResponseError(WebhookError):
    """A response the SDK can't interpret: an unmodelled error status, or a body that failed validation."""


_CODE_TO_CLASS: dict[WebhookErrorCode, type[WebhookAPIError]] = {
    "VALIDATION_ERROR": WebhookInvalidRequestError,
    "UNAUTHORIZED": WebhookAuthenticationError,
    "FORBIDDEN": WebhookPermissionError,
    "NOT_FOUND": WebhookNotFoundError,
    "ENDPOINT_PAUSED": WebhookConflictError,
    "RATE_LIMITED": WebhookRateLimitError,
    "TARGET_UNREACHABLE": WebhookTargetUnreachableError,
}


def error_from_response(
    *,
    status: int,
    code: WebhookErrorCode | None = None,
    message: str | None = None,
    request_id: str | None = None,
    retry_after_s: float | None = None,
) -> WebhookError:
    """Build the typed error for a failed response (message/code already redacted by the caller).

    A body code (when present) wins over the status-derived code; a modelled code selects its subclass;
    anything unmodelled becomes an unexpected-response error.
    """
    resolved = code or code_for_status(status)
    if resolved is not None:
        cls = _CODE_TO_CLASS[resolved]
        return cls(
            message or DEFAULT_MESSAGE[resolved],
            code=resolved,
            status=status,
            request_id=request_id,
            retry_after_s=retry_after_s,
        )
    return WebhookUnexpectedResponseError(
        message or f"the API returned an unexpected response (HTTP {status})",
        status=status,
        request_id=request_id,
        retry_after_s=retry_after_s,
    )


def error_from_transport(base_url: str) -> WebhookConnectionError:
    """Build a connection error for a transport failure. The cause is omitted so no raw string can leak."""
    return WebhookConnectionError(f"could not reach the API at {base_url}")
