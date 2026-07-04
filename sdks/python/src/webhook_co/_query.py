"""Query-string construction shared by the list endpoints. Absent keys are omitted (never sent as empty);
a list value rides as a REPEATED param (``?provider=a&provider=b``) — the multi-select shape the API reads
back — and an empty list contributes nothing.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlencode


def with_query(path: str, params: dict[str, Any]) -> str:
    pairs: list[tuple[str, str]] = []
    for key, value in params.items():
        if value is None:
            continue
        if isinstance(value, (list, tuple)):
            pairs.extend((key, str(v)) for v in value)
        else:
            pairs.append((key, str(value)))
    if not pairs:
        return path
    return f"{path}?{urlencode(pairs)}"
