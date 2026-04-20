"""
报告级缓存（Report Cache）

基于 SQLite 的流水线结果缓存。相同 query 在 TTL 内直接返回历史报告，
跳过完整流水线（0 秒 / 0 Token）。所有操作线程安全，失败不影响正常流水线。
"""

import json
import os
import sqlite3
import threading
from difflib import SequenceMatcher
from pathlib import Path
from loguru import logger


class ReportCache:
    """SQLite 报告缓存，线程安全。"""

    def __init__(self, db_path: str = None):
        if db_path is None:
            _project_root = Path(__file__).resolve().parents[3]
            db_path = str(_project_root / "data" / "cache" / "report_cache.db")
        self._db_path = db_path
        self._lock = threading.Lock()
        self._conn = None
        self._ensure_db()

    def _ensure_db(self):
        """创建数据目录、数据库文件和表结构，并自动迁移旧表结构。"""
        os.makedirs(os.path.dirname(self._db_path), exist_ok=True)
        conn = self._get_conn()
        # 先检查 task_id 字段是否存在，决定建表语句
        existing_cols = {row[1] for row in conn.execute(
            "SELECT * FROM pragma_table_info('report_cache')"
        )} if self._table_exists(conn) else set()

        conn.executescript("""
            CREATE TABLE IF NOT EXISTS report_cache (
                id                   INTEGER PRIMARY KEY AUTOINCREMENT,
                query                TEXT NOT NULL,
                query_raw            TEXT NOT NULL,
                html_content         TEXT,
                report_filepath      TEXT,
                report_relative_path TEXT,
                report_filename      TEXT,
                ir_filepath          TEXT,
                ir_relative_path     TEXT,
                engine_reports       TEXT,
                warnings             TEXT,
                token_usage          TEXT,
                created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_cache_query
                ON report_cache (query, created_at DESC);
        """)

        # 迁移：旧数据库没有 task_id 字段，自动补列和索引
        if 'task_id' not in existing_cols:
            try:
                conn.execute("ALTER TABLE report_cache ADD COLUMN task_id TEXT")
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_cache_task_id ON report_cache (task_id)"
                )
                logger.info("[ReportCache] 已迁移：新增 task_id 字段")
            except Exception as e:
                logger.warning(f"[ReportCache] task_id 迁移失败（可能已存在）: {e}")

        # 迁移：新增 report_task_id 字段（ReportEngine 内部 task_id，格式 report-xxx）
        if 'report_task_id' not in existing_cols:
            try:
                conn.execute("ALTER TABLE report_cache ADD COLUMN report_task_id TEXT")
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_cache_report_task_id ON report_cache (report_task_id)"
                )
                logger.info("[ReportCache] 已迁移：新增 report_task_id 字段")
            except Exception as e:
                logger.warning(f"[ReportCache] report_task_id 迁移失败（可能已存在）: {e}")

        conn.commit()
        logger.info(f"[ReportCache] 初始化完成 db={self._db_path}")

    @staticmethod
    def _table_exists(conn) -> bool:
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='report_cache'"
        ).fetchone()
        return row is not None

    def _get_conn(self) -> sqlite3.Connection:
        if self._conn is None:
            self._conn = sqlite3.connect(self._db_path, check_same_thread=False)
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.row_factory = sqlite3.Row
        return self._conn

    @staticmethod
    def normalize_query(query: str) -> str:
        return query.strip().lower()

    @staticmethod
    def _similarity(a: str, b: str) -> float:
        """计算两个字符串的相似度（0~1），使用 difflib.SequenceMatcher。"""
        return SequenceMatcher(None, a, b).ratio()

    def get(self, query: str, ttl_hours: float = 6.0,
            fuzzy_days: int = 90, fuzzy_threshold: float = 0.92) -> dict | None:
        """
        查找缓存。
        - 精确匹配：ttl_hours 内完全相同的 query，直接命中。
        - 模糊匹配：fuzzy_days 天内相似度 >= fuzzy_threshold 的历史 query，视为重复请求秒出。
        命中返回与 run_pipeline 相同结构的 dict（含 from_cache=True），未命中返回 None。
        """
        normalized = self.normalize_query(query)
        try:
            conn = self._get_conn()

            # ---- 1. 精确匹配（原有逻辑，TTL 内） ----
            row = conn.execute(
                """
                SELECT * FROM report_cache
                WHERE query = ?
                  AND created_at > datetime('now', ?)
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (normalized, f"-{ttl_hours} hours"),
            ).fetchone()

            # ---- 2. 模糊匹配（90天内，相似度 >= 0.92，最多扫描200条） ----
            if row is None:
                candidates = conn.execute(
                    """
                    SELECT * FROM report_cache
                    WHERE created_at > datetime('now', ?)
                    ORDER BY created_at DESC
                    LIMIT 200
                    """,
                    (f"-{fuzzy_days} days",),
                ).fetchall()

                best_row = None
                best_score = 0.0
                for candidate in candidates:
                    score = self._similarity(normalized, candidate["query"])
                    if score >= fuzzy_threshold and score > best_score:
                        best_score = score
                        best_row = candidate

                if best_row is not None:
                    logger.info(
                        f"[ReportCache] 模糊缓存命中 score={best_score:.3f} "
                        f"query={query!r} matched={best_row['query_raw']!r}"
                    )
                    row = best_row

            if row is None:
                return None

            # 校验报告文件是否还在磁盘上
            filepath = row["report_filepath"]
            if filepath and not os.path.exists(filepath):
                logger.warning(f"[ReportCache] 缓存文件已被删除，视为失效: {filepath}")
                with self._lock:
                    conn.execute("DELETE FROM report_cache WHERE id = ?", (row["id"],))
                    conn.commit()
                return None

            result = {
                "html_content": row["html_content"],
                "report_filepath": row["report_filepath"],
                "report_relative_path": row["report_relative_path"],
                "report_filename": row["report_filename"],
                "ir_filepath": row["ir_filepath"],
                "ir_relative_path": row["ir_relative_path"],
                "warnings": json.loads(row["warnings"]) if row["warnings"] else [],
                "from_cache": True,
            }
            if row["token_usage"]:
                result["token_usage"] = json.loads(row["token_usage"])

            logger.info(f"[ReportCache] 缓存命中 query={query!r}")
            return result

        except Exception as e:
            logger.warning(f"[ReportCache] 查询失败: {e}")
            return None

    def put(self, query: str, result: dict, engine_reports: list = None, task_id: str = None, report_task_id: str = None) -> None:
        """存入流水线结果。task_id 是搜索流水线短 hash，report_task_id 是 ReportEngine 内部 ID（report-xxx）。"""
        normalized = self.normalize_query(query)
        # 从 result 里自动提取 report_task_id（如果调用方没传）
        if not report_task_id and isinstance(result, dict):
            report_task_id = result.get("report_task_id") or None
        try:
            with self._lock:
                conn = self._get_conn()
                conn.execute(
                    """
                    INSERT INTO report_cache
                        (task_id, report_task_id, query, query_raw, html_content, report_filepath,
                         report_relative_path, report_filename,
                         ir_filepath, ir_relative_path,
                         engine_reports, warnings, token_usage)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        task_id,
                        report_task_id,
                        normalized,
                        query,
                        result.get("html_content", ""),
                        result.get("report_filepath", ""),
                        result.get("report_relative_path", ""),
                        result.get("report_filename", ""),
                        result.get("ir_filepath", ""),
                        result.get("ir_relative_path", ""),
                        json.dumps(engine_reports, ensure_ascii=False) if engine_reports else None,
                        json.dumps(result.get("warnings", []), ensure_ascii=False),
                        json.dumps(result.get("token_usage"), ensure_ascii=False) if result.get("token_usage") else None,
                    ),
                )
                conn.commit()
            logger.info(f"[ReportCache] 已缓存 query={query!r} task_id={task_id!r} report_task_id={report_task_id!r}")
        except Exception as e:
            logger.warning(f"[ReportCache] 写入失败: {e}")

    def get_by_task_id(self, task_id: str) -> dict | None:
        """按 task_id 或 report_task_id 查找缓存，两种 ID 格式都支持。"""
        if not task_id:
            return None
        try:
            conn = self._get_conn()
            # 同时匹配 task_id（短 hash）和 report_task_id（report-xxx 格式）
            row = conn.execute(
                """SELECT * FROM report_cache
                   WHERE task_id = ? OR report_task_id = ?
                   ORDER BY created_at DESC LIMIT 1""",
                (task_id, task_id),
            ).fetchone()
            if row is None:
                return None
            filepath = row["report_filepath"]
            if filepath and not os.path.exists(filepath):
                return None
            return {
                "html_content": row["html_content"],
                "report_filepath": row["report_filepath"],
                "report_relative_path": row["report_relative_path"],
                "warnings": json.loads(row["warnings"]) if row["warnings"] else [],
                "from_cache": True,
            }
        except Exception as e:
            logger.warning(f"[ReportCache] get_by_task_id 失败: {e}")
            return None

    def invalidate(self, query: str) -> int:
        """删除某 query 的所有缓存条目，返回删除数量。"""
        normalized = self.normalize_query(query)
        try:
            with self._lock:
                conn = self._get_conn()
                cursor = conn.execute("DELETE FROM report_cache WHERE query = ?", (normalized,))
                conn.commit()
                count = cursor.rowcount
            logger.info(f"[ReportCache] 已清除 {count} 条缓存 query={query!r}")
            return count
        except Exception as e:
            logger.warning(f"[ReportCache] 清除失败: {e}")
            return 0

    def cleanup(self, max_age_days: int = 30) -> int:
        """清理超过 max_age_days 天的旧条目，返回删除数量。"""
        try:
            with self._lock:
                conn = self._get_conn()
                cursor = conn.execute(
                    "DELETE FROM report_cache WHERE created_at < datetime('now', ?)",
                    (f"-{max_age_days} days",),
                )
                conn.commit()
                count = cursor.rowcount
            if count > 0:
                logger.info(f"[ReportCache] 清理了 {count} 条过期缓存")
            return count
        except Exception as e:
            logger.warning(f"[ReportCache] 清理失败: {e}")
            return 0


# 全局单例
cache = ReportCache()
