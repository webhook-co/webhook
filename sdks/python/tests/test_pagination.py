import pytest

from webhook_co._errors import WebhookUnexpectedResponseError
from webhook_co._pagination import Page, Paginator


def source(pages):
    cursors = []

    def fetch(cursor):
        cursors.append(cursor)
        return pages[len(cursors) - 1]

    return fetch, cursors


class TestPaginator:
    def test_iterates_items_across_pages(self):
        fetch, _ = source([Page([1, 2], "c1"), Page([3, 4], None)])
        assert list(Paginator(fetch)) == [1, 2, 3, 4]

    def test_passes_cursor_into_next_fetch(self):
        fetch, cursors = source([Page([1], "c1"), Page([2], None)])
        list(Paginator(fetch))
        assert cursors == [None, "c1"]

    def test_single_page(self):
        fetch, _ = source([Page([7, 8, 9], None)])
        assert list(Paginator(fetch)) == [7, 8, 9]

    def test_empty_result(self):
        fetch, _ = source([Page([], None)])
        assert list(Paginator(fetch)) == []

    def test_pages_yields_whole_pages(self):
        pages = [Page([1], "c1"), Page([2], None)]
        fetch, _ = source(pages)
        assert list(Paginator(fetch).pages()) == pages

    def test_collect(self):
        fetch, _ = source([Page([1, 2], "c1"), Page([3], None)])
        assert Paginator(fetch).collect() == [1, 2, 3]

    def test_stops_with_error_if_cursor_does_not_advance(self):
        def fetch(_cursor):
            return Page([1], "stuck")

        with pytest.raises(WebhookUnexpectedResponseError):
            list(Paginator(fetch))
