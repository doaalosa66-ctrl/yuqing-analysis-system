"""
Unit tests for 前端展示层 (模块 6.1-6.7)
SPA主页面 / 太空主题CSS / 论坛状态管理JS / 报告阅读器JS / Streamlit独立应用
"""

import pytest
import sys
import os
import re

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ==================== 模块 6.1: 主页面 SPA ====================

class TestIndexHTML:
    """测试 templates/index.html"""

    def _read_file(self):
        path = os.path.join(PROJECT_ROOT, "templates", "index.html")
        with open(path, "r", encoding="utf-8") as f:
            return f.read()

    def test_file_exists(self):
        assert os.path.isfile(os.path.join(PROJECT_ROOT, "templates", "index.html"))

    def test_has_html_structure(self):
        content = self._read_file()
        assert "<!DOCTYPE" in content or "<html" in content.lower()
        assert "</html>" in content.lower()

    def test_includes_socketio(self):
        content = self._read_file()
        assert "socket" in content.lower()

    def test_includes_search_input(self):
        content = self._read_file()
        assert "search" in content.lower() or "input" in content.lower()

    def test_references_space_theme_css(self):
        content = self._read_file()
        assert "space-theme" in content

    def test_references_forum_state_js(self):
        content = self._read_file()
        assert "forum-state" in content or "forum_state" in content or "forumState" in content

    def test_references_report_reader_js(self):
        content = self._read_file()
        assert "report-reader" in content or "report_reader" in content or "reportReader" in content

    def test_has_meta_charset(self):
        content = self._read_file()
        assert "utf-8" in content.lower()

    def test_has_viewport_meta(self):
        content = self._read_file()
        assert "viewport" in content.lower()


# ==================== 模块 6.2: 太空主题样式 ====================

class TestSpaceThemeCSS:
    """测试 static/css/space-theme.css"""

    def _read_file(self):
        path = os.path.join(PROJECT_ROOT, "static", "css", "space-theme.css")
        with open(path, "r", encoding="utf-8") as f:
            return f.read()

    def test_file_exists(self):
        assert os.path.isfile(os.path.join(PROJECT_ROOT, "static", "css", "space-theme.css"))

    def test_has_css_variables(self):
        content = self._read_file()
        assert "--" in content  # CSS自定义属性

    def test_has_space_void_variable(self):
        content = self._read_file()
        assert "space-void" in content or "space_void" in content

    def test_has_glass_bg_variable(self):
        content = self._read_file()
        assert "glass" in content.lower()

    def test_has_animation_config(self):
        content = self._read_file()
        assert "ease" in content.lower() or "transition" in content.lower() or "animation" in content.lower()

    def test_has_border_radius_system(self):
        content = self._read_file()
        assert "border-radius" in content or "--r-" in content

    def test_file_size_reasonable(self):
        path = os.path.join(PROJECT_ROOT, "static", "css", "space-theme.css")
        size = os.path.getsize(path)
        assert size > 1000, "CSS文件应有足够内容"
        assert size < 500000, "CSS文件不应过大"


# ==================== 模块 6.3: 论坛状态管理 ====================

class TestForumStateJS:
    """测试 static/js/forum-state.js"""

    def _read_file(self):
        path = os.path.join(PROJECT_ROOT, "static", "js", "forum-state.js")
        with open(path, "r", encoding="utf-8") as f:
            return f.read()

    def test_file_exists(self):
        assert os.path.isfile(os.path.join(PROJECT_ROOT, "static", "js", "forum-state.js"))

    def test_exports_forum_state(self):
        content = self._read_file()
        assert "ForumState" in content

    def test_has_push_method(self):
        content = self._read_file()
        assert "push" in content

    def test_has_activate_method(self):
        content = self._read_file()
        assert "activate" in content

    def test_has_complete_method(self):
        content = self._read_file()
        assert "complete" in content

    def test_has_reset_method(self):
        content = self._read_file()
        assert "reset" in content

    def test_has_typewriter_speed(self):
        content = self._read_file()
        assert "TYPEWRITER" in content or "typewriter" in content

    def test_has_agent_nodes(self):
        content = self._read_file()
        assert "query" in content and "media" in content and "insight" in content


# ==================== 模块 6.4: 报告阅读器 ====================

