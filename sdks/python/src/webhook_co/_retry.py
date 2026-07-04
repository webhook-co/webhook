"""Retry/backoff primitives — pure and injectable (the jitter source is a parameter) so callers are
tested with no real timers. Delays are in SECONDS (``time.sleep`` / httpx units). The HTTP core decides
WHICH requests are retry-safe (idempotency gating); this module owns only the timing math + classification.
"""

from __future__ import annotations

import random
import re
from collections.abc import Callable

# ASCII digits only. `str.isdigit()` also matches Unicode numerics (superscripts, circled digits) that
# `float()` cannot parse — a server-controlled `Retry-After` of e.g. "²" would otherwise crash the client.
_DELTA_SECONDS = re.compile(r"[0-9]+")

#: Retries AFTER the first attempt (so 3 total attempts). Overridable per client.
DEFAULT_MAX_RETRIES = 2
#: Default per-request timeout in seconds, applied to each httpx phase (connect/read/write/pool). A phase
#: exceeding it aborts the request (and, if idempotent, retries). Not a single total-wall-clock deadline.
DEFAULT_TIMEOUT_S = 30.0
#: Backoff base in seconds (the first retry wait grows from here).
BACKOFF_BASE_S = 0.5
#: Backoff ceiling in seconds — a read never waits longer than this between retries.
BACKOFF_CAP_S = 8.0
#: Upper bound on an honoured ``Retry-After``, so a hostile/oversized value can't hang the client.
RETRY_AFTER_CAP_S = 60.0

_RETRYABLE_STATUS = frozenset({429, 502, 503, 504})


def backoff_seconds(
    attempt: int,
    rand: Callable[[], float] = random.random,
    base: float = BACKOFF_BASE_S,
    cap: float = BACKOFF_CAP_S,
) -> float:
    """Capped exponential backoff with jitter (``attempt`` is 1-based): half the capped delay is fixed
    and half is random, so concurrent clients don't synchronise yet never wait below half the cap.
    """
    capped = min(cap, base * 2 ** max(0, attempt - 1))
    return capped / 2 + rand() * (capped / 2)


def is_retryable_status(status: int) -> bool:
    """Whether an HTTP status is a transient failure (throttle / gateway / unavailable / timeout).

    A 500 is deliberately NOT retryable — it usually signals a deterministic server fault a blind retry
    won't cure, and retrying a non-idempotent write on a 500 risks a duplicate.
    """
    return status in _RETRYABLE_STATUS


def parse_retry_after(value: str | None) -> float | None:
    """Parse a ``Retry-After`` header to a delay in seconds. Only the delta-seconds form is honoured;
    an HTTP-date, absent, negative, or non-numeric value returns ``None`` so the caller falls back to
    ``backoff_seconds``. The result is clamped to ``RETRY_AFTER_CAP_S``.
    """
    if value is None:
        return None
    trimmed = value.strip()
    if not _DELTA_SECONDS.fullmatch(trimmed):
        return None
    return min(RETRY_AFTER_CAP_S, float(trimmed))
