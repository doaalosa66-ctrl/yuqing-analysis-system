"""
Unit tests for utils/forum_reader.py - Forum日志读取工具 (模块 8.5 公共工具)
"""

import pytest
import sys
import os
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from utils.forum_reader import (
    get_latest_host_speech,
    get_all_host_speeches,
    get_recent_agent_speeches,
    format_host_speech_for_prompt,
)


@pytest.fixture
def log_dir(tmp_path):
    """创建临时日志目录"""
    return str(tmp_path)


@pytest.fixture
def forum_log(tmp_path):
    """创建带内容的 forum.log"""
    log_file = tmp_path / "forum.log"
    log_file.write_text(
        "[10:00:00] [INSIGHT] 分析完成，发现3个热点话题\n"
        "[10:01:00] [MEDIA] 多媒体搜索返回15条结果\n"
        "[10:02:00] [HOST] 各位Agent的分析很有深度，让我们聚焦经济话题\\n继续讨论\n"
        "[10:03:00] [QUERY] 新闻查询完成\n"
        "[10:04:00] [HOST] 第二轮总结：综合来看趋势向好\n",
        encoding="utf-8",
    )
    return str(tmp_path)


class TestGetLatestHostSpeech:
    def test_returns_none_when_no_log_file(self, log_dir):
        result = get_latest_host_speech(log_dir)
        assert result is None

    def test_returns_latest_host_speech(self, forum_log):
        result = get_latest_host_speech(forum_log)
        assert result is not None
        assert "第二轮总结" in result

    def test_handles_escaped_newlines(self, forum_log):
        # 第一条HOST发言包含 \\n，应被还原为真实换行
        speeches = get_all_host_speeches(forum_log)
        first_host = speeches[0]["content"]
        assert "\n" in first_host

    def test_returns_none_when_no_host_speech(self, tmp_path):
        log_file = tmp_path / "forum.log"
        log_file.write_text("[10:00:00] [INSIGHT] 只有Agent发言\n", encoding="utf-8")
        result = get_latest_host_speech(str(tmp_path))
        assert result is None


class TestGetAllHostSpeeches:
    def test_returns_empty_when_no_file(self, log_dir):
        result = get_all_host_speeches(log_dir)
        assert result == []

    def test_returns_all_host_speeches(self, forum_log):
        result = get_all_host_speeches(forum_log)
        assert len(result) == 2

    def test_each_speech_has_timestamp_and_content(self, forum_log):
        result = get_all_host_speeches(forum_log)
        for speech in result:
            assert "timestamp" in speech
            assert "content" in speech
            assert len(speech["timestamp"]) == 8  # HH:MM:SS


class TestGetRecentAgentSpeeches:
    def test_returns_empty_when_no_file(self, log_dir):
        result = get_recent_agent_speeches(log_dir)
        assert result == []

    def test_returns_agent_speeches_only(self, forum_log):
        result = get_recent_agent_speeches(forum_log)
        for speech in result:
            assert speech["agent"] in ("INSIGHT", "MEDIA", "QUERY")

    def test_respects_limit(self, forum_log):
        result = get_recent_agent_speeches(forum_log, limit=2)
        assert len(result) <= 2

    def test_returns_in_chronological_order(self, forum_log):
        result = get_recent_agent_speeches(forum_log, limit=10)
        if len(result) >= 2:
            assert result[0]["timestamp"] <= result[-1]["timestamp"]


class TestFormatHostSpeechForPrompt:
    def test_empty_input_returns_empty(self):
        assert format_host_speech_for_prompt("") == ""
        assert format_host_speech_for_prompt(None) == ""

    def test_formats_with_header(self):
        result = format_host_speech_for_prompt("测试发言内容")
        assert "论坛主持人" in result
        assert "测试发言内容" in result

    def test_contains_separator(self):
        result = format_host_speech_for_prompt("内容")
        assert "---" in result
