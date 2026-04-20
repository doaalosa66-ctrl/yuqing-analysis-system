"""
Unit tests for InsightEngine/utils/db.py
"""

import pytest
import sys
import os
import asyncio
from unittest.mock import patch, MagicMock, AsyncMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class TestBuildDatabaseUrl:
    def test_mysql_url_format(self):
        with patch.dict(os.environ, {"DATABASE_URL": ""}, clear=False):
            # Patch the settings object attributes directly
            with patch("InsightEngine.utils.db.settings") as mock_settings:
                mock_settings.DB_DIALECT = "mysql"
                mock_settings.DB_HOST = "localhost"
                mock_settings.DB_PORT = "3306"
                mock_settings.DB_USER = "root"
                mock_settings.DB_PASSWORD = "password"
                mock_settings.DB_NAME = "testdb"

                # Also ensure DATABASE_URL env var is absent
                env_without_db_url = {k: v for k, v in os.environ.items() if k != "DATABASE_URL"}
                with patch.dict(os.environ, env_without_db_url, clear=True):
                    from InsightEngine.utils.db import _build_database_url
                    url = _build_database_url()

        assert "mysql+aiomysql" in url
        assert "localhost" in url
        assert "testdb" in url

    def test_postgresql_url_format(self):
        env_without_db_url = {k: v for k, v in os.environ.items() if k != "DATABASE_URL"}
        with patch.dict(os.environ, env_without_db_url, clear=True):
            with patch("InsightEngine.utils.db.settings") as mock_settings:
                mock_settings.DB_DIALECT = "postgresql"
                mock_settings.DB_HOST = "pghost"
                mock_settings.DB_PORT = "5432"
                mock_settings.DB_USER = "pguser"
                mock_settings.DB_PASSWORD = "pgpass"
                mock_settings.DB_NAME = "pgdb"

                from InsightEngine.utils.db import _build_database_url
                url = _build_database_url()

        assert "postgresql+asyncpg" in url
        assert "pghost" in url
        assert "pgdb" in url

    def test_database_url_env_var_takes_precedence(self):
        with patch.dict(os.environ, {"DATABASE_URL": "postgresql+asyncpg://user:pass@host/db"}):
            from InsightEngine.utils.db import _build_database_url
            url = _build_database_url()
        assert url == "postgresql+asyncpg://user:pass@host/db"

    def test_password_with_special_chars_is_encoded(self):
        env_without_db_url = {k: v for k, v in os.environ.items() if k != "DATABASE_URL"}
        with patch.dict(os.environ, env_without_db_url, clear=True):
            with patch("InsightEngine.utils.db.settings") as mock_settings:
                mock_settings.DB_DIALECT = "mysql"
                mock_settings.DB_HOST = "localhost"
                mock_settings.DB_PORT = "3306"
                mock_settings.DB_USER = "root"
                mock_settings.DB_PASSWORD = "p@ss#word!"
                mock_settings.DB_NAME = "testdb"

                from InsightEngine.utils.db import _build_database_url
                url = _build_database_url()

        # Raw special chars should be URL-encoded
        assert "p@ss#word!" not in url
        assert "mysql+aiomysql" in url

    def test_postgres_alias_recognized(self):
        env_without_db_url = {k: v for k, v in os.environ.items() if k != "DATABASE_URL"}
        with patch.dict(os.environ, env_without_db_url, clear=True):
            with patch("InsightEngine.utils.db.settings") as mock_settings:
                mock_settings.DB_DIALECT = "postgres"
                mock_settings.DB_HOST = "localhost"
                mock_settings.DB_PORT = "5432"
                mock_settings.DB_USER = "user"
                mock_settings.DB_PASSWORD = "pass"
                mock_settings.DB_NAME = "db"

                from InsightEngine.utils.db import _build_database_url
                url = _build_database_url()

        assert "postgresql+asyncpg" in url

    def test_empty_password_handled(self):
        env_without_db_url = {k: v for k, v in os.environ.items() if k != "DATABASE_URL"}
        with patch.dict(os.environ, env_without_db_url, clear=True):
            with patch("InsightEngine.utils.db.settings") as mock_settings:
                mock_settings.DB_DIALECT = "mysql"
                mock_settings.DB_HOST = "localhost"
                mock_settings.DB_PORT = "3306"
                mock_settings.DB_USER = "root"
                mock_settings.DB_PASSWORD = ""
                mock_settings.DB_NAME = "testdb"

                from InsightEngine.utils.db import _build_database_url
                url = _build_database_url()

        assert "mysql+aiomysql" in url


