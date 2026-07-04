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
