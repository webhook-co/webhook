import pytest

from webhook_co._retry import (
    BACKOFF_BASE_S,
    BACKOFF_CAP_S,
    RETRY_AFTER_CAP_S,
    backoff_seconds,
    is_retryable_status,
    parse_retry_after,
)


class TestBackoffSeconds:
    def test_half_the_capped_delay_with_zero_jitter(self) -> None:
        assert backoff_seconds(1, lambda: 0.0) == pytest.approx(BACKOFF_BASE_S / 2)

    def test_full_capped_delay_with_max_jitter(self) -> None:
        assert backoff_seconds(1, lambda: 1.0) == pytest.approx(BACKOFF_BASE_S)

    def test_grows_exponentially(self) -> None:
        assert backoff_seconds(2, lambda: 0.0) == pytest.approx(BACKOFF_BASE_S)

    def test_never_exceeds_the_cap(self) -> None:
        assert backoff_seconds(50, lambda: 1.0) == pytest.approx(BACKOFF_CAP_S)
        assert backoff_seconds(50, lambda: 0.0) == pytest.approx(BACKOFF_CAP_S / 2)


class TestIsRetryableStatus:
    def test_transient_statuses_are_retryable(self) -> None:
        assert all(is_retryable_status(s) for s in (429, 502, 503, 504))

    def test_terminal_statuses_are_not_retryable(self) -> None:
        assert not any(
            is_retryable_status(s) for s in (200, 400, 401, 403, 404, 409, 500)
        )


class TestParseRetryAfter:
    def test_parses_delta_seconds(self) -> None:
        assert parse_retry_after("5") == 5.0
        assert parse_retry_after("0") == 0.0

    def test_trims_whitespace(self) -> None:
        assert parse_retry_after("  3  ") == 3.0

    def test_clamps_oversized_value(self) -> None:
        assert parse_retry_after("99999") == RETRY_AFTER_CAP_S

    def test_returns_none_for_invalid(self) -> None:
        assert parse_retry_after(None) is None
        assert parse_retry_after("soon") is None
        assert parse_retry_after("-1") is None
        assert parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT") is None

    def test_returns_none_for_unicode_numerics_that_float_rejects(self) -> None:
        # str.isdigit() is True for these but float() raises — must NOT crash the retry path.
        assert parse_retry_after("²") is None
        assert parse_retry_after("①") is None
        assert parse_retry_after("1²") is None
