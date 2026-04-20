"""
Unit tests for ReportEngine/ir/validator.py
"""

import pytest
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ReportEngine.ir.validator import IRValidator


def make_paragraph(text="some text"):
    return {"type": "paragraph", "inlines": [{"text": text}]}


def make_heading(level=1, text="Title", anchor="title"):
    return {"type": "heading", "level": level, "text": text, "anchor": anchor}


def make_valid_chapter(**overrides):
    chapter = {
        "chapterId": "ch1",
        "title": "Chapter One",
        "anchor": "chapter-one",
        "order": 1,
        "blocks": [make_paragraph()],
    }
    chapter.update(overrides)
    return chapter


class TestIRValidatorInit:
    def test_default_schema_version(self):
        v = IRValidator()
        assert v.schema_version == "1.0"

    def test_custom_schema_version(self):
        v = IRValidator(schema_version="2.0")
        assert v.schema_version == "2.0"


class TestValidateChapter:
    def setup_method(self):
        self.v = IRValidator()

    def test_valid_chapter_passes(self):
        ok, errors = self.v.validate_chapter(make_valid_chapter())
        assert ok is True
        assert errors == []

    def test_non_dict_chapter_fails(self):
        ok, errors = self.v.validate_chapter("not a dict")
        assert ok is False
        assert any("必须是对象" in e for e in errors)

    def test_missing_chapter_id(self):
        chapter = make_valid_chapter()
        del chapter["chapterId"]
        ok, errors = self.v.validate_chapter(chapter)
        assert ok is False
        assert any("chapterId" in e for e in errors)

    def test_missing_title(self):
        chapter = make_valid_chapter()
        del chapter["title"]
        ok, errors = self.v.validate_chapter(chapter)
        assert ok is False
        assert any("title" in e for e in errors)

    def test_missing_anchor(self):
        chapter = make_valid_chapter()
        del chapter["anchor"]
        ok, errors = self.v.validate_chapter(chapter)
        assert ok is False
        assert any("anchor" in e for e in errors)

    def test_missing_order(self):
        chapter = make_valid_chapter()
        del chapter["order"]
        ok, errors = self.v.validate_chapter(chapter)
        assert ok is False
        assert any("order" in e for e in errors)

    def test_empty_blocks_fails(self):
        chapter = make_valid_chapter(blocks=[])
        ok, errors = self.v.validate_chapter(chapter)
        assert ok is False
        assert any("blocks" in e for e in errors)

    def test_blocks_not_list_fails(self):
        chapter = make_valid_chapter(blocks="not a list")
        ok, errors = self.v.validate_chapter(chapter)
        assert ok is False

    def test_multiple_valid_blocks(self):
        chapter = make_valid_chapter(blocks=[
            make_heading(),
            make_paragraph("first"),
            make_paragraph("second"),
        ])
        ok, errors = self.v.validate_chapter(chapter)
        assert ok is True


class TestValidateHeadingBlock:
    def setup_method(self):
        self.v = IRValidator()

    def test_valid_heading(self):
        errors = []
        self.v._validate_heading_block(
            {"type": "heading", "level": 2, "text": "Hello", "anchor": "hello"},
            "blocks[0]", errors
        )
        assert errors == []

    def test_missing_level(self):
        errors = []
        self.v._validate_heading_block(
            {"type": "heading", "text": "Hello", "anchor": "hello"},
            "blocks[0]", errors
        )
        assert any("level" in e for e in errors)

    def test_non_int_level(self):
        errors = []
        self.v._validate_heading_block(
            {"type": "heading", "level": "2", "text": "Hello", "anchor": "hello"},
            "blocks[0]", errors
        )
        assert any("level" in e for e in errors)

    def test_missing_text(self):
        errors = []
        self.v._validate_heading_block(
            {"type": "heading", "level": 1, "anchor": "hello"},
            "blocks[0]", errors
        )
        assert any("text" in e for e in errors)

    def test_missing_anchor(self):
        errors = []
        self.v._validate_heading_block(
            {"type": "heading", "level": 1, "text": "Hello"},
            "blocks[0]", errors
        )
        assert any("anchor" in e for e in errors)


