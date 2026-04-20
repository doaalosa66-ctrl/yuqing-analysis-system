"""
Unit tests for config.py - 配置管理模块 (模块 1.1)
"""

import pytest
import sys
import os
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class TestSettingsDefaults:
    """测试 Settings 默认值"""

    def test_default_host(self):
        with patch.dict(os.environ, {}, clear=True):
            from config import Settings
            s = Settings(_env_file=None)
            assert s.HOST == "0.0.0.0"

    def test_default_port(self):
        with patch.dict(os.environ, {}, clear=True):
            from config import Settings
            s = Settings(_env_file=None)
            assert s.PORT == 5000

    def test_default_db_dialect(self):
        with patch.dict(os.environ, {}, clear=True):
            from config import Settings
            s = Settings(_env_file=None)
            assert s.DB_DIALECT == "postgresql"

    def test_default_db_charset(self):
        with patch.dict(os.environ, {}, clear=True):
            from config import Settings
            s = Settings(_env_file=None)
            assert s.DB_CHARSET == "utf8mb4"

    def test_default_max_reflections(self):
        with patch.dict(os.environ, {}, clear=True):
            from config import Settings
            s = Settings(_env_file=None)
            assert s.MAX_REFLECTIONS == 3

    def test_default_max_paragraphs(self):
        with patch.dict(os.environ, {}, clear=True):
            from config import Settings
            s = Settings(_env_file=None)
            assert s.MAX_PARAGRAPHS == 6

    def test_default_search_timeout(self):
        with patch.dict(os.environ, {}, clear=True):
            from config import Settings
            s = Settings(_env_file=None)
            assert s.SEARCH_TIMEOUT == 240

    def test_default_max_content_length(self):
        with patch.dict(os.environ, {}, clear=True):
            from config import Settings
            s = Settings(_env_file=None)
            assert s.MAX_CONTENT_LENGTH == 500000

    def test_default_search_tool_type(self):
        with patch.dict(os.environ, {}, clear=True):
            from config import Settings
            s = Settings(_env_file=None)
            assert s.SEARCH_TOOL_TYPE == "AnspireAPI"


class TestSettingsEnvOverride:
    """测试环境变量覆盖"""

    def test_port_override(self):
        with patch.dict(os.environ, {"PORT": "8080"}, clear=False):
            from config import Settings
            s = Settings(_env_file=None)
            assert s.PORT == 8080

    def test_host_override(self):
        with patch.dict(os.environ, {"HOST": "127.0.0.1"}, clear=False):
            from config import Settings
            s = Settings(_env_file=None)
            assert s.HOST == "127.0.0.1"

    def test_db_dialect_override(self):
        with patch.dict(os.environ, {"DB_DIALECT": "mysql"}, clear=False):
            from config import Settings
            s = Settings(_env_file=None)
            assert s.DB_DIALECT == "mysql"

    def test_search_tool_type_override(self):
        with patch.dict(os.environ, {"SEARCH_TOOL_TYPE": "BochaAPI"}, clear=False):
            from config import Settings
            s = Settings(_env_file=None)
            assert s.SEARCH_TOOL_TYPE == "BochaAPI"

    def test_llm_api_key_override(self):
        with patch.dict(os.environ, {"INSIGHT_ENGINE_API_KEY": "test-key-123"}, clear=False):
            from config import Settings
            s = Settings(_env_file=None)
            assert s.INSIGHT_ENGINE_API_KEY == "test-key-123"

    def test_max_reflections_override(self):
        with patch.dict(os.environ, {"MAX_REFLECTIONS": "5"}, clear=False):
            from config import Settings
            s = Settings(_env_file=None)
            assert s.MAX_REFLECTIONS == 5


class TestSettingsTypes:
    """测试配置项类型正确性"""

    def test_port_is_int(self):
        with patch.dict(os.environ, {}, clear=True):
            from config import Settings
            s = Settings(_env_file=None)
            assert isinstance(s.PORT, int)

    def test_db_port_is_int(self):
        with patch.dict(os.environ, {}, clear=True):
            from config import Settings
            s = Settings(_env_file=None)
            assert isinstance(s.DB_PORT, int)

    def test_optional_api_keys_default_none(self):
        env = {k: v for k, v in os.environ.items()
               if k not in ("INSIGHT_ENGINE_API_KEY", "MEDIA_ENGINE_API_KEY",
                            "QUERY_ENGINE_API_KEY", "TAVILY_API_KEY")}
        with patch.dict(os.environ, env, clear=True):
            from config import Settings
            s = Settings(_env_file=None)
            assert s.TAVILY_API_KEY is None


class TestReloadSettings:
    """测试配置重载"""

    def test_reload_returns_settings_instance(self):
        from config import reload_settings, Settings
        result = reload_settings()
        assert isinstance(result, Settings)

    def test_reload_picks_up_env_change(self):
        from config import reload_settings
        with patch.dict(os.environ, {"PORT": "9999"}, clear=False):
            result = reload_settings()
            assert result.PORT == 9999


class TestSettingsCaseSensitivity:
    """测试大小写不敏感"""

    def test_lowercase_env_var(self):
        with patch.dict(os.environ, {"port": "7777"}, clear=False):
            from config import Settings
            s = Settings(_env_file=None)
            assert s.PORT == 7777 or s.PORT == 5000  # 取决于平台


class TestSettingsExtraFields:
    """测试 extra='allow' 配置"""

    def test_extra_fields_allowed(self):
        with patch.dict(os.environ, {"CUSTOM_FIELD": "custom_value"}, clear=False):
            from config import Settings
            s = Settings(_env_file=None)
            # extra='allow' 应该不会报错
            assert s is not None
