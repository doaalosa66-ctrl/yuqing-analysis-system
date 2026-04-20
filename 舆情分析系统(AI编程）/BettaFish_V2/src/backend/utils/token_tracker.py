"""
全局 Token 熔断器（Token Tracker）

线程安全的单例计数器，跨所有引擎累计 Token 消耗。
当累计 Token 超过 MAX_TOKENS_PER_TASK 阈值时，触发熔断信号，
调用方应捕获 TokenBudgetExceeded 异常并优雅降级。
"""

import threading
import os
from loguru import logger


class TokenBudgetExceeded(Exception):
    """Token 预算耗尽时抛出，调用方应捕获并优雅降级而非崩溃。"""
    pass


class TokenTracker:
    """线程安全的全局 Token 计数器（单例）。"""

    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return
        self._counter_lock = threading.Lock()
        self._total_tokens = 0
        self._prompt_tokens = 0
        self._completion_tokens = 0
        self._call_count = 0
        self._max_tokens = int(os.getenv("MAX_TOKENS_PER_TASK", "200000"))
        self._initialized = True
        logger.info(f"[TokenTracker] 初始化完成，单次任务上限: {self._max_tokens} tokens")

    def reset(self):
        """每次新任务开始前调用，清零计数器并重新读取预算配置。"""
        with self._counter_lock:
            self._total_tokens = 0
            self._prompt_tokens = 0
            self._completion_tokens = 0
            self._call_count = 0
            self._max_tokens = int(os.environ.get("MAX_TOKENS_PER_TASK", "200000"))
        logger.info(f"[TokenTracker] 计数器已重置，上限: {self._max_tokens} tokens")

    def check_budget(self):
        """在发起 LLM 请求前调用，超限则抛出 TokenBudgetExceeded。"""
        with self._counter_lock:
            if self._total_tokens >= self._max_tokens:
                msg = (
                    f"Token 预算耗尽：已消耗 {self._total_tokens}/{self._max_tokens} tokens "
                    f"（共 {self._call_count} 次调用），触发熔断"
                )
                logger.warning(f"[TokenTracker] {msg}")
                raise TokenBudgetExceeded(msg)

    def record_usage(self, usage):
        """
        记录一次 LLM 调用的 token 消耗。

        Args:
            usage: OpenAI API 返回的 response.usage 对象，
                   包含 prompt_tokens / completion_tokens / total_tokens。
                   如果为 None（某些流式调用不返回 usage），则跳过。
        """
        if usage is None:
            return

        prompt = getattr(usage, "prompt_tokens", 0) or 0
        completion = getattr(usage, "completion_tokens", 0) or 0
        total = getattr(usage, "total_tokens", 0) or (prompt + completion)

        with self._counter_lock:
            self._prompt_tokens += prompt
            self._completion_tokens += completion
            self._total_tokens += total
            self._call_count += 1
            current = self._total_tokens

        logger.info(
            f"[TokenTracker] 本次消耗: {total} tokens "
            f"(prompt={prompt}, completion={completion}) | "
            f"累计: {current}/{self._max_tokens} tokens, "
            f"第 {self._call_count} 次调用"
        )

    @property
    def total_tokens(self) -> int:
        with self._counter_lock:
            return self._total_tokens

    @property
    def call_count(self) -> int:
        with self._counter_lock:
            return self._call_count

    def summary(self) -> str:
        """返回当前任务的 Token 消耗摘要。"""
        with self._counter_lock:
            return (
                f"Token 消耗摘要: 总计 {self._total_tokens} tokens "
                f"(prompt={self._prompt_tokens}, completion={self._completion_tokens}), "
                f"共 {self._call_count} 次 LLM 调用, "
                f"预算上限 {self._max_tokens} tokens"
            )


# 全局单例
tracker = TokenTracker()
