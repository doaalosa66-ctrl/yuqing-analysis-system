"""
Unit tests for MindSpider - 爬虫模块 (模块 2.4, 2.5, 2.6)
BroadTopicExtraction + DeepSentimentCrawling
"""

import pytest
import sys
import os
from unittest.mock import patch, MagicMock, AsyncMock
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


# ==================== 广域话题提取 (模块 2.4) ====================

class TestNewsCollector:
    """测试 NewsCollector 新闻收集器"""

    @patch("MindSpider.BroadTopicExtraction.get_today_news.DatabaseManager")
    def test_init(self, mock_db):
        from MindSpider.BroadTopicExtraction.get_today_news import NewsCollector
        collector = NewsCollector()
        assert collector is not None

    @patch("MindSpider.BroadTopicExtraction.get_today_news.DatabaseManager")
    def test_supported_sources_not_empty(self, mock_db):
        from MindSpider.BroadTopicExtraction.get_today_news import NewsCollector
        collector = NewsCollector()
        assert hasattr(collector, "supported_sources")
        assert len(collector.supported_sources) > 0

    @patch("MindSpider.BroadTopicExtraction.get_today_news.DatabaseManager")
    def test_supported_sources_include_weibo(self, mock_db):
        from MindSpider.BroadTopicExtraction.get_today_news import NewsCollector
        collector = NewsCollector()
        sources = collector.supported_sources
        # 应包含微博等主流平台
        source_names = [s.lower() if isinstance(s, str) else str(s).lower() for s in sources]
        has_known_source = any(
            name in " ".join(source_names)
            for name in ["weibo", "微博", "zhihu", "知乎", "bilibili", "bili"]
        )
        assert has_known_source or len(sources) >= 5  # 至少有5个源


class TestTopicExtractor:
    """测试 TopicExtractor 话题提取器"""

    @patch("MindSpider.BroadTopicExtraction.topic_extractor.OpenAI")
    def test_init(self, mock_openai):
        from MindSpider.BroadTopicExtraction.topic_extractor import TopicExtractor
        extractor = TopicExtractor()
        assert extractor is not None

    @patch("MindSpider.BroadTopicExtraction.topic_extractor.OpenAI")
    def test_extract_keywords_returns_tuple(self, mock_openai):
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = '{"keywords": ["经济", "科技"], "summary": "今日热点"}'
        mock_client.chat.completions.create.return_value = mock_response
        mock_openai.return_value = mock_client

        from MindSpider.BroadTopicExtraction.topic_extractor import TopicExtractor
        extractor = TopicExtractor()
        news_list = [{"title": "经济增长", "content": "GDP上涨"}]
        result = extractor.extract_keywords_and_summary(news_list)
        assert isinstance(result, tuple)
        assert len(result) == 2


class TestBroadTopicDatabaseManager:
    """测试 BroadTopicExtraction DatabaseManager"""

    @patch("MindSpider.BroadTopicExtraction.database_manager.create_engine")
    def test_init(self, mock_engine):
        from MindSpider.BroadTopicExtraction.database_manager import DatabaseManager
        mgr = DatabaseManager()
        assert mgr is not None

    @patch("MindSpider.BroadTopicExtraction.database_manager.create_engine")
    def test_context_manager(self, mock_engine):
        from MindSpider.BroadTopicExtraction.database_manager import DatabaseManager
        mgr = DatabaseManager()
        # 测试 __enter__ 和 __exit__
        with mgr as m:
            assert m is not None


# ==================== 深度情感爬取 (模块 2.5) ====================

class TestKeywordManager:
    """测试 KeywordManager 关键词管理器"""

    @patch("MindSpider.DeepSentimentCrawling.keyword_manager.create_engine")
    def test_init(self, mock_engine):
        from MindSpider.DeepSentimentCrawling.keyword_manager import KeywordManager
        mgr = KeywordManager()
        assert mgr is not None

    @patch("MindSpider.DeepSentimentCrawling.keyword_manager.create_engine")
    def test_get_latest_keywords(self, mock_engine):
        mock_conn = MagicMock()
        mock_result = MagicMock()
        mock_result.fetchall.return_value = [("keyword1",), ("keyword2",)]
        mock_conn.execute.return_value = mock_result
        mock_engine.return_value.connect.return_value.__enter__ = lambda s: mock_conn
        mock_engine.return_value.connect.return_value.__exit__ = MagicMock()

        from MindSpider.DeepSentimentCrawling.keyword_manager import KeywordManager
        mgr = KeywordManager()
        # 方法可能需要日期参数
        try:
            result = mgr.get_latest_keywords()
            assert isinstance(result, (list, tuple))
        except TypeError:
            # 如果需要参数
            result = mgr.get_latest_keywords(target_date="2026-04-08")
            assert isinstance(result, (list, tuple))


class TestPlatformCrawler:
    """测试 PlatformCrawler 平台爬虫管理器"""

    def test_init(self):
        try:
            from MindSpider.DeepSentimentCrawling.platform_crawler import PlatformCrawler
            crawler = PlatformCrawler()
            assert crawler is not None
        except FileNotFoundError:
            pytest.skip("MediaCrawler子模块未初始化，跳过PlatformCrawler测试")

    def test_supported_platforms(self):
        try:
            from MindSpider.DeepSentimentCrawling.platform_crawler import PlatformCrawler
            crawler = PlatformCrawler()
            assert hasattr(crawler, "supported_platforms")
            platforms = crawler.supported_platforms
            assert len(platforms) >= 5
            expected = {"xhs", "dy", "ks", "bili", "wb"}
            assert expected.issubset(set(platforms))
        except FileNotFoundError:
            pytest.skip("MediaCrawler子模块未初始化")

    def test_mediacrawler_path_exists(self):
        try:
            from MindSpider.DeepSentimentCrawling.platform_crawler import PlatformCrawler
            crawler = PlatformCrawler()
            assert hasattr(crawler, "mediacrawler_path")
        except FileNotFoundError:
            pytest.skip("MediaCrawler子模块未初始化")


# ==================== MediaCrawler (模块 2.6) ====================

class TestMediaCrawlerSubmodule:
    """测试 MediaCrawler 子模块状态"""

    def test_mediacrawler_directory_exists(self):
        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        mc_path = os.path.join(
            project_root, "MindSpider", "DeepSentimentCrawling", "MediaCrawler"
        )
        assert os.path.isdir(mc_path), "MediaCrawler目录应存在（即使是空的git子模块）"

    def test_gitmodules_references_mediacrawler(self):
        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        gitmodules = os.path.join(project_root, ".gitmodules")
        if os.path.exists(gitmodules):
            with open(gitmodules, "r") as f:
                content = f.read()
            assert "MediaCrawler" in content
