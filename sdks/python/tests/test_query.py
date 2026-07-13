from webhook_co._query import with_query


class TestWithQuery:
    def test_no_params_returns_path(self):
        assert with_query("/v1/endpoints", {}) == "/v1/endpoints"
        assert (
            with_query("/v1/endpoints", {"cursor": None, "limit": None})
            == "/v1/endpoints"
        )

    def test_string_and_int_params(self):
        assert (
            with_query("/v1/endpoints", {"name": "prod", "limit": 50})
            == "/v1/endpoints?name=prod&limit=50"
        )

    def test_repeats_list_values(self):
        assert (
            with_query("/v1/deliveries", {"status": ["failed", "pending"]})
            == "/v1/deliveries?status=failed&status=pending"
        )

    def test_omits_empty_list(self):
        assert (
            with_query("/v1/deliveries", {"status": [], "destinationId": "d1"})
            == "/v1/deliveries?destinationId=d1"
        )

    def test_url_encodes_reserved_chars(self):
        assert (
            with_query("/v1/endpoints", {"name": "a b&c"})
            == "/v1/endpoints?name=a+b%26c"
        )


class TestBooleans:
    """The API's boolParam accepts ONLY "true"/"1"/"false"/"0" — anything else is silently IGNORED and the
    server default applies. Python's str(False) is "False", so a naive builder would send a value the server
    drops on the floor: a caller asking includeBody=False for summary-only would silently get FULL bodies.
    No error, just the wrong behaviour and a payload fetch per event."""

    def test_booleans_serialise_lowercase(self):
        assert (
            with_query("/v1/triggers/t1/wait", {"includeBody": True})
            == "/v1/triggers/t1/wait?includeBody=true"
        )
        assert (
            with_query("/v1/triggers/t1/wait", {"includeBody": False})
            == "/v1/triggers/t1/wait?includeBody=false"
        )

    def test_none_omits(self):
        # A caught-up triggers.wait returns nextCursor=None; the contract makes the cursor input nullable so
        # that value round-trips straight back in.
        assert (
            with_query("/v1/triggers/t1/wait", {"cursor": None})
            == "/v1/triggers/t1/wait"
        )