class TestGetAsyncEngine:
    def test_returns_engine_instance(self):
        import InsightEngine.utils.db as db_module
        # Reset cached engine
        original_engine = db_module._engine
        db_module._engine = None

        mock_engine = MagicMock()
        with patch("InsightEngine.utils.db.create_async_engine", return_value=mock_engine):
            with patch("InsightEngine.utils.db._build_database_url", return_value="mysql+aiomysql://u:p@h/db"):
                engine = db_module.get_async_engine()

        assert engine is mock_engine
        db_module._engine = original_engine

    def test_engine_cached_on_second_call(self):
        import InsightEngine.utils.db as db_module
        original_engine = db_module._engine
        db_module._engine = None

        mock_engine = MagicMock()
        create_calls = []

        def mock_create(*args, **kwargs):
            create_calls.append(1)
            return mock_engine

        with patch("InsightEngine.utils.db.create_async_engine", side_effect=mock_create):
            with patch("InsightEngine.utils.db._build_database_url", return_value="mysql+aiomysql://u:p@h/db"):
                e1 = db_module.get_async_engine()
                e2 = db_module.get_async_engine()

        assert e1 is e2
        assert len(create_calls) == 1
        db_module._engine = original_engine

    def test_engine_created_with_pool_settings(self):
        import InsightEngine.utils.db as db_module
        original_engine = db_module._engine
        db_module._engine = None

        create_kwargs = {}

        def capture_create(url, **kwargs):
            create_kwargs.update(kwargs)
            return MagicMock()

        with patch("InsightEngine.utils.db.create_async_engine", side_effect=capture_create):
            with patch("InsightEngine.utils.db._build_database_url", return_value="mysql+aiomysql://u:p@h/db"):
                db_module.get_async_engine()

        assert create_kwargs.get("pool_pre_ping") is True
        assert create_kwargs.get("pool_recycle") == 1800
        db_module._engine = original_engine


class TestFetchAll:
    def _run(self, coro):
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(coro)
        finally:
            loop.close()

    def test_fetch_all_returns_list_of_dicts(self):
        import InsightEngine.utils.db as db_module

        mock_row1 = {"id": 1, "name": "Alice"}
        mock_row2 = {"id": 2, "name": "Bob"}

        mock_result = MagicMock()
        mock_result.mappings.return_value.all.return_value = [mock_row1, mock_row2]

        mock_conn = AsyncMock()
        mock_conn.execute = AsyncMock(return_value=mock_result)

        async def fake_connect():
            return mock_conn

        mock_engine = MagicMock()
        mock_engine.connect.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_engine.connect.return_value.__aexit__ = AsyncMock(return_value=False)

        with patch("InsightEngine.utils.db.get_async_engine", return_value=mock_engine):
            results = self._run(db_module.fetch_all("SELECT * FROM users"))

        assert isinstance(results, list)
        assert len(results) == 2
        assert results[0]["name"] == "Alice"

    def test_fetch_all_with_params(self):
        import InsightEngine.utils.db as db_module

        mock_result = MagicMock()
        mock_result.mappings.return_value.all.return_value = [{"id": 1}]

        mock_conn = AsyncMock()
        mock_conn.execute = AsyncMock(return_value=mock_result)

        mock_engine = MagicMock()
        mock_engine.connect.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_engine.connect.return_value.__aexit__ = AsyncMock(return_value=False)

        with patch("InsightEngine.utils.db.get_async_engine", return_value=mock_engine):
            results = self._run(db_module.fetch_all("SELECT * FROM t WHERE id = :id", {"id": 1}))

        assert len(results) == 1

    def test_fetch_all_empty_result(self):
        import InsightEngine.utils.db as db_module

        mock_result = MagicMock()
        mock_result.mappings.return_value.all.return_value = []

        mock_conn = AsyncMock()
        mock_conn.execute = AsyncMock(return_value=mock_result)

        mock_engine = MagicMock()
        mock_engine.connect.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_engine.connect.return_value.__aexit__ = AsyncMock(return_value=False)

        with patch("InsightEngine.utils.db.get_async_engine", return_value=mock_engine):
            results = self._run(db_module.fetch_all("SELECT * FROM empty_table"))

        assert results == []

    def test_fetch_all_converts_row_mappings_to_plain_dicts(self):
        import InsightEngine.utils.db as db_module

        # Simulate a RowMapping-like object (not a plain dict)
        class FakeRowMapping:
            def __init__(self, data):
                self._data = data
            def keys(self):
                return self._data.keys()
            def items(self):
                return self._data.items()
            def __iter__(self):
                return iter(self._data)
            def __getitem__(self, key):
                return self._data[key]

        fake_row = FakeRowMapping({"col": "val"})

        mock_result = MagicMock()
        mock_result.mappings.return_value.all.return_value = [fake_row]

        mock_conn = AsyncMock()
        mock_conn.execute = AsyncMock(return_value=mock_result)

        mock_engine = MagicMock()
        mock_engine.connect.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_engine.connect.return_value.__aexit__ = AsyncMock(return_value=False)

        with patch("InsightEngine.utils.db.get_async_engine", return_value=mock_engine):
            results = self._run(db_module.fetch_all("SELECT col FROM t"))

        assert isinstance(results[0], dict)

    def test_fetch_all_passes_none_params_as_empty_dict(self):
        import InsightEngine.utils.db as db_module

        execute_calls = []

        mock_result = MagicMock()
        mock_result.mappings.return_value.all.return_value = []

        async def capture_execute(stmt, params):
            execute_calls.append(params)
            return mock_result

        mock_conn = AsyncMock()
        mock_conn.execute = capture_execute

        mock_engine = MagicMock()
        mock_engine.connect.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_engine.connect.return_value.__aexit__ = AsyncMock(return_value=False)

        with patch("InsightEngine.utils.db.get_async_engine", return_value=mock_engine):
            self._run(db_module.fetch_all("SELECT 1", None))

        # None params should be passed as empty dict
        assert execute_calls[0] == {}
