"""
Unit tests for ReportEngine/utils/json_parser.py
"""

import pytest
import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ReportEngine.utils.json_parser import RobustJSONParser, JSONParseError


class TestJSONParseError:
    def test_is_value_error_subclass(self):
        assert issubclass(JSONParseError, ValueError)

    def test_message_preserved(self):
        err = JSONParseError("parse failed")
        assert str(err) == "parse failed"

    def test_raw_text_stored(self):
        err = JSONParseError("parse failed", raw_text="bad json")
        assert err.raw_text == "bad json"

    def test_raw_text_defaults_to_none(self):
        err = JSONParseError("parse failed")
        assert err.raw_text is None

    def test_can_be_raised_and_caught(self):
        with pytest.raises(JSONParseError) as exc_info:
            raise JSONParseError("test", raw_text="raw")
        assert exc_info.value.raw_text == "raw"


class TestRobustJSONParserInit:
    def test_default_init(self):
        parser = RobustJSONParser()
        assert parser.enable_llm_repair is False
        assert parser.max_repair_attempts == 3

    def test_custom_init(self):
        parser = RobustJSONParser(enable_llm_repair=True, max_repair_attempts=5)
        assert parser.enable_llm_repair is True
        assert parser.max_repair_attempts == 5

    def test_llm_repair_fn_stored(self):
        fn = lambda text, err: text
        parser = RobustJSONParser(llm_repair_fn=fn)
        assert parser.llm_repair_fn is fn


class TestCleanResponse:
    def setup_method(self):
        self.parser = RobustJSONParser()

    def test_strips_json_fenced_block(self):
        raw = '```json\n{"key": "value"}\n```'
        result = self.parser._clean_response(raw)
        assert result == '{"key": "value"}'

    def test_strips_plain_fenced_block(self):
        raw = '```\n{"key": "value"}\n```'
        result = self.parser._clean_response(raw)
        assert result == '{"key": "value"}'

    def test_plain_json_unchanged(self):
        raw = '{"key": "value"}'
        result = self.parser._clean_response(raw)
        assert result == raw

    def test_removes_thinking_tags(self):
        raw = '<thinking>Let me think...</thinking>\n{"key": "value"}'
        result = self.parser._clean_response(raw)
        assert "<thinking>" not in result
        assert '{"key": "value"}' in result

    def test_extracts_json_from_surrounding_text(self):
        raw = 'Here is the result: {"key": "value"} done.'
        result = self.parser._clean_response(raw)
        assert result == '{"key": "value"}'

    def test_extracts_array_from_surrounding_text(self):
        raw = 'Result: [1, 2, 3] end.'
        result = self.parser._clean_response(raw)
        assert result == '[1, 2, 3]'


class TestExtractFirstJsonStructure:
    def setup_method(self):
        self.parser = RobustJSONParser()

    def test_extracts_object(self):
        text = 'prefix {"a": 1} suffix'
        result = self.parser._extract_first_json_structure(text)
        assert result == '{"a": 1}'

    def test_extracts_array(self):
        text = 'prefix [1, 2, 3] suffix'
        result = self.parser._extract_first_json_structure(text)
        assert result == '[1, 2, 3]'

    def test_no_json_returns_original(self):
        text = 'no json here'
        result = self.parser._extract_first_json_structure(text)
        assert result == text

    def test_nested_object(self):
        text = '{"outer": {"inner": 42}}'
        result = self.parser._extract_first_json_structure(text)
        assert result == text

    def test_object_with_string_containing_braces(self):
        text = '{"key": "value with { brace }"}'
        result = self.parser._extract_first_json_structure(text)
        assert result == text

    def test_prefers_object_over_array_when_object_comes_first(self):
        text = '{"a": 1} [1, 2]'
        result = self.parser._extract_first_json_structure(text)
        assert result == '{"a": 1}'


