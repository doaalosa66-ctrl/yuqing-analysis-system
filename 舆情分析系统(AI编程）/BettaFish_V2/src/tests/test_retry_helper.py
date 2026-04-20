"""
Unit tests for utils/retry_helper.py
"""

import pytest
import sys
import os
from unittest.mock import patch, MagicMock, call

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from utils.retry_helper import (
    RetryConfig,
    with_retry,
    retry_on_network_error,
    with_graceful_retry,
    make_retryable_request,
    RetryableError,
    DEFAULT_RETRY_CONFIG,
    LLM_RETRY_CONFIG,
    SEARCH_API_RETRY_CONFIG,
    DB_RETRY_CONFIG,
)


class TestRetryConfig:
    def test_default_values(self):
        config = RetryConfig()
        assert config.max_retries == 3
        assert config.initial_delay == 1.0
        assert config.backoff_factor == 2.0
        assert config.max_delay == 60.0

    def test_custom_values(self):
        config = RetryConfig(max_retries=5, initial_delay=2.0, backoff_factor=3.0, max_delay=120.0)
        assert config.max_retries == 5
        assert config.initial_delay == 2.0
        assert config.backoff_factor == 3.0
        assert config.max_delay == 120.0

    def test_default_retry_exceptions_not_none(self):
        config = RetryConfig()
        assert config.retry_on_exceptions is not None
        assert len(config.retry_on_exceptions) > 0

    def test_custom_retry_exceptions(self):
        config = RetryConfig(retry_on_exceptions=(ValueError, TypeError))
        assert ValueError in config.retry_on_exceptions
        assert TypeError in config.retry_on_exceptions

    def test_exception_includes_general_exception(self):
        config = RetryConfig()
        assert Exception in config.retry_on_exceptions


class TestWithRetry:
    def test_success_on_first_attempt(self):
        call_count = 0

        @with_retry(RetryConfig(max_retries=3, initial_delay=0))
        def always_succeeds():
            nonlocal call_count
            call_count += 1
            return "ok"

        with patch("time.sleep"):
            result = always_succeeds()

        assert result == "ok"
        assert call_count == 1

    def test_retries_on_exception_then_succeeds(self):
        call_count = 0

        @with_retry(RetryConfig(max_retries=3, initial_delay=0))
        def fails_twice_then_succeeds():
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise Exception("temporary failure")
            return "success"

        with patch("time.sleep"):
            result = fails_twice_then_succeeds()

        assert result == "success"
        assert call_count == 3

    def test_raises_after_max_retries_exhausted(self):
        config = RetryConfig(max_retries=2, initial_delay=0)

        @with_retry(config)
        def always_fails():
            raise Exception("always fails")

        with patch("time.sleep"):
            with pytest.raises(Exception, match="always fails"):
                always_fails()

    def test_total_attempts_equals_max_retries_plus_one(self):
        call_count = 0
        config = RetryConfig(max_retries=3, initial_delay=0)

        @with_retry(config)
        def count_calls():
            nonlocal call_count
            call_count += 1
            raise Exception("fail")

        with patch("time.sleep"):
            with pytest.raises(Exception):
                count_calls()

        assert call_count == 4  # 1 initial + 3 retries

    def test_delay_increases_with_backoff(self):
        sleep_calls = []
        config = RetryConfig(max_retries=3, initial_delay=1.0, backoff_factor=2.0, max_delay=100.0)

        @with_retry(config)
        def always_fails():
            raise Exception("fail")

        with patch("time.sleep", side_effect=lambda d: sleep_calls.append(d)):
            with pytest.raises(Exception):
                always_fails()

        # delays: 1.0, 2.0, 4.0
        assert len(sleep_calls) == 3
        assert sleep_calls[0] == pytest.approx(1.0)
        assert sleep_calls[1] == pytest.approx(2.0)
        assert sleep_calls[2] == pytest.approx(4.0)

    def test_delay_capped_at_max_delay(self):
        sleep_calls = []
        config = RetryConfig(max_retries=5, initial_delay=10.0, backoff_factor=10.0, max_delay=25.0)

        @with_retry(config)
        def always_fails():
            raise Exception("fail")

        with patch("time.sleep", side_effect=lambda d: sleep_calls.append(d)):
            with pytest.raises(Exception):
                always_fails()

        for delay in sleep_calls:
            assert delay <= 25.0

    def test_preserves_function_name(self):
        @with_retry()
        def my_named_function():
            return "ok"

        assert my_named_function.__name__ == "my_named_function"

    def test_passes_args_and_kwargs(self):
        @with_retry(RetryConfig(max_retries=0))
        def add(a, b, multiplier=1):
            return (a + b) * multiplier

        result = add(2, 3, multiplier=2)
        assert result == 10

    def test_uses_default_config_when_none_provided(self):
        @with_retry()
        def succeeds():
            return 42

        result = succeeds()
        assert result == 42


class TestRetryOnNetworkError:
    def test_creates_decorator_with_custom_params(self):
        decorator = retry_on_network_error(max_retries=2, initial_delay=0.5, backoff_factor=1.5)
        assert callable(decorator)

    def test_decorated_function_succeeds(self):
        @retry_on_network_error(max_retries=2)
        def fetch():
            return {"data": "ok"}

        with patch("time.sleep"):
            result = fetch()
        assert result == {"data": "ok"}

    def test_retries_on_failure(self):
        call_count = 0

        @retry_on_network_error(max_retries=2)
        def flaky():
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise Exception("network error")
            return "ok"

        with patch("time.sleep"):
            result = flaky()

        assert result == "ok"
        assert call_count == 2


class TestWithGracefulRetry:
    def test_returns_result_on_success(self):
        @with_graceful_retry(SEARCH_API_RETRY_CONFIG, default_return=[])
        def fetch():
            return [1, 2, 3]

        with patch("time.sleep"):
            result = fetch()
        assert result == [1, 2, 3]

    def test_returns_default_on_all_failures(self):
        @with_graceful_retry(
            RetryConfig(max_retries=2, initial_delay=0),
            default_return=[]
        )
        def always_fails():
            raise Exception("fail")

        with patch("time.sleep"):
            result = always_fails()

        assert result == []

    def test_does_not_raise_on_failure(self):
        @with_graceful_retry(
            RetryConfig(max_retries=1, initial_delay=0),
            default_return=None
        )
        def always_fails():
            raise Exception("fail")

        with patch("time.sleep"):
            result = always_fails()  # should not raise

        assert result is None

    def test_returns_default_on_non_retryable_exception(self):
        config = RetryConfig(
            max_retries=2,
            initial_delay=0,
            retry_on_exceptions=(ValueError,)
        )

        @with_graceful_retry(config, default_return="default")
        def raises_type_error():
            raise TypeError("not retryable")

        with patch("time.sleep"):
            result = raises_type_error()

        assert result == "default"

    def test_succeeds_after_retry(self):
        call_count = 0

        @with_graceful_retry(
            RetryConfig(max_retries=3, initial_delay=0),
            default_return=None
        )
        def fails_once():
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise Exception("first fail")
            return "recovered"

        with patch("time.sleep"):
            result = fails_once()

        assert result == "recovered"


class TestMakeRetryableRequest:
    def test_executes_function_successfully(self):
        def my_func(x, y):
            return x + y

        with patch("time.sleep"):
            result = make_retryable_request(my_func, 3, 4)

        assert result == 7

    def test_retries_on_failure_then_succeeds(self):
        call_count = 0

        def flaky():
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise Exception("fail")
            return "ok"

        with patch("time.sleep"):
            result = make_retryable_request(flaky, max_retries=5)

        assert result == "ok"
        assert call_count == 3

    def test_raises_after_max_retries(self):
        def always_fails():
            raise Exception("permanent failure")

        with patch("time.sleep"):
            with pytest.raises(Exception, match="permanent failure"):
                make_retryable_request(always_fails, max_retries=2)


class TestRetryableError:
    def test_is_exception_subclass(self):
        assert issubclass(RetryableError, Exception)

    def test_can_be_raised_and_caught(self):
        with pytest.raises(RetryableError):
            raise RetryableError("test error")

    def test_message_preserved(self):
        try:
            raise RetryableError("my message")
        except RetryableError as e:
            assert str(e) == "my message"


class TestPredefinedConfigs:
    def test_llm_config_has_long_delays(self):
        assert LLM_RETRY_CONFIG.initial_delay >= 60.0
        assert LLM_RETRY_CONFIG.max_delay >= 600.0

    def test_search_api_config_values(self):
        assert SEARCH_API_RETRY_CONFIG.max_retries == 5
        assert SEARCH_API_RETRY_CONFIG.initial_delay == 2.0

    def test_db_config_values(self):
        assert DB_RETRY_CONFIG.max_retries == 5
        assert DB_RETRY_CONFIG.initial_delay == 1.0

    def test_default_config_is_retry_config_instance(self):
        assert isinstance(DEFAULT_RETRY_CONFIG, RetryConfig)
