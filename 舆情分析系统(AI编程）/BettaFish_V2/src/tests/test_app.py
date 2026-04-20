"""
Unit tests for app.py - Flask主服务模块 (模块 1.3) + 系统管理API层 (模块 7.1-7.6)
"""

import pytest
import sys
import os
import json
from unittest.mock import patch, MagicMock, PropertyMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture
def app_client():
    """创建Flask测试客户端"""
    # Mock掉重量级依赖，避免真正启动子进程
    with patch("app.MindSpider"), \
         patch("app.REPORT_ENGINE_AVAILABLE", False), \
         patch("app.start_forum_engine"), \
         patch("app.stop_forum_engine"):
        from app import app
        app.config["TESTING"] = True
        with app.test_client() as client:
            yield client


@pytest.fixture
def mock_processes():
    """Mock进程字典"""
    return {
        "query": {"status": "stopped", "port": 8501, "process": None, "output": []},
        "media": {"status": "stopped", "port": 8502, "process": None, "output": []},
        "insight": {"status": "stopped", "port": 8503, "process": None, "output": []},
        "forum": {"status": "stopped", "port": None, "process": None, "output": []},
    }


class TestIndexRoute:
    """测试主页路由"""

    def test_index_returns_200(self, app_client):
        resp = app_client.get("/")
        assert resp.status_code == 200

    def test_index_returns_html(self, app_client):
        resp = app_client.get("/")
        assert b"html" in resp.data.lower() or resp.content_type.startswith("text/html")


class TestStatusAPI:
    """测试 GET /api/status (模块 7.6)"""

    def test_status_returns_json(self, app_client):
        resp = app_client.get("/api/status")
        assert resp.status_code == 200
        data = resp.get_json()
        assert isinstance(data, dict)

    def test_status_contains_app_names(self, app_client):
        resp = app_client.get("/api/status")
        data = resp.get_json()
        # 至少应包含 query/media/insight 中的一个
        known_apps = {"query", "media", "insight", "forum"}
        assert len(set(data.keys()) & known_apps) > 0

    def test_status_app_has_required_fields(self, app_client):
        resp = app_client.get("/api/status")
        data = resp.get_json()
        for app_name, info in data.items():
            assert "status" in info
            assert "port" in info


class TestStartStopAPI:
    """测试引擎生命周期管理 (模块 7.1)"""

    def test_start_unknown_app_returns_failure(self, app_client):
        resp = app_client.get("/api/start/nonexistent")
        data = resp.get_json()
        assert data["success"] is False
        assert "未知" in data["message"] or "unknown" in data["message"].lower()

    def test_stop_unknown_app_returns_failure(self, app_client):
        resp = app_client.get("/api/stop/nonexistent")
        data = resp.get_json()
        assert data["success"] is False

    def test_start_forum_calls_start_forum_engine(self, app_client):
        with patch("app.start_forum_engine") as mock_start, \
             patch("app.processes", {"forum": {"status": "stopped", "port": None, "process": None, "output": []}}):
            mock_start.return_value = None
            resp = app_client.get("/api/start/forum")
            data = resp.get_json()
            assert data["success"] is True

    def test_stop_forum_calls_stop_forum_engine(self, app_client):
        with patch("app.stop_forum_engine") as mock_stop, \
             patch("app.processes", {"forum": {"status": "running", "port": None, "process": None, "output": []}}):
            mock_stop.return_value = None
            resp = app_client.get("/api/stop/forum")
            data = resp.get_json()
            assert data["success"] is True


class TestOutputAPI:
    """测试应用输出获取"""

    def test_output_unknown_app(self, app_client):
        resp = app_client.get("/api/output/nonexistent")
        data = resp.get_json()
        assert data["success"] is False

    def test_output_known_app(self, app_client):
        with patch("app.read_log_from_file", return_value=["line1", "line2"]):
            resp = app_client.get("/api/output/query")
            data = resp.get_json()
            assert data["success"] is True
            assert "output" in data


class TestConfigAPI:
    """测试配置管理API (模块 7.3)"""

    def test_get_config_returns_json(self, app_client):
        resp = app_client.get("/api/config")
        assert resp.status_code == 200
        data = resp.get_json()
        assert isinstance(data, dict)

    def test_update_config_requires_post(self, app_client):
        resp = app_client.get("/api/config")
        # GET应该返回配置，不是405
        assert resp.status_code == 200

    def test_update_config_with_valid_data(self, app_client):
        resp = app_client.post(
            "/api/config",
            data=json.dumps({"PORT": 8080}),
            content_type="application/json"
        )
        assert resp.status_code == 200


class TestForumAPI:
    """测试论坛管理API (模块 7.4)"""

    def test_forum_start(self, app_client):
        with patch("app.start_forum_engine"):
            resp = app_client.get("/api/forum/start")
            assert resp.status_code == 200

    def test_forum_stop(self, app_client):
        with patch("app.stop_forum_engine"):
            resp = app_client.get("/api/forum/stop")
            assert resp.status_code == 200

    def test_forum_log(self, app_client):
        with patch("app.read_log_from_file", return_value=["log1"]):
            resp = app_client.get("/api/forum/log")
            assert resp.status_code == 200


class TestSystemAPI:
    """测试系统级控制 (模块 7.2)"""

    def test_system_status(self, app_client):
        resp = app_client.get("/api/system/status")
        assert resp.status_code == 200

    def test_system_start(self, app_client):
        with patch("app.start_forum_engine"), \
             patch("app.initialize_report_engine", create=True):
            resp = app_client.post("/api/system/start")
            assert resp.status_code == 202

    def test_system_shutdown(self, app_client):
        with patch("app.cleanup_processes"), \
             patch("app.stop_forum_engine"):
            resp = app_client.post("/api/system/shutdown")
            assert resp.status_code == 200


class TestSearchAPI:
    """测试搜索API（纯Python后端版本）"""

    def test_search_requires_post(self, app_client):
        resp = app_client.get("/api/search")
        assert resp.status_code == 405

    def test_search_with_empty_query(self, app_client):
        resp = app_client.post(
            "/api/search",
            data=json.dumps({"query": ""}),
            content_type="application/json"
        )
        data = resp.get_json()
        assert data["success"] is False
        assert "空" in data["message"]

    def test_search_with_no_body(self, app_client):
        resp = app_client.post(
            "/api/search",
            data=json.dumps({}),
            content_type="application/json"
        )
        data = resp.get_json()
        assert data["success"] is False

    @patch("runner.run_pipeline")
    def test_search_returns_202_with_task_id(self, mock_pipeline, app_client):
        mock_pipeline.return_value = {"report_filepath": "test.html"}
        resp = app_client.post(
            "/api/search",
            data=json.dumps({"query": "人工智能"}),
            content_type="application/json"
        )
        assert resp.status_code == 202
        data = resp.get_json()
        assert data["success"] is True
        assert "task_id" in data
        assert data["query"] == "人工智能"

    def test_search_status_unknown_task(self, app_client):
        resp = app_client.get("/api/search/status/nonexistent")
        assert resp.status_code == 404
        data = resp.get_json()
        assert data["success"] is False

    @patch("runner.run_pipeline")
    def test_search_status_existing_task(self, mock_pipeline, app_client):
        mock_pipeline.return_value = {"report_filepath": "test.html"}
        # 先创建任务
        resp = app_client.post(
            "/api/search",
            data=json.dumps({"query": "测试"}),
            content_type="application/json"
        )
        task_id = resp.get_json()["task_id"]
        # 查询状态
        resp2 = app_client.get(f"/api/search/status/{task_id}")
        assert resp2.status_code == 200
        data = resp2.get_json()
        assert data["success"] is True
        assert data["task_id"] == task_id
