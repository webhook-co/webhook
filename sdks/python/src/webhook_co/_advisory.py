"""CLIENT VERSION ADVISORIES (receiving end) + the versioned User-Agent.

The SDK identifies itself in its User-Agent; when this version is behind, the API answers with an
``x-webhook-advisory`` header ON A RESPONSE THE CALLER ALREADY ASKED FOR. So the SDK never polls PyPI,
never makes an unsolicited network call from inside your Lambda, and works fine offline — you simply hear
nothing.

House rules for surfacing it, because a library that nags is a library people vendor to shut it up:
  - report ONCE per client, not once per request;
  - prefer the caller's own handler; only fall back to a single ``warnings`` emission;
  - be silenceable, and never break a request if any of this goes wrong.
"""

from __future__ import annotations

import platform
import re
import sys
import warnings
from dataclasses import dataclass
from typing import Callable

ADVISORY_HEADER = "x-webhook-advisory"
DEPRECATION_HEADER = "deprecation"


def _sdk_version() -> str:
    """The installed version, read from package metadata.

    Unlike the TS and Go SDKs, Python does not need a stamped constant: the wheel's own metadata IS the
    version, so the User-Agent physically cannot disagree with what is installed. Falls back to 0.0.0 when
    running from a source tree with no metadata (a dev checkout).
    """
    try:
        from importlib.metadata import version

        return version("webhook-co")
    except (
        Exception
    ):  # pragma: no cover - defensive: never let identifying ourselves break a request
        return "0.0.0"


SDK_VERSION = _sdk_version()


def user_agent() -> str:
    """``webhook-co-python/0.2.1 (python/3.12.3; darwin)`` — client, version, runtime. Nothing about you."""
    try:
        py = platform.python_version()
        os_name = sys.platform
        return f"webhook-co-python/{SDK_VERSION} (python/{py}; {os_name})"
    except Exception:  # pragma: no cover
        return f"webhook-co-python/{SDK_VERSION}"


@dataclass(frozen=True)
class WebhookAdvisory:
    """A version advisory from the server. ``deprecated`` = BELOW the supported floor: broken, not just old."""

    deprecated: bool
    current: str
    latest: str
    message: str


_KIND = re.compile(
    r"^(update-available|deprecated);\s*current=([\w.+-]+);\s*latest=([\w.+-]+)$"
)


def parse_advisory(
    header: str | None, deprecation: str | None
) -> WebhookAdvisory | None:
    """Parse the advisory header. Returns None for absent OR malformed input.

    The server is not this SDK's parser: a garbled or hostile header must never raise inside a caller's
    request path. The worst it can do is say nothing.
    """
    if not header:
        return None
    m = _KIND.match(header.strip())
    if not m:
        return None
    kind, current, latest = m.group(1), m.group(2), m.group(3)
    deprecated = kind == "deprecated" or deprecation == "true"
    if deprecated:
        message = (
            f"webhook.co: this SDK version ({current}) is no longer supported and may misbehave. "
            f"Upgrade to {latest}: pip install --upgrade webhook-co"
        )
    else:
        message = (
            f"webhook.co: a newer SDK is available ({current} -> {latest}). "
            f"Upgrade with: pip install --upgrade webhook-co"
        )
    return WebhookAdvisory(
        deprecated=deprecated, current=current, latest=latest, message=message
    )


def make_advisory_reporter(
    on_advisory: Callable[[WebhookAdvisory], None] | None = None,
    *,
    silent: bool = False,
    warn: Callable[[str], None] | None = None,
) -> Callable[[str | None, str | None], None]:
    """Build the per-client reporter: fires AT MOST ONCE, swallows a caller handler's exception.

    A per-request nag would be a bug, not a feature. And if the caller's handler raises, that is their bug —
    it must not surface as a failed API call.
    """
    state = {"reported": False}
    emit = warn or (lambda message: warnings.warn(message, UserWarning, stacklevel=2))

    def report(header: str | None, deprecation: str | None) -> None:
        if state["reported"] or silent:
            return
        advisory = parse_advisory(header, deprecation)
        if advisory is None:
            return
        state["reported"] = True
        try:
            if on_advisory is not None:
                on_advisory(advisory)
            else:
                emit(advisory.message)
        except (
            Exception
        ):  # noqa: BLE001 - the caller's logging bug must not fail their request
            pass

    return report
