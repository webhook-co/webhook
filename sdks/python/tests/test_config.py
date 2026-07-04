import pytest

from webhook_co._config import DEFAULT_BASE_URL, resolve_base_url
from webhook_co._errors import WebhookConfigError


class TestResolveBaseUrl:
    def test_defaults_to_hosted_api(self) -> None:
        assert DEFAULT_BASE_URL == "https://api.webhook.co"
        assert resolve_base_url(None) == "https://api.webhook.co"

    def test_strips_trailing_slash(self) -> None:
        assert resolve_base_url("https://api.webhook.co/") == "https://api.webhook.co"

    def test_preserves_base_path(self) -> None:
        assert (
            resolve_base_url("https://example.test/api/") == "https://example.test/api"
        )

    def test_allows_loopback_http(self) -> None:
        assert resolve_base_url("http://localhost:8787") == "http://localhost:8787"
        assert resolve_base_url("http://127.0.0.1:8787") == "http://127.0.0.1:8787"

    def test_rejects_plaintext_non_loopback(self) -> None:
        with pytest.raises(WebhookConfigError):
            resolve_base_url("http://api.webhook.co")

    def test_rejects_query_or_fragment(self) -> None:
        with pytest.raises(WebhookConfigError):
            resolve_base_url("https://api.webhook.co?x=1")
        with pytest.raises(WebhookConfigError):
            resolve_base_url("https://api.webhook.co#frag")

    def test_rejects_unparseable(self) -> None:
        with pytest.raises(WebhookConfigError):
            resolve_base_url("not a url")
