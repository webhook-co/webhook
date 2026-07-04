from webhook_co._errors import (
    DEFAULT_MESSAGE,
    WebhookAPIError,
    WebhookAuthenticationError,
    WebhookConflictError,
    WebhookConnectionError,
    WebhookError,
    WebhookInvalidRequestError,
    WebhookNotFoundError,
    WebhookPermissionError,
    WebhookRateLimitError,
    WebhookTargetUnreachableError,
    WebhookUnexpectedResponseError,
    code_for_status,
    error_from_response,
    error_from_transport,
)

_CASES = [
    (400, WebhookInvalidRequestError, "VALIDATION_ERROR"),
    (401, WebhookAuthenticationError, "UNAUTHORIZED"),
    (403, WebhookPermissionError, "FORBIDDEN"),
    (404, WebhookNotFoundError, "NOT_FOUND"),
    (409, WebhookConflictError, "ENDPOINT_PAUSED"),
    (429, WebhookRateLimitError, "RATE_LIMITED"),
    (502, WebhookTargetUnreachableError, "TARGET_UNREACHABLE"),
]


class TestCodeForStatus:
    def test_maps_modelled_statuses(self) -> None:
        for status, _cls, code in _CASES:
            assert code_for_status(status) == code

    def test_unmodelled_status_is_none(self) -> None:
        assert code_for_status(500) is None
        assert code_for_status(418) is None


class TestErrorFromResponse:
    def test_selects_subclass_with_code_and_status(self) -> None:
        for status, cls, code in _CASES:
            err = error_from_response(status=status)
            assert isinstance(err, cls)
            assert isinstance(err, WebhookAPIError)
            assert isinstance(err, WebhookError)
            assert err.code == code
            assert err.status == status
            assert err.message == DEFAULT_MESSAGE[code]

    def test_prefers_server_message(self) -> None:
        err = error_from_response(status=400, message="endpoint name is required")
        assert err.message == "endpoint name is required"
        assert err.code == "VALIDATION_ERROR"

    def test_threads_request_id_and_retry_after(self) -> None:
        err = error_from_response(status=429, request_id="req_abc", retry_after_s=5.0)
        assert isinstance(err, WebhookRateLimitError)
        assert err.retry_after_s == 5.0
        assert err.request_id == "req_abc"

    def test_prefers_explicit_body_code(self) -> None:
        err = error_from_response(status=400, code="NOT_FOUND")
        assert isinstance(err, WebhookNotFoundError)
        assert err.code == "NOT_FOUND"
        assert err.status == 400

    def test_unmodelled_status_is_unexpected(self) -> None:
        err = error_from_response(status=500)
        assert isinstance(err, WebhookUnexpectedResponseError)
        assert err.status == 500
        assert err.code is None


class TestErrorFromTransport:
    def test_connection_error_names_base_url(self) -> None:
        err = error_from_transport("https://api.webhook.co")
        assert isinstance(err, WebhookConnectionError)
        assert err.status is None
        assert err.code is None
        assert "https://api.webhook.co" in err.message
