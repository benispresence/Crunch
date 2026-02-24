"""
File-based connection adapter using DuckDB.

Supports querying CSV and Excel files with standard SQL.
"""

import asyncio
import logging
import re
import time
from pathlib import Path

import duckdb

from nicemeta.connections.base import (
    ColumnInfo,
    ConnectionAdapter,
    ConnectionInfo,
    QueryResult,
    TableInfo,
)

logger = logging.getLogger(__name__)

# Supported file extensions
CSV_EXTENSIONS = {".csv", ".tsv", ".txt"}
EXCEL_EXTENSIONS = {".xlsx", ".xls"}
ALL_EXTENSIONS = CSV_EXTENSIONS | EXCEL_EXTENSIONS


def sanitize_table_name(filename: str) -> str:
    """Convert a filename to a valid SQL table name."""
    name = Path(filename).stem
    name = re.sub(r"[^a-zA-Z0-9_]", "_", name)
    name = re.sub(r"_+", "_", name).strip("_").lower()
    if not name or name[0].isdigit():
        name = f"t_{name}"
    return name


class FileAdapter(ConnectionAdapter):
    """
    Adapter for querying CSV and Excel files using DuckDB.

    Files are registered as views in an in-memory DuckDB database.
    info.database = upload directory path
    info.options["files"] = list of file paths
    """

    def __init__(self, info: ConnectionInfo):
        super().__init__(info)
        self._duckdb_conn: duckdb.DuckDBPyConnection | None = None
        self._registered_tables: dict[str, str] = {}  # table_name -> file_path

    @property
    def db_type(self) -> str:
        return "file"

    def get_connection_url(self) -> str:
        return ""

    def get_async_connection_url(self) -> str:
        return ""

    def _get_upload_dir(self) -> Path:
        """Get the upload directory from connection info."""
        return Path(self.info.database)

    def _get_file_paths(self) -> list[Path]:
        """Get file paths from options or scan upload directory."""
        files = []

        # From options
        if self.info.options and self.info.options.get("files"):
            for f in self.info.options["files"]:
                p = Path(f)
                if p.exists() and p.suffix.lower() in ALL_EXTENSIONS:
                    files.append(p)

        # Fallback: scan upload directory
        if not files:
            upload_dir = self._get_upload_dir()
            if upload_dir.is_dir():
                for p in sorted(upload_dir.iterdir()):
                    if p.is_file() and p.suffix.lower() in ALL_EXTENSIONS:
                        files.append(p)

        return files

    def _init_duckdb(self) -> duckdb.DuckDBPyConnection:
        """Initialize DuckDB and register all files as views."""
        if self._duckdb_conn is not None:
            return self._duckdb_conn

        self._duckdb_conn = duckdb.connect(":memory:")
        self._registered_tables.clear()

        for file_path in self._get_file_paths():
            table_name = sanitize_table_name(file_path.name)
            # Handle duplicate names
            base = table_name
            counter = 1
            while table_name in self._registered_tables:
                table_name = f"{base}_{counter}"
                counter += 1

            try:
                ext = file_path.suffix.lower()
                escaped_path = str(file_path).replace("'", "''")

                if ext in CSV_EXTENSIONS:
                    self._duckdb_conn.execute(
                        f"CREATE OR REPLACE VIEW \"{table_name}\" AS "
                        f"SELECT * FROM read_csv_auto('{escaped_path}')"
                    )
                elif ext in EXCEL_EXTENSIONS:
                    # Use pandas to read Excel, register as DuckDB table
                    import pandas as pd
                    df = pd.read_excel(file_path, engine="openpyxl")
                    self._duckdb_conn.register(table_name, df)

                self._registered_tables[table_name] = str(file_path)
                logger.info(f"Registered file '{file_path.name}' as table '{table_name}'")

            except Exception as e:
                logger.warning(f"Failed to register file '{file_path.name}': {e}")

        return self._duckdb_conn

    async def test_connection(self) -> tuple[bool, str]:
        """Test that files can be loaded."""
        try:
            files = self._get_file_paths()
            if not files:
                upload_dir = self._get_upload_dir()
                if not upload_dir.exists():
                    return False, f"Upload directory not found: {upload_dir}"
                return False, "No CSV or Excel files found"

            conn = self._init_duckdb()
            result = conn.execute("SELECT 1").fetchone()

            table_count = len(self._registered_tables)
            file_names = ", ".join(self._registered_tables.keys())
            return True, f"OK — {table_count} table(s): {file_names}"

        except Exception as e:
            return False, f"Error: {e}"

    async def get_schemas(self) -> list[str]:
        return ["main"]

    async def get_tables(self, schema: str | None = None) -> list[TableInfo]:
        """List registered file tables."""
        self._init_duckdb()
        return [
            TableInfo(name=name, schema="main", table_type="view")
            for name in self._registered_tables
        ]

    async def get_columns(
        self, table: str, schema: str | None = None
    ) -> list[ColumnInfo]:
        """Get columns for a file table."""
        conn = self._init_duckdb()
        try:
            result = conn.execute(f'DESCRIBE "{table}"').fetchall()
            return [
                ColumnInfo(
                    name=row[0],
                    data_type=row[1],
                    nullable=row[2] == "YES" if len(row) > 2 else True,
                )
                for row in result
            ]
        except Exception:
            return []

    async def execute_query(
        self,
        sql: str,
        parameters: dict | None = None,
        limit: int | None = 10000,
    ) -> QueryResult:
        """Execute SQL against the DuckDB in-memory database."""
        start_time = time.time()

        try:
            conn = self._init_duckdb()

            cleaned = sql.strip().rstrip(";")
            upper = cleaned.upper()

            # Don't add LIMIT to non-SELECT statements (SHOW, DESCRIBE, etc.)
            is_select = upper.startswith("SELECT") or upper.startswith("WITH")
            if limit and is_select and "LIMIT" not in upper:
                cleaned = f"{cleaned} LIMIT {limit}"

            result = conn.execute(cleaned)

            if result.description is None:
                # Statement returned no result set
                return QueryResult(
                    columns=["status"],
                    rows=[("OK",)],
                    row_count=1,
                    execution_time_ms=(time.time() - start_time) * 1000,
                )

            columns = [desc[0] for desc in result.description]
            rows = [tuple(row) for row in result.fetchall()]

            execution_time = (time.time() - start_time) * 1000

            return QueryResult(
                columns=columns,
                rows=rows,
                row_count=len(rows),
                execution_time_ms=execution_time,
            )

        except Exception as e:
            execution_time = (time.time() - start_time) * 1000
            return QueryResult(
                columns=[],
                rows=[],
                row_count=0,
                execution_time_ms=execution_time,
                error=str(e),
            )

    async def close(self) -> None:
        """Close the DuckDB connection."""
        if self._duckdb_conn is not None:
            self._duckdb_conn.close()
            self._duckdb_conn = None
        self._registered_tables.clear()
