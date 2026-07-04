"""Cursor pagination.

Every list endpoint returns ``{items, nextCursor}`` with an opaque keyset cursor that is null at the end.
``Paginator`` turns that into an iterable of individual items (the common case:
``for endpoint in client.endpoints.list(): ...``), with ``pages()`` for page-at-a-time access and
``collect()`` to materialise everything.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Generic, TypeVar

from ._errors import WebhookUnexpectedResponseError

T = TypeVar("T")


@dataclass
class Page(Generic[T]):
    """One page of a cursor-paginated read."""

    items: list[T]
    next_cursor: str | None


class Paginator(Generic[T]):
    """An iterable view over a cursor-paginated endpoint. Iterating yields individual items across all
    pages; ``fetch_page(cursor)`` is called lazily, one page at a time, following ``next_cursor`` until
    it is ``None``.
    """

    def __init__(self, fetch_page: Callable[[str | None], Page[T]]) -> None:
        self._fetch = fetch_page

    def pages(self) -> Iterator[Page[T]]:
        cursor: str | None = None
        while True:
            page = self._fetch(cursor)
            yield page
            if page.next_cursor is None:
                return
            # Defensive: a keyset cursor must strictly advance. If the server hands back the same cursor
            # we just sent, following it would loop forever — surface that instead.
            if page.next_cursor == cursor:
                raise WebhookUnexpectedResponseError(
                    "pagination cursor did not advance"
                )
            cursor = page.next_cursor

    def __iter__(self) -> Iterator[T]:
        for page in self.pages():
            yield from page.items

    def collect(self) -> list[T]:
        """Materialise every item across all pages into a list. Beware unbounded result sets."""
        return list(self)