class TestValidateParagraphBlock:
    def setup_method(self):
        self.v = IRValidator()

    def test_valid_paragraph(self):
        errors = []
        self.v._validate_paragraph_block(
            {"type": "paragraph", "inlines": [{"text": "hello"}]},
            "blocks[0]", errors
        )
        assert errors == []

    def test_empty_inlines_fails(self):
        errors = []
        self.v._validate_paragraph_block(
            {"type": "paragraph", "inlines": []},
            "blocks[0]", errors
        )
        assert any("inlines" in e for e in errors)

    def test_missing_inlines_fails(self):
        errors = []
        self.v._validate_paragraph_block(
            {"type": "paragraph"},
            "blocks[0]", errors
        )
        assert any("inlines" in e for e in errors)

    def test_inline_missing_text_fails(self):
        errors = []
        self.v._validate_paragraph_block(
            {"type": "paragraph", "inlines": [{"marks": []}]},
            "blocks[0]", errors
        )
        assert any("text" in e for e in errors)

    def test_valid_inline_with_marks(self):
        errors = []
        self.v._validate_paragraph_block(
            {"type": "paragraph", "inlines": [{"text": "hi", "marks": [{"type": "bold"}]}]},
            "blocks[0]", errors
        )
        assert errors == []

    def test_invalid_mark_type(self):
        errors = []
        self.v._validate_paragraph_block(
            {"type": "paragraph", "inlines": [{"text": "hi", "marks": [{"type": "invalid_mark"}]}]},
            "blocks[0]", errors
        )
        assert any("invalid_mark" in e for e in errors)


class TestValidateListBlock:
    def setup_method(self):
        self.v = IRValidator()

    def test_valid_bullet_list(self):
        errors = []
        self.v._validate_list_block(
            {"type": "list", "listType": "bullet", "items": [[make_paragraph("item 1")]]},
            "blocks[0]", errors
        )
        assert errors == []

    def test_valid_ordered_list(self):
        errors = []
        self.v._validate_list_block(
            {"type": "list", "listType": "ordered", "items": [[make_paragraph("item")]]},
            "blocks[0]", errors
        )
        assert errors == []

    def test_invalid_list_type(self):
        errors = []
        self.v._validate_list_block(
            {"type": "list", "listType": "invalid", "items": [[make_paragraph()]]},
            "blocks[0]", errors
        )
        assert any("listType" in e for e in errors)

    def test_empty_items_fails(self):
        errors = []
        self.v._validate_list_block(
            {"type": "list", "listType": "bullet", "items": []},
            "blocks[0]", errors
        )
        assert any("items" in e for e in errors)

    def test_item_not_list_fails(self):
        errors = []
        self.v._validate_list_block(
            {"type": "list", "listType": "bullet", "items": ["not a list"]},
            "blocks[0]", errors
        )
        assert any("区块数组" in e for e in errors)


class TestValidateTableBlock:
    def setup_method(self):
        self.v = IRValidator()

    def _make_table(self):
        return {
            "type": "table",
            "rows": [
                {"cells": [{"blocks": [make_paragraph("cell")]}]}
            ]
        }

    def test_valid_table(self):
        errors = []
        self.v._validate_table_block(self._make_table(), "blocks[0]", errors)
        assert errors == []

    def test_empty_rows_fails(self):
        errors = []
        self.v._validate_table_block({"type": "table", "rows": []}, "blocks[0]", errors)
        assert any("rows" in e for e in errors)

    def test_row_without_cells_fails(self):
        errors = []
        self.v._validate_table_block(
            {"type": "table", "rows": [{"no_cells": True}]},
            "blocks[0]", errors
        )
        assert any("cells" in e for e in errors)

    def test_cell_without_blocks_fails(self):
        errors = []
        self.v._validate_table_block(
            {"type": "table", "rows": [{"cells": [{"no_blocks": True}]}]},
            "blocks[0]", errors
        )
        assert any("blocks" in e for e in errors)


