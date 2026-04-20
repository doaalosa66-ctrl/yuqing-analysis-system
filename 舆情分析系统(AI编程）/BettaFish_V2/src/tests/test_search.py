"""
Unit tests for InsightEngine/tools/search.py (MediaCrawlerDB)
"""

import pytest
import sys
import os
from unittest.mock import patch, MagicMock
from datetime import datetime, date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from InsightEngine.tools.search import (
    QueryResult,
    DBResponse,
    MediaCrawlerDB,
    print_response_summary,
)


class TestQueryResult:
    def test_default_values(self):
        r = QueryResult(platform="bilibili", content_type="video", title_or_content="test")
        assert r.author_nickname is None
        assert r.url is None
        assert r.publish_time is None
        assert r.engagement == {}
        assert r.source_keyword is None
        assert r.hotness_score == 0.0
        assert r.source_table == ""

    def test_custom_values(self):
        r = QueryResult(
            platform="weibo",
            content_type="note",
            title_or_content="content",
            author_nickname="user1",
            hotness_score=99.5,
            source_table="weibo_note",
        )
        assert r.platform == "weibo"
        assert r.author_nickname == "user1"
        assert r.hotness_score == 99.5
        assert r.source_table == "weibo_note"


class TestDBResponse:
    def test_default_values(self):
        resp = DBResponse(tool_name="test_tool", parameters={})
        assert resp.results == []
        assert resp.results_count == 0
        assert resp.error_message is None

    def test_with_error(self):
        resp = DBResponse(tool_name="test_tool", parameters={}, error_message="DB error")
        assert resp.error_message == "DB error"

    def test_with_results(self):
        r = QueryResult(platform="xhs", content_type="note", title_or_content="hello")
        resp = DBResponse(tool_name="test_tool", parameters={}, results=[r], results_count=1)
        assert resp.results_count == 1
        assert resp.results[0].platform == "xhs"


class TestMediaCrawlerDBToDatetime:
    def test_datetime_passthrough(self):
        dt = datetime(2025, 1, 1, 12, 0, 0)
        result = MediaCrawlerDB._to_datetime(dt)
        assert result == dt

    def test_date_converted_to_datetime(self):
        d = date(2025, 6, 15)
        result = MediaCrawlerDB._to_datetime(d)
        assert isinstance(result, datetime)
        assert result.year == 2025
        assert result.month == 6
        assert result.day == 15

    def test_iso_string_parsed(self):
        result = MediaCrawlerDB._to_datetime("2025-08-01T10:30:00")
        assert isinstance(result, datetime)
        assert result.year == 2025
        assert result.month == 8

    def test_iso_string_with_timezone_stripped(self):
        result = MediaCrawlerDB._to_datetime("2025-08-01T10:30:00+08:00")
        assert isinstance(result, datetime)

    def test_unix_timestamp_seconds(self):
        ts = 1700000000  # ~2023-11-14
        result = MediaCrawlerDB._to_datetime(ts)
        assert isinstance(result, datetime)
        assert result.year == 2023

    def test_unix_timestamp_milliseconds(self):
        ts = 1700000000000  # milliseconds
        result = MediaCrawlerDB._to_datetime(ts)
        assert isinstance(result, datetime)

    def test_none_returns_none(self):
        assert MediaCrawlerDB._to_datetime(None) is None

    def test_empty_string_returns_none(self):
        assert MediaCrawlerDB._to_datetime("") is None

    def test_invalid_string_returns_none(self):
        assert MediaCrawlerDB._to_datetime("not-a-date") is None


class TestMediaCrawlerDBExtractEngagement:
    def setup_method(self):
        self.db = MediaCrawlerDB()

    def test_extracts_liked_count(self):
        row = {"liked_count": 100}
        result = self.db._extract_engagement(row)
        assert result.get("likes") == 100

    def test_extracts_video_comment(self):
        row = {"video_comment": 50}
        result = self.db._extract_engagement(row)
        assert result.get("comments") == 50

    def test_extracts_share_count(self):
        row = {"share_count": 30}
        result = self.db._extract_engagement(row)
        assert result.get("shares") == 30

    def test_extracts_view_count(self):
        row = {"video_play_count": 10000}
        result = self.db._extract_engagement(row)
        assert result.get("views") == 10000

    def test_empty_row_returns_empty_dict(self):
        result = self.db._extract_engagement({})
        assert result == {}

    def test_invalid_value_defaults_to_zero(self):
        row = {"liked_count": "not_a_number"}
        result = self.db._extract_engagement(row)
        assert result.get("likes") == 0

    def test_none_value_skipped(self):
        row = {"liked_count": None, "video_comment": 5}
        result = self.db._extract_engagement(row)
        assert "likes" not in result
        assert result.get("comments") == 5

    def test_multiple_fields_extracted(self):
        row = {"liked_count": 10, "video_comment": 5, "video_share_count": 3}
        result = self.db._extract_engagement(row)
        assert result.get("likes") == 10
        assert result.get("comments") == 5
        assert result.get("shares") == 3


class TestMediaCrawlerDBExecuteQuery:
    def setup_method(self):
        self.db = MediaCrawlerDB()

    def test_returns_list_on_success(self):
        mock_rows = [{"id": 1, "title": "test"}]
        with patch("InsightEngine.tools.search.fetch_all") as mock_fetch:
            mock_fetch.return_value = mock_rows
            with patch("asyncio.get_event_loop") as mock_loop:
                mock_loop.return_value.is_closed.return_value = False
                mock_loop.return_value.run_until_complete.return_value = mock_rows
                result = self.db._execute_query("SELECT 1")
        assert isinstance(result, list)

    def test_returns_empty_list_on_exception(self):
        with patch("asyncio.get_event_loop") as mock_loop:
            mock_loop.return_value.is_closed.return_value = False
            mock_loop.return_value.run_until_complete.side_effect = Exception("DB error")
            result = self.db._execute_query("SELECT 1")
        assert result == []


class TestSearchTopicByDate:
    def setup_method(self):
        self.db = MediaCrawlerDB()

    def test_invalid_date_format_returns_error(self):
        response = self.db.search_topic_by_date(
            topic="test",
            start_date="2025/01/01",
            end_date="2025/12/31"
        )
        assert response.error_message is not None
        assert "日期格式" in response.error_message

    def test_valid_date_format_calls_execute(self):
        with patch.object(self.db, "_execute_query", return_value=[]) as mock_exec:
            response = self.db.search_topic_by_date(
                topic="test",
                start_date="2025-01-01",
                end_date="2025-12-31"
            )
        assert response.error_message is None
        assert mock_exec.called

    def test_returns_db_response_type(self):
        with patch.object(self.db, "_execute_query", return_value=[]):
            response = self.db.search_topic_by_date(
                topic="test",
                start_date="2025-01-01",
                end_date="2025-01-31"
            )
        assert isinstance(response, DBResponse)
        assert response.tool_name == "search_topic_by_date"

    def test_parameters_logged_in_response(self):
        with patch.object(self.db, "_execute_query", return_value=[]):
            response = self.db.search_topic_by_date(
                topic="AI",
                start_date="2025-01-01",
                end_date="2025-01-31"
            )
        assert response.parameters["topic"] == "AI"
        assert response.parameters["start_date"] == "2025-01-01"

    def test_results_count_matches_results_length(self):
        mock_row = {
            "title": "test title", "content": None, "desc": None, "content_text": None,
            "create_time": None, "time": None, "created_time": None,
            "publish_time": None, "crawl_date": None,
            "nickname": "user", "user_nickname": None, "user_name": None,
            "video_url": None, "note_url": None, "content_url": None,
            "url": None, "aweme_url": None, "source_keyword": None,
        }
        with patch.object(self.db, "_execute_query", return_value=[mock_row]):
            response = self.db.search_topic_by_date(
                topic="test",
                start_date="2025-01-01",
                end_date="2025-01-31"
            )
        assert response.results_count == len(response.results)


class TestSearchTopicOnPlatform:
    def setup_method(self):
        self.db = MediaCrawlerDB()

    def test_unsupported_platform_returns_error(self):
        response = self.db.search_topic_on_platform(
            platform="twitter",
            topic="test"
        )
        assert response.error_message is not None
        assert "不支持" in response.error_message

    def test_invalid_date_format_returns_error(self):
        response = self.db.search_topic_on_platform(
            platform="bilibili",
            topic="test",
            start_date="2025/01/01",
            end_date="2025/12/31"
        )
        assert response.error_message is not None
        assert "日期格式" in response.error_message

    def test_valid_platform_calls_execute(self):
        with patch.object(self.db, "_execute_query", return_value=[]) as mock_exec:
            response = self.db.search_topic_on_platform(
                platform="bilibili",
                topic="test"
            )
        assert response.error_message is None
        assert mock_exec.called

    def test_all_supported_platforms_accepted(self):
        platforms = ["bilibili", "weibo", "douyin", "kuaishou", "xhs", "zhihu", "tieba"]
        for platform in platforms:
            with patch.object(self.db, "_execute_query", return_value=[]):
                response = self.db.search_topic_on_platform(platform=platform, topic="test")
            assert response.error_message is None, f"Platform {platform} should be supported"

    def test_returns_db_response_type(self):
        with patch.object(self.db, "_execute_query", return_value=[]):
            response = self.db.search_topic_on_platform(platform="weibo", topic="test")
        assert isinstance(response, DBResponse)
        assert response.tool_name == "search_topic_on_platform"


class TestSearchTopicGlobally:
    def setup_method(self):
        self.db = MediaCrawlerDB()

    def test_returns_db_response(self):
        with patch.object(self.db, "_execute_query", return_value=[]):
            response = self.db.search_topic_globally(topic="AI")
        assert isinstance(response, DBResponse)
        assert response.tool_name == "search_topic_globally"

    def test_parameters_stored_in_response(self):
        with patch.object(self.db, "_execute_query", return_value=[]):
            response = self.db.search_topic_globally(topic="AI", limit_per_table=50)
        assert response.parameters["topic"] == "AI"
        assert response.parameters["limit_per_table"] == 50

    def test_results_count_matches_results(self):
        mock_row = {
            "title": "test", "content": None, "desc": None, "content_text": None,
            "create_time": None, "time": None, "created_time": None,
            "publish_time": None, "crawl_date": None,
            "nickname": None, "user_nickname": None, "user_name": None,
            "video_url": None, "note_url": None, "content_url": None,
            "url": None, "aweme_url": None, "source_keyword": None,
        }
        with patch.object(self.db, "_execute_query", return_value=[mock_row]):
            response = self.db.search_topic_globally(topic="test")
        assert response.results_count == len(response.results)

    def test_empty_results_when_no_matches(self):
        with patch.object(self.db, "_execute_query", return_value=[]):
            response = self.db.search_topic_globally(topic="nonexistent_topic_xyz")
        assert response.results == []
        assert response.results_count == 0


class TestSearchHotContent:
    def setup_method(self):
        self.db = MediaCrawlerDB()

    def test_returns_db_response(self):
        with patch.object(self.db, "_execute_query", return_value=[]):
            response = self.db.search_hot_content()
        assert isinstance(response, DBResponse)
        assert response.tool_name == "search_hot_content"

    def test_default_time_period_is_week(self):
        with patch.object(self.db, "_execute_query", return_value=[]) as mock_exec:
            response = self.db.search_hot_content()
        assert response.parameters["time_period"] == "week"

    def test_24h_time_period_accepted(self):
        with patch.object(self.db, "_execute_query", return_value=[]):
            response = self.db.search_hot_content(time_period="24h")
        assert response.parameters["time_period"] == "24h"

    def test_year_time_period_accepted(self):
        with patch.object(self.db, "_execute_query", return_value=[]):
            response = self.db.search_hot_content(time_period="year")
        assert response.parameters["time_period"] == "year"

    def test_results_formatted_as_query_results(self):
        mock_row = {
            "p": "bilibili", "t": "video", "title": "test video",
            "author": "creator", "url": "http://example.com",
            "ts": None, "hotness_score": 500.0,
            "source_keyword": "AI", "tbl": "bilibili_video",
        }
        with patch.object(self.db, "_execute_query", return_value=[mock_row]):
            response = self.db.search_hot_content(limit=1)
        assert len(response.results) == 1
        assert response.results[0].platform == "bilibili"
        assert response.results[0].hotness_score == 500.0


class TestGetCommentsForTopic:
    def setup_method(self):
        self.db = MediaCrawlerDB()

    def test_returns_db_response(self):
        with patch.object(self.db, "_get_table_columns", return_value=["content", "nickname", "create_time"]):
            with patch.object(self.db, "_execute_query", return_value=[]):
                response = self.db.get_comments_for_topic(topic="test")
        assert isinstance(response, DBResponse)
        assert response.tool_name == "get_comments_for_topic"

    def test_parameters_stored(self):
        with patch.object(self.db, "_get_table_columns", return_value=["content", "nickname", "create_time"]):
            with patch.object(self.db, "_execute_query", return_value=[]):
                response = self.db.get_comments_for_topic(topic="AI", limit=100)
        assert response.parameters["topic"] == "AI"
        assert response.parameters["limit"] == 100

    def test_comment_results_have_comment_type(self):
        mock_row = {
            "platform": "bilibili",
            "content": "great video!",
            "author": "viewer1",
            "ts": None,
            "likes": "10",
            "source_table": "bilibili_video_comment",
        }
        with patch.object(self.db, "_get_table_columns", return_value=["content", "nickname", "create_time"]):
            with patch.object(self.db, "_execute_query", return_value=[mock_row]):
                response = self.db.get_comments_for_topic(topic="test")
        if response.results:
            assert response.results[0].content_type == "comment"


class TestWrapQueryFieldWithDialect:
    def setup_method(self):
        self.db = MediaCrawlerDB()

    def test_mysql_uses_backticks(self):
        with patch("InsightEngine.tools.search.settings") as mock_settings:
            mock_settings.DB_DIALECT = "mysql"
            result = self.db._wrap_query_field_with_dialect("field_name")
        assert result == "`field_name`"

    def test_postgresql_uses_double_quotes(self):
        with patch("InsightEngine.tools.search.settings") as mock_settings:
            mock_settings.DB_DIALECT = "postgresql"
            result = self.db._wrap_query_field_with_dialect("field_name")
        assert result == '"field_name"'


class TestPrintResponseSummary:
    def test_prints_error_message(self, caplog):
        response = DBResponse(
            tool_name="test_tool",
            parameters={},
            error_message="Something went wrong"
        )
        # Should not raise
        print_response_summary(response)

    def test_prints_results_summary(self, caplog):
        r = QueryResult(
            platform="bilibili",
            content_type="video",
            title_or_content="Test video title",
            author_nickname="creator",
            publish_time=datetime(2025, 1, 1),
        )
        response = DBResponse(
            tool_name="search_hot_content",
            parameters={"time_period": "week"},
            results=[r],
            results_count=1,
        )
        # Should not raise
        print_response_summary(response)

    def test_handles_empty_results(self, caplog):
        response = DBResponse(
            tool_name="search_topic_globally",
            parameters={"topic": "test"},
            results=[],
            results_count=0,
        )
        # Should not raise
        print_response_summary(response)
