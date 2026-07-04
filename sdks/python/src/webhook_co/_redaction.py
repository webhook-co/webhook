"""Secret redaction.

The SDK holds a bearer credential; a leaked key in an error message or a debug line is a
credential-disclosure bug. Every string that could reach a human is passed through a redactor. Two
layers: (1) exact — replace the caller's registered secret(s) verbatim (covers a self-host key of any
shape); (2) structural — a backstop that redacts platform tokens (``whk_``/``whsec_``) and ``Bearer``
credentials even when the exact value was not registered (e.g. a token echoed back by the server).
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable

#: The placeholder a redacted secret collapses to.
REDACTED = "[redacted]"

# Below this length a "secret" is too short to be a real credential; redacting it risks nuking ordinary
# output. Registered secrets shorter than this are ignored by the exact layer.
_MIN_REDACTABLE_LENGTH = 6

_WELL_KNOWN_TOKEN = re.compile(r"(whk|whsec)_[A-Za-z0-9_-]{4,}")
_BEARER = re.compile(r"Bearer\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE)


def redact_well_known_secrets(text: str) -> str:
    """Redact platform tokens + Bearer credentials from arbitrary text (a structural backstop)."""
    text = _WELL_KNOWN_TOKEN.sub(REDACTED, text)
    return _BEARER.sub(f"Bearer {REDACTED}", text)


def make_redactor(secrets: Iterable[str]) -> Callable[[str], str]:
    """Build a redactor bound to the caller's known secret(s).

    Each registered secret is replaced verbatim (``str.replace``, so a secret with regex-special
    characters is treated literally), then the structural backstop is applied. Secrets shorter than
    ``_MIN_REDACTABLE_LENGTH`` are ignored.
    """
    known = list({s for s in secrets if len(s) >= _MIN_REDACTABLE_LENGTH})

    def redact(text: str) -> str:
        for secret in known:
            text = text.replace(secret, REDACTED)
        return redact_well_known_secrets(text)

    return redact
