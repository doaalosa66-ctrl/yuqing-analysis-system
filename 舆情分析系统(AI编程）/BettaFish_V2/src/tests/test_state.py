"""
Unit tests for InsightEngine/state/state.py - 状态管理模块 (模块 3.5)
+ ReportEngine/state/state.py - 报告状态管理
"""

import pytest
import sys
import os
import json
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from InsightEngine.state.state import Search, Research, Paragraph, State


# ==================== Search 数据类 ====================

class TestSearch:
    def test_default_values(self):
        s = Search()
        assert s.query == ""
        assert s.url == ""
        assert s.title == ""
        assert s.content == ""
        assert s.score is None
        assert s.timestamp != ""

    def test_to_dict(self):
        s = Search(query="test", url="http://example.com", title="Title")
        d = s.to_dict()
        assert d["query"] == "test"
        assert d["url"] == "http://example.com"
        assert d["title"] == "Title"
        assert "timestamp" in d

    def test_from_dict(self):
        data = {"query": "q", "url": "u", "title": "t", "content": "c", "score": 0.9}
        s = Search.from_dict(data)
        assert s.query == "q"
        assert s.score == 0.9

    def test_from_dict_missing_fields(self):
        s = Search.from_dict({})
        assert s.query == ""
        assert s.score is None

    def test_roundtrip(self):
        original = Search(query="test", url="http://x.com", title="T", content="C", score=0.8)
        restored = Search.from_dict(original.to_dict())
        assert restored.query == original.query
        assert restored.score == original.score


# ==================== Research 数据类 ====================

class TestResearch:
    def test_default_values(self):
        r = Research()
        assert r.search_history == []
        assert r.latest_summary == ""
        assert r.reflection_iteration == 0
        assert r.is_completed is False

    def test_add_search(self):
        r = Research()
        s = Search(query="test")
        r.add_search(s)
        assert r.get_search_count() == 1

    def test_add_search_results(self):
        r = Research()
        results = [
            {"url": "http://a.com", "title": "A", "content": "a"},
            {"url": "http://b.com", "title": "B", "content": "b"},
        ]
        r.add_search_results("query", results)
        assert r.get_search_count() == 2

    def test_increment_reflection(self):
        r = Research()
        r.increment_reflection()
        r.increment_reflection()
        assert r.reflection_iteration == 2

    def test_mark_completed(self):
        r = Research()
        r.mark_completed()
        assert r.is_completed is True

    def test_to_dict_and_from_dict(self):
        r = Research()
        r.add_search(Search(query="q1"))
        r.latest_summary = "summary"
        r.reflection_iteration = 2
        restored = Research.from_dict(r.to_dict())
        assert restored.get_search_count() == 1
        assert restored.latest_summary == "summary"
        assert restored.reflection_iteration == 2


# ==================== Paragraph 数据类 ====================

class TestParagraph:
    def test_default_not_completed(self):
        p = Paragraph()
        assert p.is_completed() is False

    def test_completed_when_research_done_and_has_summary(self):
        p = Paragraph()
        p.research.mark_completed()
        p.research.latest_summary = "done"
        assert p.is_completed() is True

    def test_not_completed_without_summary(self):
        p = Paragraph()
        p.research.mark_completed()
        assert p.is_completed() is False

    def test_get_final_content_prefers_summary(self):
        p = Paragraph(content="original")
        p.research.latest_summary = "refined"
        assert p.get_final_content() == "refined"

    def test_get_final_content_falls_back_to_content(self):
        p = Paragraph(content="original")
        assert p.get_final_content() == "original"

    def test_to_dict_and_from_dict(self):
        p = Paragraph(title="T", content="C", order=1)
        restored = Paragraph.from_dict(p.to_dict())
        assert restored.title == "T"
        assert restored.order == 1


# ==================== State 数据类 ====================

class TestState:
    def test_default_values(self):
        s = State()
        assert s.query == ""
        assert s.paragraphs == []
        assert s.is_completed is False

    def test_add_paragraph(self):
        s = State(query="test")
        idx = s.add_paragraph("Title1", "Content1")
        assert idx == 0
        assert s.get_total_paragraphs_count() == 1

    def test_get_paragraph(self):
        s = State()
        s.add_paragraph("T", "C")
        p = s.get_paragraph(0)
        assert p is not None
        assert p.title == "T"

    def test_get_paragraph_out_of_range(self):
        s = State()
        assert s.get_paragraph(99) is None

    def test_completed_paragraphs_count(self):
        s = State()
        s.add_paragraph("T1", "C1")
        s.add_paragraph("T2", "C2")
        s.paragraphs[0].research.mark_completed()
        s.paragraphs[0].research.latest_summary = "done"
        assert s.get_completed_paragraphs_count() == 1

    def test_is_all_paragraphs_completed(self):
        s = State()
        s.add_paragraph("T1", "C1")
        assert s.is_all_paragraphs_completed() is False
        s.paragraphs[0].research.mark_completed()
        s.paragraphs[0].research.latest_summary = "done"
        assert s.is_all_paragraphs_completed() is True

    def test_empty_state_not_all_completed(self):
        s = State()
        assert s.is_all_paragraphs_completed() is False

    def test_mark_completed(self):
        s = State()
        s.mark_completed()
        assert s.is_completed is True

    def test_progress_summary(self):
        s = State()
        s.add_paragraph("T1", "C1")
        s.add_paragraph("T2", "C2")
        summary = s.get_progress_summary()
        assert summary["total_paragraphs"] == 2
        assert summary["completed_paragraphs"] == 0
        assert summary["progress_percentage"] == 0

    def test_to_json_and_from_json(self):
        s = State(query="test query", report_title="Report")
        s.add_paragraph("T1", "C1")
        json_str = s.to_json()
        restored = State.from_json(json_str)
        assert restored.query == "test query"
        assert restored.get_total_paragraphs_count() == 1

    def test_save_and_load_file(self, tmp_path):
        filepath = str(tmp_path / "state.json")
        s = State(query="file test")
        s.add_paragraph("T", "C")
        s.save_to_file(filepath)
        loaded = State.load_from_file(filepath)
        assert loaded.query == "file test"
        assert loaded.get_total_paragraphs_count() == 1

    def test_to_dict_contains_all_fields(self):
        s = State(query="q", report_title="r")
        d = s.to_dict()
        assert "query" in d
        assert "report_title" in d
        assert "paragraphs" in d
        assert "final_report" in d
        assert "is_completed" in d
        assert "created_at" in d
        assert "updated_at" in d
