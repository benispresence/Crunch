"""
DuckDB-native connection adapter.

Distinct from :mod:`file_adapter` (which wraps DuckDB to query loose
CSV/Parquet/JSON files): this adapter opens a real DuckDB database
file — local ``.duckdb`` / ``.db`` or DuckDB's ``:memory:`` mode — and
exposes its persisted tables. Useful for analytics workloads where the
user has already loaded data into DuckDB with their own ETL.
"""

from __future__ import annotations

import logging
import time

import duckdb

from crunch.connections.base import (
    ColumnInfo,
    ConnectionAdapter,
    ConnectionInfo,
    QueryResult,
    TableInfo,
)

logger = logging.getLogger(__name__)


class DuckDBAdapter(ConnectionAdapter):
    """Adapter for native DuckDB databases."""

    def __init__(self, info: ConnectionInfo):
        super().__init__(info)
        self._conn: duckdb.DuckDBPyConnection | None = None

    @property
    def db_type(self) -> str:
        return "duckdb"

    def get_connection_url(self) -> str:
        return ""  # not used; DuckDB driver is direct.

    def get_async_connection_url(self) -> str:
        return ""

    def _path(self) -> str:
        db = (self.info.database or "").strip()
        return db or ":memory:"

    def _ensure_conn(self) -> duckdb.DuckDBPyConnection:
        if self._conn is None:
            self._conn = duckdb.connect(self._path(), read_only=False)
        return self._conn

    async def test_connection(self) -> tuple[bool, str]:
        try:
            conn = self._ensure_conn()
            conn.execute("SELECT 1").fetchone()
            return True, f"OK — connected to {self._path()}"
        except Exception as e:
            return False, f"Connection failed: {e}"

    async def get_schemas(self) -> list[str]:
        try:
            rows = self._ensure_conn().execute(
                "SELECT schema_name FROM information_schema.schemata "
                "WHERE schema_name NOT IN ('information_schema','pg_catalog') "
                "ORDER BY 1"
            ).fetchall()
            return [r[0] for r in rows]
        except Exception:
            return ["main"]

    async def get_tables(self, schema: str | None = None) -> list[TableInfo]:
        try:
            params: list = []
            where = ("WHERE table_schema NOT IN ('information_schema','pg_catalog')")
            if schema:
                where += " AND table_schema = ?"
                params.append(schema)
            rows = self._ensure_conn().execute(
                f"SELECT table_schema, table_name, table_type "
                f"FROM information_schema.tables {where} "
                f"ORDER BY table_schema, table_name",
                params,
            ).fetchall()
            return [
                TableInfo(name=r[1], schema=r[0],
                          table_type="view" if r[2] == "VIEW" else "table")
                for r in rows
            ]
        except Exception:
            return []

    async def get_columns(self, table: str, schema: str | None = None) -> list[ColumnInfo]:
        try:
            params: list = [table]
            where = "table_name = ?"
            if schema:
                where += " AND table_schema = ?"
                params.append(schema)
            rows = self._ensure_conn().execute(
                f"SELECT column_name, data_type, is_nullable, column_default "
                f"FROM information_schema.columns WHERE {where} ORDER BY ordinal_position",
                params,
            ).fetchall()
            return [
                ColumnInfo(
                    name=r[0], data_type=r[1],
                    nullable=str(r[2]).upper() == "YES", default=r[3],
                )
                for r in rows
            ]
        except Exception:
            return []

    async def execute_query(
        self,
        sql: str,
        parameters: dict | None = None,
        limit: int | None = 10000,
    ) -> QueryResult:
        started = time.time()
        try:
            conn = self._ensure_conn()
            cleaned = sql.strip().rstrip(";")
            upper = cleaned.upper()
            is_select = upper.startswith("SELECT") or upper.startswith("WITH")
            if limit and is_select and "LIMIT" not in upper:
                cleaned = f"{cleaned} LIMIT {limit}"

            # DuckDB's Python API uses $name binding rather than :name; we
            # rewrite once so the engine's :name templating stays generic.
            bound_sql, bind_list = _to_positional(cleaned, parameters or {})
            cur = conn.execute(bound_sql, bind_list)
            if cur.description is None:
                return QueryResult(
                    columns=["status"], rows=[("OK",)], row_count=1,
                    execution_time_ms=(time.time() - started) * 1000,
                )
            columns = [d[0] for d in cur.description]
            rows = [tuple(r) for r in cur.fetchall()]
            return QueryResult(
                columns=columns, rows=rows, row_count=len(rows),
                execution_time_ms=(time.time() - started) * 1000,
            )
        except Exception as e:
            return QueryResult(
                columns=[], rows=[], row_count=0,
                execution_time_ms=(time.time() - started) * 1000, error=str(e),
            )

    async def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None


def _to_positional(sql: str, params: dict) -> tuple[str, list]:
    """Rewrite ``:name`` binds to DuckDB's ``?`` positionals so the
    engine's Metabase-style templating stays uniform across backends."""
    import re

    order: list[str] = []
    pattern = re.compile(r":([A-Za-z_][A-Za-z0-9_]*)")

    def sub(m: "re.Match[str]") -> str:
        name = m.group(1)
        order.append(name)
        return "?"

    rewritten = pattern.sub(sub, sql)
    binds = [params.get(name) for name in order]
    return rewritten, binds
