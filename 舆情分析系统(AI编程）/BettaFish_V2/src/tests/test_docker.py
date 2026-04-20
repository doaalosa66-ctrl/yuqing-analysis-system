"""
Unit tests for Docker部署模块 (模块 1.4)
验证 Dockerfile 和 docker-compose.yml 的结构正确性
"""

import pytest
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class TestDockerfile:
    """测试 Dockerfile 结构"""

    def _read_dockerfile(self):
        path = os.path.join(PROJECT_ROOT, "Dockerfile")
        with open(path, "r", encoding="utf-8") as f:
            return f.read()

    def test_dockerfile_exists(self):
        assert os.path.exists(os.path.join(PROJECT_ROOT, "Dockerfile"))

    def test_base_image_is_python311(self):
        content = self._read_dockerfile()
        assert "python:3.11" in content

    def test_exposes_required_ports(self):
        content = self._read_dockerfile()
        assert "5000" in content
        assert "8501" in content
        assert "8502" in content
        assert "8503" in content

    def test_workdir_is_app(self):
        content = self._read_dockerfile()
        assert "WORKDIR /app" in content

    def test_copies_requirements(self):
        content = self._read_dockerfile()
        assert "requirements.txt" in content

    def test_installs_playwright(self):
        content = self._read_dockerfile()
        assert "playwright" in content.lower()

    def test_cmd_runs_app(self):
        content = self._read_dockerfile()
        assert "app.py" in content

    def test_disables_pyc(self):
        content = self._read_dockerfile()
        assert "PYTHONDONTWRITEBYTECODE=1" in content

    def test_unbuffered_output(self):
        content = self._read_dockerfile()
        assert "PYTHONUNBUFFERED=1" in content


class TestDockerCompose:
    """测试 docker-compose.yml 结构"""

    def _read_compose(self):
        path = os.path.join(PROJECT_ROOT, "docker-compose.yml")
        with open(path, "r", encoding="utf-8") as f:
            return f.read()

    def test_compose_file_exists(self):
        assert os.path.exists(os.path.join(PROJECT_ROOT, "docker-compose.yml"))

    def test_has_bettafish_service(self):
        content = self._read_compose()
        assert "bettafish" in content

    def test_has_db_service(self):
        content = self._read_compose()
        assert "db:" in content

    def test_db_uses_postgres(self):
        content = self._read_compose()
        assert "postgres" in content

    def test_maps_port_5000(self):
        content = self._read_compose()
        assert "5000:5000" in content

    def test_maps_streamlit_ports(self):
        content = self._read_compose()
        assert "8501:8501" in content
        assert "8502:8502" in content
        assert "8503:8503" in content

    def test_mounts_logs_volume(self):
        content = self._read_compose()
        assert "logs" in content

    def test_mounts_env_file(self):
        content = self._read_compose()
        assert ".env" in content

    def test_restart_policy(self):
        content = self._read_compose()
        assert "unless-stopped" in content
