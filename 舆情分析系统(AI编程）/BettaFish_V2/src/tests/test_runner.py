"""
tests/test_runner.py - runner.py 单元测试
覆盖: run_insight, run_media, run_query, run_all_engines, run_report, run_pipeline
"""

import pytest
import sys
import os
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


# ── run_insight ──────────────────────────────────────────────

class TestRunInsight:

    @patch("runner.DeepSearchAgent", create=True)
    @patch("runner.Settings", create=True)
    def _make_mock(self, MockSettings, MockAgent):
        """辅助：构造 mock agent"""
        config = MockSettings.return_value
        agent = MockAgent.return_value
        para = MagicMock()
        agent.state.paragraphs = [para]
        agent._generate_final_report.return_value = "insight report"
        return agent, para

    @patch("InsightEngine.utils.config.Settings")
    @patch("InsightEngine.agent.DeepSearchAgent")
    def test_returns_done(self, MockAgent, MockSettings):
        agent = MockAgent.return_value
        para = MagicMock()
        agent.state.paragraphs = [para]
        agent._generate_final_report.return_value = "insight report"

        from runner import run_insight
        result = run_insight("test query")

        assert result["engine"] == "insight"
        assert result["status"] == "done"
        assert result["report"] == "insight report"

    @patch("InsightEngine.utils.config.Settings")
    @patch("InsightEngine.agent.DeepSearchAgent")
    def test_calls_agent_methods(self, MockAgent, MockSettings):
        agent = MockAgent.return_value
        para = MagicMock()
        agent.state.paragraphs = [para]
        agent._generate_final_report.return_value = "r"

        from runner import run_insight
        run_insight("q")

        agent._generate_report_structure.assert_called_once_with("q")
        agent._initial_search_and_summary.assert_called_once_with(0)
        agent._reflection_loop.assert_called_once_with(0)
        agent._generate_final_report.assert_called_once()
        agent._save_report.assert_called_once_with("r")

    @patch("InsightEngine.utils.config.Settings")
    @patch("InsightEngine.agent.DeepSearchAgent")
    def test_progress_callback(self, MockAgent, MockSettings):
        agent = MockAgent.return_value
        agent.state.paragraphs = [MagicMock()]
        agent._generate_final_report.return_value = "r"

        from runner import run_insight
        cb = MagicMock()
        run_insight("q", progress_cb=cb)

        assert cb.call_count >= 3  # 开始 + 段落 + 完成


# ── run_media ────────────────────────────────────────────────

class TestRunMedia:

    @patch("MediaEngine.agent.AnspireSearchAgent")
    @patch("MediaEngine.utils.config.Settings")
    def test_anspire_agent(self, MockSettings, MockAgent):
        config = MockSettings.return_value
        config.SEARCH_TOOL_TYPE = "AnspireAPI"
        agent = MockAgent.return_value
        agent.state.paragraphs = [MagicMock()]
        agent._generate_final_report.return_value = "media report"

        from runner import run_media
        result = run_media("q")

        assert result["engine"] == "media"
        assert result["status"] == "done"
        MockAgent.assert_called_once()

    @patch("MediaEngine.agent.DeepSearchAgent")
    @patch("MediaEngine.utils.config.Settings")
    def test_bocha_agent(self, MockSettings, MockAgent):
        config = MockSettings.return_value
        config.SEARCH_TOOL_TYPE = "BochaAPI"
        agent = MockAgent.return_value
        agent.state.paragraphs = [MagicMock()]
        agent._generate_final_report.return_value = "r"

        from runner import run_media
        result = run_media("q")

        assert result["status"] == "done"


# ── run_query ────────────────────────────────────────────────

class TestRunQuery:

    @patch("QueryEngine.utils.config.Settings")
    @patch("QueryEngine.agent.DeepSearchAgent")
    def test_returns_done(self, MockAgent, MockSettings):
        agent = MockAgent.return_value
        agent.state.paragraphs = [MagicMock()]
        agent._generate_final_report.return_value = "query report"

        from runner import run_query
        result = run_query("q")

        assert result["engine"] == "query"
        assert result["status"] == "done"
        assert result["report"] == "query report"


# ── run_all_engines ──────────────────────────────────────────

class TestRunAllEngines:

    @patch("runner.run_query")
    @patch("runner.run_media")
    @patch("runner.run_insight")
    def test_returns_all_reports(self, mock_insight, mock_media, mock_query):
        mock_insight.return_value = {"engine": "insight", "report": "r1", "status": "done"}
        mock_media.return_value = {"engine": "media", "report": "r2", "status": "done"}
        mock_query.return_value = {"engine": "query", "report": "r3", "status": "done"}

        from runner import run_all_engines
        reports = run_all_engines("q")

        assert len(reports) == 3
        assert reports == ["r1", "r2", "r3"]

    @patch("runner.run_query")
    @patch("runner.run_media")
    @patch("runner.run_insight")
    def test_partial_failure(self, mock_insight, mock_media, mock_query):
        mock_insight.return_value = {"engine": "insight", "report": "r1", "status": "done"}
        mock_media.side_effect = Exception("API down")
        mock_query.return_value = {"engine": "query", "report": "r3", "status": "done"}

        from runner import run_all_engines
        reports = run_all_engines("q")

        # media 失败，只返回 insight + query
        assert len(reports) == 2
        assert "r1" in reports
        assert "r3" in reports

    @patch("runner.run_query")
    @patch("runner.run_media")
    @patch("runner.run_insight")
    def test_all_failure_returns_empty(self, mock_insight, mock_media, mock_query):
        mock_insight.side_effect = Exception("fail")
        mock_media.side_effect = Exception("fail")
        mock_query.side_effect = Exception("fail")

        from runner import run_all_engines
        reports = run_all_engines("q")

        assert reports == []

    @patch("runner.run_query")
    @patch("runner.run_media")
    @patch("runner.run_insight")
    def test_progress_callback_called(self, mock_insight, mock_media, mock_query):
        mock_insight.return_value = {"engine": "insight", "report": "r1", "status": "done"}
        mock_media.return_value = {"engine": "media", "report": "r2", "status": "done"}
        mock_query.return_value = {"engine": "query", "report": "r3", "status": "done"}

        from runner import run_all_engines
        cb = MagicMock()
        run_all_engines("q", progress_cb=cb)
        # 回调被传递给各引擎
        mock_insight.assert_called_once_with("q", cb)
        mock_media.assert_called_once_with("q", cb)
        mock_query.assert_called_once_with("q", cb)


# ── run_report ───────────────────────────────────────────────

class TestRunReport:

    @patch("runner.create_agent")
    def test_calls_generate_report(self, mock_create):
        agent = mock_create.return_value
        agent.generate_report.return_value = {"html": "<h1>done</h1>"}

        from runner import run_report
        result = run_report("q", ["r1", "r2"])

        agent.generate_report.assert_called_once_with(
            query="q",
            reports=["r1", "r2"],
            forum_logs="",
            custom_template="",
            save_report=True,
        )
        assert result == {"html": "<h1>done</h1>"}

    @patch("runner.create_agent")
    def test_progress_callback(self, mock_create):
        agent = mock_create.return_value
        agent.generate_report.return_value = {}

        from runner import run_report
        cb = MagicMock()
        run_report("q", ["r1"], progress_cb=cb)

        assert cb.call_count >= 2  # 开始 + 完成


# ── run_pipeline ─────────────────────────────────────────────

class TestRunPipeline:

    @patch("runner.run_report")
    @patch("runner.run_all_engines")
    def test_full_pipeline(self, mock_engines, mock_report):
        mock_engines.return_value = ["r1", "r2"]
        mock_report.return_value = {"report_filepath": "/path/to/report.html"}

        from runner import run_pipeline
        result = run_pipeline("q")

        mock_engines.assert_called_once()
        mock_report.assert_called_once_with("q", ["r1", "r2"], progress_cb=None)
        assert result["report_filepath"] == "/path/to/report.html"

    @patch("runner.run_report")
    @patch("runner.run_all_engines")
    def test_pipeline_fails_when_no_reports(self, mock_engines, mock_report):
        mock_engines.return_value = []

        from runner import run_pipeline
        with pytest.raises(RuntimeError, match="所有采集引擎均失败"):
            run_pipeline("q")

        mock_report.assert_not_called()