class TestEscapeControlCharacters:
    def setup_method(self):
        self.parser = RobustJSONParser()

    def test_no_control_chars_unchanged(self):
        text = '{"key": "value"}'
        result, mutated = self.parser._escape_control_characters(text)
        assert result == text
        assert mutated is False

    def test_newline_in_string_escaped(self):
        text = '{"key": "line1\nline2"}'
        result, mutated = self.parser._escape_control_characters(text)
        assert mutated is True
        assert "\\n" in result

    def test_tab_in_string_escaped(self):
        text = '{"key": "col1\tcol2"}'
        result, mutated = self.parser._escape_control_characters(text)
        assert mutated is True
        assert "\\t" in result

    def test_newline_outside_string_not_escaped(self):
        text = '{\n"key": "value"\n}'
        result, mutated = self.parser._escape_control_characters(text)
        assert mutated is False

    def test_empty_string(self):
        result, mutated = self.parser._escape_control_characters("")
        assert result == ""
        assert mutated is False


class TestRemoveTrailingCommas:
    def setup_method(self):
        self.parser = RobustJSONParser()

    def test_removes_trailing_comma_in_object(self):
        text = '{"key": "value",}'
        result, mutated = self.parser._remove_trailing_commas(text)
        assert mutated is True
        assert result == '{"key": "value"}'

    def test_removes_trailing_comma_in_array(self):
        text = '[1, 2, 3,]'
        result, mutated = self.parser._remove_trailing_commas(text)
        assert mutated is True
        assert result == '[1, 2, 3]'

    def test_no_trailing_comma_unchanged(self):
        text = '{"key": "value"}'
        result, mutated = self.parser._remove_trailing_commas(text)
        assert mutated is False
        assert result == text

    def test_empty_string(self):
        result, mutated = self.parser._remove_trailing_commas("")
        assert result == ""
        assert mutated is False

    def test_multiple_trailing_commas(self):
        text = '{"a": 1, "b": 2,}'
        result, mutated = self.parser._remove_trailing_commas(text)
        assert mutated is True
        parsed = json.loads(result)
        assert parsed == {"a": 1, "b": 2}


class TestBalanceBrackets:
    def setup_method(self):
        self.parser = RobustJSONParser()

    def test_balanced_json_unchanged(self):
        text = '{"key": "value"}'
        result, mutated = self.parser._balance_brackets(text)
        assert mutated is False
        assert result == text

    def test_missing_closing_brace_added(self):
        text = '{"key": "value"'
        result, mutated = self.parser._balance_brackets(text)
        assert mutated is True
        assert result.endswith("}")

    def test_missing_closing_bracket_added(self):
        text = '[1, 2, 3'
        result, mutated = self.parser._balance_brackets(text)
        assert mutated is True
        assert result.endswith("]")

    def test_extra_closing_brace_removed(self):
        text = '{"key": "value"}}'
        result, mutated = self.parser._balance_brackets(text)
        assert mutated is True

    def test_empty_string(self):
        result, mutated = self.parser._balance_brackets("")
        assert result == ""
        assert mutated is False


class TestCollapseRedundantBrackets:
    def setup_method(self):
        self.parser = RobustJSONParser()

    def test_triple_closing_brackets_collapsed(self):
        text = '[[[1, 2]]]'
        result, mutated = self.parser._collapse_redundant_brackets(text)
        assert mutated is True
        assert "[[[" not in result

    def test_normal_brackets_unchanged(self):
        text = '[[1, 2], [3, 4]]'
        result, mutated = self.parser._collapse_redundant_brackets(text)
        assert mutated is False

    def test_empty_string(self):
        result, mutated = self.parser._collapse_redundant_brackets("")
        assert result == ""
        assert mutated is False


