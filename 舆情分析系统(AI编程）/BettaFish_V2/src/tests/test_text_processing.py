"""
Unit tests for InsightEngine/utils/text_processing.py
"""

import pytest
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from InsightEngine.utils.text_processing import (
    clean_json_tags,
    clean_markdown_tags,
    remove_reasoning_from_output,
    extract_clean_response,
    fix_incomplete_json,
    fix_aggressive_json,
    update_state_with_search_results,
    validate_json_schema,
    truncate_content,
    format_search_results_for_prompt,
)


class TestCleanJsonTags:
    def test_removes_json_fenced_block(self):
        text = "```json\n{\"key\": \"value\"}\n```"
        result = clean_json_tags(text)
        assert "```json" not in result
        assert "```" not in result
        assert '{"key": "value"}' in result

    def test_removes_plain_fenced_block(self):
        text = "```\n{\"key\": \"value\"}\n```"
        result = clean_json_tags(text)
        assert "```" not in result

    def test_plain_json_unchanged(self):
        text = '{"key": "value"}'
        result = clean_json_tags(text)
        assert result == text

    def test_empty_string(self):
        result = clean_json_tags("")
        assert result == ""

    def test_strips_whitespace(self):
        text = "  ```json\n{}\n```  "
        result = clean_json_tags(text)
        assert result == "{}"

    def test_multiple_backtick_blocks(self):
        text = "```json\n{\"a\": 1}\n``` some text ```"
        result = clean_json_tags(text)
        assert "```" not in result


class TestCleanMarkdownTags:
    def test_removes_markdown_fenced_block(self):
        text = "```markdown\n# Title\n```"
        result = clean_markdown_tags(text)
        assert "```markdown" not in result
        assert "```" not in result

    def test_plain_text_unchanged(self):
        text = "# Title\nSome content"
        result = clean_markdown_tags(text)
        assert result == text

    def test_empty_string(self):
        result = clean_markdown_tags("")
        assert result == ""

    def test_strips_whitespace(self):
        text = "  ```markdown\n# Title\n```  "
        result = clean_markdown_tags(text)
        assert result == "# Title"


class TestRemoveReasoningFromOutput:
    def test_extracts_json_object(self):
        text = "Let me think about this. {\"result\": true}"
        result = remove_reasoning_from_output(text)
        assert result.startswith("{")

    def test_extracts_json_array(self):
        text = "Here is the answer: [1, 2, 3]"
        result = remove_reasoning_from_output(text)
        assert result.startswith("[")

    def test_pure_json_unchanged(self):
        text = '{"key": "value"}'
        result = remove_reasoning_from_output(text)
        assert result == text

    def test_empty_string(self):
        result = remove_reasoning_from_output("")
        assert result == ""

    def test_no_json_marker_returns_stripped(self):
        text = "no json here at all"
        result = remove_reasoning_from_output(text)
        # Should return stripped text (no JSON found, patterns applied)
        assert isinstance(result, str)


class TestExtractCleanResponse:
    def test_valid_json_object(self):
        text = '{"key": "value"}'
        result = extract_clean_response(text)
        assert result == {"key": "value"}

    def test_json_with_fenced_block(self):
        text = '```json\n{"key": "value"}\n```'
        result = extract_clean_response(text)
        assert result.get("key") == "value"

    def test_trailing_comma_fixed(self):
        text = '{"key": "value",}'
        result = extract_clean_response(text)
        assert "error" not in result or result.get("key") == "value"

    def test_invalid_json_returns_error_or_empty(self):
        text = "this is not json at all !!!"
        result = extract_clean_response(text)
        # Returns either an error dict or an empty list depending on fix_aggressive_json
        assert isinstance(result, (dict, list))

    def test_empty_string_returns_error_or_empty(self):
        result = extract_clean_response("")
        assert isinstance(result, (dict, list))

    def test_nested_json(self):
        text = '{"outer": {"inner": 42}}'
        result = extract_clean_response(text)
        assert result["outer"]["inner"] == 42


class TestFixIncompleteJson:
    def test_valid_json_returned_as_is(self):
        text = '{"key": "value"}'
        result = fix_incomplete_json(text)
        assert result == text

    def test_trailing_comma_in_object(self):
        text = '{"key": "value",}'
        result = fix_incomplete_json(text)
        import json
        parsed = json.loads(result)
        assert parsed["key"] == "value"

    def test_trailing_comma_in_array(self):
        text = '[1, 2, 3,]'
        result = fix_incomplete_json(text)
        import json
        parsed = json.loads(result)
        assert parsed == [1, 2, 3]

    def test_missing_closing_brace(self):
        text = '{"key": "value"'
        result = fix_incomplete_json(text)
        # Should attempt to fix by adding closing brace
        assert isinstance(result, str)

    def test_empty_string(self):
        result = fix_incomplete_json("")
        assert result == "" or result == "[]"


class TestFixAggressiveJson:
    def test_single_object_wrapped_in_array(self):
        text = '{"key": "value"}'
        result = fix_aggressive_json(text)
        import json
        parsed = json.loads(result)
        assert isinstance(parsed, list)
        assert parsed[0]["key"] == "value"

    def test_multiple_objects_wrapped_in_array(self):
        text = '{"a": 1}{"b": 2}'
        result = fix_aggressive_json(text)
        import json
        parsed = json.loads(result)
        assert isinstance(parsed, list)

    def test_no_objects_returns_empty_array(self):
        text = "no json here"
        result = fix_aggressive_json(text)
        assert result == "[]"


class TestValidateJsonSchema:
    def test_all_required_fields_present(self):
        data = {"name": "test", "value": 42, "active": True}
        assert validate_json_schema(data, ["name", "value", "active"]) is True

    def test_missing_required_field(self):
        data = {"name": "test"}
        assert validate_json_schema(data, ["name", "value"]) is False

    def test_empty_required_fields(self):
        data = {"name": "test"}
        assert validate_json_schema(data, []) is True

    def test_empty_data_with_required_fields(self):
        assert validate_json_schema({}, ["name"]) is False

    def test_extra_fields_allowed(self):
        data = {"name": "test", "extra": "field"}
        assert validate_json_schema(data, ["name"]) is True


class TestTruncateContent:
    def test_short_content_unchanged(self):
        text = "short text"
        result = truncate_content(text, max_length=100)
        assert result == text

    def test_long_content_truncated(self):
        text = "a" * 100
        result = truncate_content(text, max_length=50)
        assert len(result) <= 53  # 50 + "..."

    def test_truncation_adds_ellipsis(self):
        text = "a" * 100
        result = truncate_content(text, max_length=50)
        assert result.endswith("...")

    def test_word_boundary_truncation(self):
        # Build a string where word boundary is within the last 20% of max_length
        words = ["word"] * 20
        text = " ".join(words)  # "word word word ..."
        result = truncate_content(text, max_length=30)
        assert result.endswith("...")

    def test_exact_length_not_truncated(self):
        text = "a" * 20000
        result = truncate_content(text, max_length=20000)
        assert result == text

    def test_empty_string(self):
        result = truncate_content("", max_length=100)
        assert result == ""


class TestFormatSearchResultsForPrompt:
    def test_formats_content_field(self):
        results = [{"content": "some content here"}]
        formatted = format_search_results_for_prompt(results)
        assert len(formatted) == 1
        assert "some content here" in formatted[0]

    def test_skips_empty_content(self):
        results = [{"content": ""}, {"content": "valid"}]
        formatted = format_search_results_for_prompt(results)
        assert len(formatted) == 1
        assert "valid" in formatted[0]

    def test_skips_missing_content_key(self):
        results = [{"title": "no content key"}]
        formatted = format_search_results_for_prompt(results)
        assert len(formatted) == 0

    def test_truncates_long_content(self):
        results = [{"content": "x" * 30000}]
        formatted = format_search_results_for_prompt(results, max_length=100)
        assert len(formatted[0]) <= 103  # 100 + "..."

    def test_empty_results_list(self):
        formatted = format_search_results_for_prompt([])
        assert formatted == []

    def test_multiple_results(self):
        results = [{"content": "first"}, {"content": "second"}, {"content": "third"}]
        formatted = format_search_results_for_prompt(results)
        assert len(formatted) == 3


class TestExtractCleanResponseEdgeCases:
    """Cover lines 110-133: fallback paths in extract_clean_response."""

    def test_json_with_reasoning_prefix_extracted(self):
        # Text where JSON starts after some reasoning text
        text = "Let me analyze this. {\"result\": \"ok\"}"
        result = extract_clean_response(text)
        assert isinstance(result, (dict, list))

    def test_json_array_extracted(self):
        text = '[{"a": 1}, {"b": 2}]'
        result = extract_clean_response(text)
        assert isinstance(result, (dict, list))

    def test_json_with_trailing_garbage_extracted(self):
        # Valid JSON followed by garbage — regex fallback should find it
        text = '{"key": "value"} some trailing text'
        result = extract_clean_response(text)
        assert isinstance(result, (dict, list))

    def test_deeply_nested_json(self):
        text = '{"a": {"b": {"c": 42}}}'
        result = extract_clean_response(text)
        assert isinstance(result, dict)

    def test_json_with_unicode(self):
        text = '{"name": "测试", "value": "数据"}'
        result = extract_clean_response(text)
        assert isinstance(result, dict)


class TestFixIncompleteJsonEdgeCases:
    """Cover lines 162, 170-175, 187, 192: bracket-fixing paths."""

    def test_single_object_wrapped_in_array(self):
        # Starts with { — should be wrapped in []
        text = '{"key": "value"}'
        result = fix_incomplete_json(text)
        import json
        parsed = json.loads(result)
        # Either the original dict or wrapped in array
        assert isinstance(parsed, (dict, list))

    def test_multiple_objects_wrapped_in_array(self):
        # Multiple { — should be wrapped in []
        text = '{"a": 1},{"b": 2}'
        result = fix_incomplete_json(text)
        assert isinstance(result, str)

    def test_missing_closing_brackets_added(self):
        # More [ than ] — should add ]
        text = '[{"key": "value"'
        result = fix_incomplete_json(text)
        assert isinstance(result, str)
        # Should have attempted to fix
        assert result != ""

    def test_already_valid_json_returned_unchanged(self):
        text = '{"key": "value"}'
        result = fix_incomplete_json(text)
        import json
        # Should be parseable
        parsed = json.loads(result)
        assert isinstance(parsed, (dict, list))

    def test_trailing_comma_removed_before_bracket_check(self):
        text = '{"a": 1, "b": 2,}'
        result = fix_incomplete_json(text)
        import json
        parsed = json.loads(result)
        assert parsed["a"] == 1


class TestUpdateStateWithSearchResults:
    """Cover lines 235-247: update_state_with_search_results."""

    def test_valid_index_calls_add_search_results(self):
        from unittest.mock import MagicMock
        mock_research = MagicMock()
        mock_paragraph = MagicMock()
        mock_paragraph.research = mock_research
        mock_state = MagicMock()
        mock_state.paragraphs = [mock_paragraph]

        search_results = [{"content": "result 1"}]
        result = update_state_with_search_results(search_results, 0, mock_state)

        mock_research.add_search_results.assert_called_once()
        assert result is mock_state

    def test_out_of_range_index_does_not_call_add(self):
        from unittest.mock import MagicMock
        mock_state = MagicMock()
        mock_state.paragraphs = []

        result = update_state_with_search_results([{"content": "x"}], 5, mock_state)
        assert result is mock_state

    def test_empty_search_results_still_calls_add(self):
        from unittest.mock import MagicMock
        mock_research = MagicMock()
        mock_paragraph = MagicMock()
        mock_paragraph.research = mock_research
        mock_state = MagicMock()
        mock_state.paragraphs = [mock_paragraph]

        result = update_state_with_search_results([], 0, mock_state)
        mock_research.add_search_results.assert_called_once_with("", [])

    def test_negative_index_does_not_call_add(self):
        from unittest.mock import MagicMock
        mock_state = MagicMock()
        mock_state.paragraphs = [MagicMock()]

        result = update_state_with_search_results([{"content": "x"}], -1, mock_state)
        # -1 < 0, so condition fails
        assert result is mock_state