class TestReportReaderJS:
    """测试 static/js/report-reader.js"""

    def _read_file(self):
        path = os.path.join(PROJECT_ROOT, "static", "js", "report-reader.js")
        with open(path, "r", encoding="utf-8") as f:
            return f.read()

    def test_file_exists(self):
        assert os.path.isfile(os.path.join(PROJECT_ROOT, "static", "js", "report-reader.js"))

    def test_exports_report_reader(self):
        content = self._read_file()
        assert "ReportReader" in content

    def test_has_on_report_loaded(self):
        content = self._read_file()
        assert "onReportLoaded" in content or "on_report_loaded" in content

    def test_has_pdf_export(self):
        content = self._read_file()
        assert "pdf" in content.lower() or "PDF" in content

    def test_has_outline_navigation(self):
        content = self._read_file()
        # 大纲导航相关
        assert "outline" in content.lower() or "toc" in content.lower() or "h2" in content or "h3" in content

    def test_has_fab_menu(self):
        content = self._read_file()
        assert "fab" in content.lower() or "FAB" in content or "menu" in content.lower()


# ==================== 模块 6.5: Streamlit - InsightEngine ====================

class TestInsightEngineStreamlit:
    """测试 SingleEngineApp/insight_engine_streamlit_app.py"""

    def _read_file(self):
        path = os.path.join(PROJECT_ROOT, "SingleEngineApp", "insight_engine_streamlit_app.py")
        with open(path, "r", encoding="utf-8") as f:
            return f.read()

    def test_file_exists(self):
        assert os.path.isfile(
            os.path.join(PROJECT_ROOT, "SingleEngineApp", "insight_engine_streamlit_app.py")
        )

    def test_imports_streamlit(self):
        content = self._read_file()
        assert "import streamlit" in content or "from streamlit" in content

    def test_uses_kimi_model(self):
        content = self._read_file()
        assert "kimi" in content.lower() or "moonshot" in content.lower()

    def test_has_search_functionality(self):
        content = self._read_file()
        assert "search" in content.lower()

    def test_has_database_config(self):
        content = self._read_file()
        assert "mysql" in content.lower() or "database" in content.lower() or "db" in content.lower()

    def test_has_max_content_length(self):
        content = self._read_file()
        assert "max_content_length" in content or "500000" in content or "500,000" in content


# ==================== 模块 6.6: Streamlit - MediaEngine ====================

class TestMediaEngineStreamlit:
    """测试 SingleEngineApp/media_engine_streamlit_app.py"""

    def _read_file(self):
        path = os.path.join(PROJECT_ROOT, "SingleEngineApp", "media_engine_streamlit_app.py")
        with open(path, "r", encoding="utf-8") as f:
            return f.read()

    def test_file_exists(self):
        assert os.path.isfile(
            os.path.join(PROJECT_ROOT, "SingleEngineApp", "media_engine_streamlit_app.py")
        )

    def test_imports_streamlit(self):
        content = self._read_file()
        assert "import streamlit" in content or "from streamlit" in content

    def test_uses_gemini_model(self):
        content = self._read_file()
        assert "gemini" in content.lower()

    def test_supports_multimodal(self):
        content = self._read_file()
        # 应支持多模态平台
        platforms = ["抖音", "快手", "小红书", "douyin", "kuaishou", "xiaohongshu"]
        has_platform = any(p in content for p in platforms)
        assert has_platform or "multimodal" in content.lower() or "多模态" in content


# ==================== 模块 6.7: Streamlit - QueryEngine ====================

class TestQueryEngineStreamlit:
    """测试 SingleEngineApp/query_engine_streamlit_app.py"""

    def _read_file(self):
        path = os.path.join(PROJECT_ROOT, "SingleEngineApp", "query_engine_streamlit_app.py")
        with open(path, "r", encoding="utf-8") as f:
            return f.read()

    def test_file_exists(self):
        assert os.path.isfile(
            os.path.join(PROJECT_ROOT, "SingleEngineApp", "query_engine_streamlit_app.py")
        )

    def test_imports_streamlit(self):
        content = self._read_file()
        assert "import streamlit" in content or "from streamlit" in content

    def test_uses_deepseek_model(self):
        content = self._read_file()
        assert "deepseek" in content.lower()

    def test_has_url_params_support(self):
        content = self._read_file()
        assert "query" in content.lower()

    def test_has_progress_bar(self):
        content = self._read_file()
        assert "progress" in content.lower()

    def test_has_auto_search(self):
        content = self._read_file()
        assert "auto" in content.lower()
