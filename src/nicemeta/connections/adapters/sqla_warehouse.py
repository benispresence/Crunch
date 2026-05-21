"""
Shared helpers for SQLAlchemy-dialect adapters (cloud warehouses + the
extra OLTP backends).

Each concrete adapter only needs to:
* Declare ``db_type`` and the SQLAlchemy URL it wants to use.
* (Optionally) override schema/table/column introspection if the
  standard ``information_schema`` queries don't fit.

The shared base handles connection caching, a ``test_connection`` that
runs ``SELECT 1``, and a sync ``execute_query`` path — every warehouse
ships a sync DB-API driver but few have a usable asyncio one, so we
run the query in a thread off the asyncio loop. That keeps the rest
of the engine identical across backends.

Driver imports are lazy: missing drivers raise a helpful "pip install"
message on first connection attempt instead of breaking the engine
boot.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from nicemeta.connections.base import (
    ColumnInfo,
    ConnectionAdapter,
    ConnectionInfo,
    QueryResult,
    TableInfo,
)

logger = logging.getLogger(__name__)


class MissingDriverError(RuntimeError):
    """Raised when the driver for a warehouse isn't installed. The
    message tells the user the exact ``pip install`` to run."""


def _require(package: str, install_hint: str) -> None:
    """Import a Python package or raise :class:`MissingDriverError`."""
    import importlib

    try:
        importlib.import_module(package)
    except ImportError as exc:
        raise MissingDriverError(
            f"This connection requires the '{package}' package. "
            f"Install it with: pip install {install_hint}"
        ) from exc


class SQLAlchemyWarehouseAdapter(ConnectionAdapter):
    """Sync-engine SQLAlchemy adapter base for warehouses without async
    drivers. Concrete adapters override :meth:`get_connection_url` (and
    optionally :meth:`required_package`)."""

    #: ``("module_to_import", "pip name")`` pair. Override per backend.
    required_package: tuple[str, str] = ("", "")

    def __init__(self, info: ConnectionInfo):
        super().__init__(info)
        self._sync_engine = None

    def get_async_connection_url(self) -> str:
        # No real async driver; the parent's async execute_query is
        # bypassed by our override below.
        return self.get_connection_url()

    def _ensure_driver(self) -> None:
        mod, hint = self.required_package
        if mod:
            _require(mod, hint)

    def _ensure_engine(self) -> Any:
        if self._sync_engine is None:
            self._ensure_driver()
            from sqlalchemy import create_engine

            self._sync_engine = create_engine(
                self.get_connection_url(), pool_pre_ping=True,
            )
        return self._sync_engine

    async def test_connection(self) -> tuple[bool, str]:
        try:
            from sqlalchemy import text

            engine = self._ensure_engine()
            with engine.connect() as conn:
                conn.execute(text("SELECT 1")).fetchone()
            return True, "Connection successful"
        except MissingDriverError as e:
            return False, str(e)
        except Exception as e:
            return False, f"Connection failed: {e}"

    async def execute_query(
        self,
        sql: str,
        parameters: dict | None = None,
        limit: int | None = 10000,
    ) -> QueryResult:
        """Run the query on a worker thread so the asyncio loop stays
        responsive. Warehouse drivers are sync, so we'd block the event
        loop otherwise."""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None, self._execute_sync, sql, parameters or {}, limit,
        )

    def _execute_sync(self, sql: str, parameters: dict, limit: int | None) -> QueryResult:
        from sqlalchemy import text

        started = time.time()
        try:
            cleaned = sql.strip().rstrip(";")
            upper = cleaned.upper()
            is_select = upper.startswith("SELECT") or upper.startswith("WITH")
            if limit and is_select and "LIMIT" not in upper:
                cleaned = f"{cleaned} LIMIT {limit}"
            engine = self._ensure_engine()
            with engine.connect() as conn:
                result = conn.execute(text(cleaned), parameters)
                columns = list(result.keys())
                rows = [tuple(r) for r in result.fetchall()]
                return QueryResult(
                    columns=columns, rows=rows, row_count=len(rows),
                    execution_time_ms=(time.time() - started) * 1000,
                )
        except MissingDriverError as e:
            return QueryResult(
                columns=[], rows=[], row_count=0,
                execution_time_ms=(time.time() - started) * 1000, error=str(e),
            )
        except Exception as e:
            return QueryResult(
                columns=[], rows=[], row_count=0,
                execution_time_ms=(time.time() - started) * 1000, error=str(e),
            )

    async def close(self) -> None:
        if self._sync_engine is not None:
            self._sync_engine.dispose()
            self._sync_engine = None

    # ---- Introspection ------------------------------------------------
    # Defaults use information_schema, which works for Snowflake,
    # Redshift, ClickHouse, Trino, BigQuery (with dataset substitution).
    # Backends with a different schema model override these.

    async def get_schemas(self) -> list[str]:
        result = await self.execute_query(
            "SELECT schema_name FROM information_schema.schemata "
            "ORDER BY schema_name",
            limit=None,
        )
        if result.error:
            return []
        return [r[0] for r in result.rows]

    async def get_tables(self, schema: str | None = None) -> list[TableInfo]:
        params: dict[str, str] = {}
        where = ""
        if schema:
            where = "WHERE table_schema = :schema"
            params["schema"] = schema
        result = await self.execute_query(
            f"SELECT table_schema, table_name, table_type "
            f"FROM information_schema.tables {where} "
            f"ORDER BY table_schema, table_name",
            parameters=params,
            limit=None,
        )
        if result.error:
            return []
        return [
            TableInfo(name=r[1], schema=r[0],
                      table_type="view" if str(r[2]).upper() == "VIEW" else "table")
            for r in result.rows
        ]

    async def get_columns(self, table: str, schema: str | None = None) -> list[ColumnInfo]:
        params: dict[str, str] = {"table": table}
        where = "table_name = :table"
        if schema:
            where += " AND table_schema = :schema"
            params["schema"] = schema
        result = await self.execute_query(
            f"SELECT column_name, data_type, is_nullable, column_default "
            f"FROM information_schema.columns WHERE {where} "
            f"ORDER BY ordinal_position",
            parameters=params,
            limit=None,
        )
        if result.error:
            return []
        return [
            ColumnInfo(
                name=r[0], data_type=str(r[1]),
                nullable=str(r[2]).upper() == "YES", default=r[3],
            )
            for r in result.rows
        ]
