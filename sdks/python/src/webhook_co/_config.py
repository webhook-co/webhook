"""Client configuration resolution.

The base URL is the destination for the bearer credential, so it MUST be https — plaintext http is
rejected except for loopback (local dev / self-host) — otherwise a misconfiguration could downgrade the
key to plaintext or redirect it to a hostile host. The URL must be a clean origin+path (no query/
fragment); the normalised form is returned.
"""

from __future__ import annotations

from urllib.parse import urlsplit

from ._errors import WebhookConfigError

#: The canonical hosted API (mirrors the OpenAPI ``servers`` entry).
DEFAULT_BASE_URL = "https://api.webhook.co"

_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def resolve_base_url(raw: str | None) -> str:
    """Validate + normalise a base URL (defaulting to the hosted API).

    https-only except loopback http; no query/fragment; a trailing slash is stripped so
    ``f"{base}/v1/…"`` concatenation is always well-formed.
    """
    value = raw or DEFAULT_BASE_URL
    parts = urlsplit(value)
    if not parts.scheme or not parts.netloc:
        raise WebhookConfigError(f"invalid base URL: {value}")
    loopback_http_ok = parts.scheme == "http" and parts.hostname in _LOOPBACK_HOSTS
    if parts.scheme != "https" and not loopback_http_ok:
        raise WebhookConfigError(
            f"base URL must be https (got {parts.scheme}://): {value}"
        )
    if parts.query or parts.fragment:
        raise WebhookConfigError(
            f"base URL must not carry a query or fragment: {value}"
        )
    return f"{parts.scheme}://{parts.netloc}{parts.path}".rstrip("/")
