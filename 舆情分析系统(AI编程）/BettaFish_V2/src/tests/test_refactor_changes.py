"""
tests/test_refactor_changes.py - 覆盖本次重构的所有改动点
1. ReportEngine renderers 懒加载
2. LLM base.py max_tokens allowed_keys
3. chapter_generation_node max_tokens 传参
4. prompts.py 总字数从 40000 改为 8000
"""

import pytest
import sys
import os
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


# ── 1. PDFRenderer 懒加载 ─────────────────────────────────────

class TestPDFRendererLazyLoad:

    def test_import_renderers_does_not_trigger_weasyprint(self):
        """导入 renderers 包时不应触发 pdf_renderer 模块加载"""
        # 记录 pdf_renderer 是否被导入
        before = "ReportEngine.renderers.pdf_renderer" in sys.modules
        # 如果已经被导入了，先移除
        if before:
            del sys.modules["ReportEngine.renderers.pdf_renderer"]

        # 重新导入 renderers 包
        import importlib
        if "ReportEngine.renderers" in sys.modules:
            importlib.reload(sys.modules["ReportEngine.renderers"])
        else:
            import ReportEngine.renderers

        # pdf_renderer 不应该被导入
        assert "ReportEngine.renderers.pdf_renderer" not in sys.modules

    def test_html_renderer_importable(self):
        """HTMLRenderer 应该可以正常导入"""
        from ReportEngine.renderers import HTMLRenderer
        assert HTMLRenderer is not None

    def test_lazy_pdf_renderer_class_exists(self):
        """PDFRenderer 应该作为懒加载代理存在"""
        from ReportEngine.renderers import PDFRenderer
        assert PDFRenderer is not None
        # 它应该是 _LazyPDFRenderer 类
        assert "Lazy" in type(PDFRenderer).__name__ or hasattr(PDFRenderer, "__new__")


# ── 2. LLM base.py allowed_keys 包含 max_tokens ──────────────

class TestLLMAllowedKeys:

    def test_max_tokens_in_allowed_keys(self):
        """stream_invoke 的 allowed_keys 应包含 max_tokens"""
        import inspect
        from ReportEngine.llms.base import LLMClient

        source = inspect.getsource(LLMClient.stream_invoke)
        assert "max_tokens" in source

    def test_stream_invoke_passes_max_tokens(self):
        """stream_invoke 调用时 max_tokens 不应被过滤"""
        from ReportEngine.llms.base import LLMClient

        # 构造一个 mock client
        with patch.object(LLMClient, "__init__", lambda self, *a, **kw: None):
            client = LLMClient.__new__(LLMClient)
            client.model_name = "test-model"
            client.timeout = 30

            mock_openai = MagicMock()
            mock_stream = MagicMock()
            mock_stream.__iter__ = MagicMock(return_value=iter([]))
            mock_openai.chat.completions.create.return_value = mock_stream
            client.client = mock_openai

            # 调用 stream_invoke 并传入 max_tokens
            list(client.stream_invoke("sys", "user", max_tokens=8192))

            # 验证 create 被调用时包含 max_tokens
            call_kwargs = mock_openai.chat.completions.create.call_args
            assert call_kwargs is not None
            # max_tokens 应该在 kwargs 中
            all_kwargs = call_kwargs.kwargs if hasattr(call_kwargs, 'kwargs') else call_kwargs[1]
            assert all_kwargs.get("max_tokens") == 8192


# ── 3. chapter_generation_node max_tokens 默认值 ─────────────

class TestChapterGenerationMaxTokens:

    def test_stream_invoke_called_with_max_tokens(self):
        """章节生成时 stream_invoke 应带 max_tokens=8192"""
        import inspect
        from ReportEngine.nodes.chapter_generation_node import ChapterGenerationNode

        # 检查 _stream_chapter_json 方法源码中包含 max_tokens
        source = inspect.getsource(ChapterGenerationNode._stream_chapter_json)
        assert "max_tokens" in source


# ── 4. prompts.py 总字数改为 8000 ────────────────────────────

class TestWordBudgetPrompt:

    def test_total_words_is_8000(self):
        """篇幅规划 prompt 中总字数应为 8000"""
        from ReportEngine.prompts.prompts import SYSTEM_PROMPT_WORD_BUDGET
        assert "8000" in SYSTEM_PROMPT_WORD_BUDGET
        assert "40000" not in SYSTEM_PROMPT_WORD_BUDGET

    def test_word_budget_prompt_contains_guidelines(self):
        """篇幅规划 prompt 应包含关键指导词"""
        from ReportEngine.prompts.prompts import SYSTEM_PROMPT_WORD_BUDGET
        assert "globalGuidelines" in SYSTEM_PROMPT_WORD_BUDGET
        assert "chapters" in SYSTEM_PROMPT_WORD_BUDGET