class TestParse:
    def setup_method(self):
        self.parser = RobustJSONParser()

    def test_parses_valid_json(self):
        result = self.parser.parse('{"key": "value"}')
        assert result == {"key": "value"}

    def test_parses_json_with_fenced_block(self):
        result = self.parser.parse('```json\n{"key": "value"}\n```')
        assert result["key"] == "value"

    def test_raises_on_empty_input(self):
        with pytest.raises(JSONParseError):
            self.parser.parse("")

    def test_raises_on_whitespace_only(self):
        with pytest.raises(JSONParseError):
            self.parser.parse("   ")

    def test_raises_on_unparseable_text(self):
        with pytest.raises(JSONParseError):
            self.parser.parse("this is definitely not json at all !!!")

    def test_parses_json_with_trailing_comma(self):
        result = self.parser.parse('{"key": "value",}')
        assert result["key"] == "value"

    def test_extracts_wrapper_key(self):
        result = self.parser.parse(
            '{"wrapper": {"key": "value"}}',
            extract_wrapper_key="wrapper"
        )
        assert result == {"key": "value"}

    def test_missing_wrapper_key_uses_original(self):
        result = self.parser.parse(
            '{"key": "value"}',
            extract_wrapper_key="nonexistent"
        )
        assert result == {"key": "value"}

    def test_expected_keys_warning_logged(self, caplog):
        # Should still return data even if expected keys are missing
        result = self.parser.parse(
            '{"key": "value"}',
            expected_keys=["key", "missing_key"]
        )
        assert result["key"] == "value"

    def test_array_with_dict_extracted(self):
        result = self.parser.parse('[{"key": "value"}]')
        assert result == {"key": "value"}

    def test_array_with_best_match_by_expected_keys(self):
        raw = '[{"a": 1}, {"a": 1, "b": 2}]'
        result = self.parser.parse(raw, expected_keys=["a", "b"])
        assert result.get("b") == 2

    def test_raises_on_empty_array(self):
        with pytest.raises(JSONParseError):
            self.parser.parse("[]")

    def test_raises_on_non_dict_non_array(self):
        with pytest.raises(JSONParseError):
            self.parser.parse('"just a string"')

    def test_context_name_in_error_message(self):
        with pytest.raises(JSONParseError) as exc_info:
            self.parser.parse("not json", context_name="MyContext")
        assert "MyContext" in str(exc_info.value)


class TestTryRecoverMissingKeys:
    def setup_method(self):
        self.parser = RobustJSONParser()

    def test_recovers_template_name_alias(self):
        data = {"templateName": "my_template"}
        result = self.parser._try_recover_missing_keys(data, ["template_name"], "test")
        assert result.get("template_name") == "my_template"

    def test_recovers_chapters_alias(self):
        data = {"chapterList": [1, 2, 3]}
        result = self.parser._try_recover_missing_keys(data, ["chapters"], "test")
        assert result.get("chapters") == [1, 2, 3]

    def test_no_alias_found_data_unchanged(self):
        data = {"unrelated": "value"}
        result = self.parser._try_recover_missing_keys(data, ["template_name"], "test")
        assert "template_name" not in result

    def test_unknown_missing_key_ignored(self):
        data = {"key": "value"}
        result = self.parser._try_recover_missing_keys(data, ["completely_unknown_key"], "test")
        assert result == {"key": "value"}


class TestLLMRepair:
    def test_llm_repair_called_when_enabled(self):
        repair_calls = []

        def mock_llm_repair(text, error):
            repair_calls.append((text, error))
            return '{"fixed": true}'

        parser = RobustJSONParser(
            llm_repair_fn=mock_llm_repair,
            enable_llm_repair=True,
            enable_json_repair=False,
        )
        result = parser.parse("not valid json at all !!!")
        assert result == {"fixed": True}
        assert len(repair_calls) == 1

    def test_llm_repair_not_called_when_disabled(self):
        repair_calls = []

        def mock_llm_repair(text, error):
            repair_calls.append(text)
            return '{"fixed": true}'

        parser = RobustJSONParser(
            llm_repair_fn=mock_llm_repair,
            enable_llm_repair=False,
            enable_json_repair=False,
        )
        with pytest.raises(JSONParseError):
            parser.parse("not valid json !!!")
        assert len(repair_calls) == 0

    def test_llm_repair_failure_raises_json_parse_error(self):
        def bad_repair(text, error):
            return "still not json"

        parser = RobustJSONParser(
            llm_repair_fn=bad_repair,
            enable_llm_repair=True,
            enable_json_repair=False,
        )
        with pytest.raises(JSONParseError):
            parser.parse("not valid json !!!")