class TestValidateSwotBlock:
    def setup_method(self):
        self.v = IRValidator()

    def test_valid_swot_with_strengths(self):
        errors = []
        self.v._validate_swotTable_block(
            {"type": "swotTable", "strengths": ["Strong brand"]},
            "blocks[0]", errors
        )
        assert errors == []

    def test_swot_with_no_quadrants_fails(self):
        errors = []
        self.v._validate_swotTable_block(
            {"type": "swotTable"},
            "blocks[0]", errors
        )
        assert len(errors) > 0

    def test_swot_item_string_valid(self):
        errors = []
        self.v._validate_swot_item("Good item", "path", errors)
        assert errors == []

    def test_swot_item_empty_string_fails(self):
        errors = []
        self.v._validate_swot_item("   ", "path", errors)
        assert len(errors) > 0

    def test_swot_item_dict_with_title(self):
        errors = []
        self.v._validate_swot_item({"title": "Strong brand", "impact": "高"}, "path", errors)
        assert errors == []

    def test_swot_item_invalid_impact(self):
        errors = []
        self.v._validate_swot_item({"title": "item", "impact": "very high"}, "path", errors)
        assert any("impact" in e for e in errors)

    def test_swot_item_valid_impact_values(self):
        for impact in ("低", "中低", "中", "中高", "高", "极高"):
            errors = []
            self.v._validate_swot_item({"title": "item", "impact": impact}, "path", errors)
            assert errors == [], f"impact={impact} should be valid"

    def test_swot_item_dict_without_text_field_fails(self):
        errors = []
        self.v._validate_swot_item({"score": 5}, "path", errors)
        assert any("title" in e or "label" in e or "text" in e for e in errors)


class TestValidateCalloutBlock:
    def setup_method(self):
        self.v = IRValidator()

    def test_valid_callout(self):
        errors = []
        self.v._validate_callout_block(
            {"type": "callout", "tone": "info", "blocks": [make_paragraph()]},
            "blocks[0]", errors
        )
        assert errors == []

    def test_invalid_tone(self):
        errors = []
        self.v._validate_callout_block(
            {"type": "callout", "tone": "unknown", "blocks": [make_paragraph()]},
            "blocks[0]", errors
        )
        assert any("tone" in e for e in errors)

    def test_empty_blocks_fails(self):
        errors = []
        self.v._validate_callout_block(
            {"type": "callout", "tone": "warning", "blocks": []},
            "blocks[0]", errors
        )
        assert any("blocks" in e for e in errors)

    def test_all_valid_tones(self):
        for tone in ("info", "warning", "success", "danger"):
            errors = []
            self.v._validate_callout_block(
                {"type": "callout", "tone": tone, "blocks": [make_paragraph()]},
                "blocks[0]", errors
            )
            assert errors == [], f"tone={tone} should be valid"


class TestValidateKpiGridBlock:
    def setup_method(self):
        self.v = IRValidator()

    def test_valid_kpi_grid(self):
        errors = []
        self.v._validate_kpiGrid_block(
            {"type": "kpiGrid", "items": [{"label": "Revenue", "value": "$1M"}]},
            "blocks[0]", errors
        )
        assert errors == []

    def test_empty_items_fails(self):
        errors = []
        self.v._validate_kpiGrid_block(
            {"type": "kpiGrid", "items": []},
            "blocks[0]", errors
        )
        assert any("items" in e for e in errors)

    def test_item_missing_label_fails(self):
        errors = []
        self.v._validate_kpiGrid_block(
            {"type": "kpiGrid", "items": [{"value": "$1M"}]},
            "blocks[0]", errors
        )
        assert any("label" in e for e in errors)

    def test_item_missing_value_fails(self):
        errors = []
        self.v._validate_kpiGrid_block(
            {"type": "kpiGrid", "items": [{"label": "Revenue"}]},
            "blocks[0]", errors
        )
        assert any("value" in e for e in errors)


class TestValidateWidgetBlock:
    def setup_method(self):
        self.v = IRValidator()

    def test_valid_widget_with_data(self):
        errors = []
        self.v._validate_widget_block(
            {"type": "widget", "widgetId": "w1", "widgetType": "chart", "data": {}},
            "blocks[0]", errors
        )
        assert errors == []

    def test_valid_widget_with_data_ref(self):
        errors = []
        self.v._validate_widget_block(
            {"type": "widget", "widgetId": "w1", "widgetType": "chart", "dataRef": "ref1"},
            "blocks[0]", errors
        )
        assert errors == []

    def test_missing_widget_id_fails(self):
        errors = []
        self.v._validate_widget_block(
            {"type": "widget", "widgetType": "chart", "data": {}},
            "blocks[0]", errors
        )
        assert any("widgetId" in e for e in errors)

    def test_missing_widget_type_fails(self):
        errors = []
        self.v._validate_widget_block(
            {"type": "widget", "widgetId": "w1", "data": {}},
            "blocks[0]", errors
        )
        assert any("widgetType" in e for e in errors)

    def test_missing_data_and_data_ref_fails(self):
        errors = []
        self.v._validate_widget_block(
            {"type": "widget", "widgetId": "w1", "widgetType": "chart"},
            "blocks[0]", errors
        )
        assert any("data" in e for e in errors)


class TestValidateCodeBlock:
    def setup_method(self):
        self.v = IRValidator()

    def test_valid_code_block(self):
        errors = []
        self.v._validate_code_block(
            {"type": "code", "content": "print('hello')"},
            "blocks[0]", errors
        )
        assert errors == []

    def test_missing_content_fails(self):
        errors = []
        self.v._validate_code_block(
            {"type": "code"},
            "blocks[0]", errors
        )
        assert any("content" in e for e in errors)


class TestValidateMathBlock:
    def setup_method(self):
        self.v = IRValidator()

    def test_valid_math_block(self):
        errors = []
        self.v._validate_math_block(
            {"type": "math", "latex": "E = mc^2"},
            "blocks[0]", errors
        )
        assert errors == []

    def test_missing_latex_fails(self):
        errors = []
        self.v._validate_math_block(
            {"type": "math"},
            "blocks[0]", errors
        )
        assert any("latex" in e for e in errors)


class TestValidateFigureBlock:
    def setup_method(self):
        self.v = IRValidator()

    def test_valid_figure(self):
        errors = []
        self.v._validate_figure_block(
            {"type": "figure", "img": {"src": "image.png"}},
            "blocks[0]", errors
        )
        assert errors == []

    def test_missing_img_fails(self):
        errors = []
        self.v._validate_figure_block(
            {"type": "figure"},
            "blocks[0]", errors
        )
        assert any("img" in e for e in errors)

    def test_img_not_dict_fails(self):
        errors = []
        self.v._validate_figure_block(
            {"type": "figure", "img": "not a dict"},
            "blocks[0]", errors
        )
        assert any("img" in e for e in errors)

    def test_img_missing_src_fails(self):
        errors = []
        self.v._validate_figure_block(
            {"type": "figure", "img": {"alt": "no src"}},
            "blocks[0]", errors
        )
        assert any("src" in e for e in errors)


class TestValidateEngineQuoteBlock:
    def setup_method(self):
        self.v = IRValidator()

    def test_valid_insight_engine_quote(self):
        errors = []
        self.v._validate_engineQuote_block(
            {
                "type": "engineQuote",
                "engine": "insight",
                "title": "Insight Agent",
                "blocks": [{"type": "paragraph", "inlines": [{"text": "analysis"}]}]
            },
            "blocks[0]", errors
        )
        assert errors == []

    def test_invalid_engine_value(self):
        errors = []
        self.v._validate_engineQuote_block(
            {
                "type": "engineQuote",
                "engine": "unknown",
                "title": "Unknown Agent",
                "blocks": [{"type": "paragraph", "inlines": [{"text": "text"}]}]
            },
            "blocks[0]", errors
        )
        assert any("engine" in e for e in errors)

    def test_wrong_title_for_engine(self):
        errors = []
        self.v._validate_engineQuote_block(
            {
                "type": "engineQuote",
                "engine": "insight",
                "title": "Wrong Title",
                "blocks": [{"type": "paragraph", "inlines": [{"text": "text"}]}]
            },
            "blocks[0]", errors
        )
        assert any("title" in e for e in errors)

    def test_missing_title_fails(self):
        errors = []
        self.v._validate_engineQuote_block(
            {
                "type": "engineQuote",
                "engine": "media",
                "blocks": [{"type": "paragraph", "inlines": [{"text": "text"}]}]
            },
            "blocks[0]", errors
        )
        assert any("title" in e for e in errors)

    def test_sub_block_must_be_paragraph(self):
        errors = []
        self.v._validate_engineQuote_block(
            {
                "type": "engineQuote",
                "engine": "query",
                "title": "Query Agent",
                "blocks": [{"type": "heading", "level": 1, "text": "h", "anchor": "h"}]
            },
            "blocks[0]", errors
        )
        assert any("paragraph" in e for e in errors)


class TestValidateBlockType:
    def setup_method(self):
        self.v = IRValidator()

    def test_unknown_block_type_fails(self):
        errors = []
        self.v._validate_block({"type": "unknownType"}, "blocks[0]", errors)
        assert any("不被支持" in e for e in errors)

    def test_non_dict_block_fails(self):
        errors = []
        self.v._validate_block("not a dict", "blocks[0]", errors)
        assert any("必须是对象" in e for e in errors)

    def test_hr_block_passes_without_extra_validation(self):
        errors = []
        self.v._validate_block({"type": "hr"}, "blocks[0]", errors)
        assert errors == []
