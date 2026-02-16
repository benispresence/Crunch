"""
Excel file connection adapter.

Loads Excel sheets into pandas DataFrames and queries them using DuckDB.
"""

import re
import time
from pathlib import Path

import duckdb
import pandas as pd

from nicemeta.connections.base import (
    ColumnInfo,
    ConnectionAdapter,
    ConnectionInfo,
    QueryResult,
    TableInfo,
)

PANDAS_TO_SQL = {
    "int64": "INTEGER",
    "int32": "INTEGER",
    "float64": "FLOAT",
    "float32": "FLOAT",
    "object": "TEXT",
    "bool": "BOOLEAN",
    "datetime64[ns]": "TIMESTAMP",
    "category": "TEXT",
}


def _sanitize_name(name: str) -> str:
    """Sanitize a sheet name into a valid SQL table name."""
    clean = re.sub(r"[^a-zA-Z0-9_]", "_", name)
    clean = re.sub(r"_+", "_", clean).strip("_")
    if clean and clean[0].isdigit():
        clean = f"sheet_{clean}"
    return clean or "sheet"


class ExcelAdapter(ConnectionAdapter):
    """Adapter for Excel file data sources."""

    def __init__(self, info: ConnectionInfo):
        super().__init__(info)
        self._dataframes: dict[str, pd.DataFrame] = {}
        self._sheet_map: dict[str, str] = {}  # sanitized_name -> original_name
        self._duckdb_conn: duckdb.DuckDBPyConnection | None = None

    @property
    def db_type(self) -> str:
        return "excel"

    def get_connection_url(self) -> str:
        return f"excel:///{self.info.database}"

    def get_async_connection_url(self) -> str:
        return self.get_connection_url()

    def _resolve_path(self) -> Path:
        return Path(self.info.database).expanduser().resolve()

    def _load_sheet_names(self) -> list[str]:
        path = self._resolve_path()
        xls = pd.ExcelFile(path)
        return xls.sheet_names

    def _build_sheet_map(self) -> None:
        if self._sheet_map:
            return
        for name in self._load_sheet_names():
            sanitized = _sanitize_name(name)
            # Deduplicate
            base, i = sanitized, 1
            while sanitized in self._sheet_map:
                sanitized = f"{base}_{i}"
                i += 1
            self._sheet_map[sanitized] = name

    async def test_connection(self) -> tuple[bool, str]:
        path = self._resolve_path()
        if not path.exists():
            return False, f"File not found: {path}"
        if not path.is_file():
            return False, f"Not a file: {path}"
        if path.suffix.lower() not in (".xlsx", ".xls", ".xlsm"):
            return False, f"Not an Excel file: {path.name}"

        try:
            sheets = self._load_sheet_names()
            return True, f"OK — {len(sheets)} sheet(s): {', '.join(sheets[:5])}"
        except Exception as e:
            return False, str(e)

    async def get_schemas(self) -> list[str]:
        return ["default"]

    async def get_tables(self, schema: str | None = None) -> list[TableInfo]:
        self._build_sheet_map()
        return [
            TableInfo(name=sanitized, schema="default")
            for sanitized in self._sheet_map
        ]

    async def get_columns(self, table: str, schema: str | None = None) -> list[ColumnInfo]:
        df = self._load_dataframe(table)
        columns = []
        for col_name, dtype in df.dtypes.items():
            sql_type = PANDAS_TO_SQL.get(str(dtype), "TEXT")
            columns.append(ColumnInfo(name=str(col_name), data_type=sql_type))
        return columns

    def _load_dataframe(self, table_name: str) -> pd.DataFrame:
        if table_name in self._dataframes:
            return self._dataframes[table_name]

        self._build_sheet_map()
        original_name = self._sheet_map.get(table_name)
        if original_name is None:
            raise ValueError(f"Sheet not found: {table_name}")

        path = self._resolve_path()
        df = pd.read_excel(path, sheet_name=original_name)
        self._dataframes[table_name] = df
        return df

    def _get_duckdb(self) -> duckdb.DuckDBPyConnection:
        if self._duckdb_conn is None:
            self._duckdb_conn = duckdb.connect(":memory:")
        return self._duckdb_conn

    async def execute_query(
        self,
        sql: str,
        parameters: dict | None = None,
        limit: int | None = 10000,
    ) -> QueryResult:
        start_time = time.time()
        try:
            # Load all sheets
            tables = await self.get_tables()
            for t in tables:
                self._load_dataframe(t.name)

            conn = self._get_duckdb()

            for name, df in self._dataframes.items():
                conn.register(name, df)

            if limit and "LIMIT" not in sql.upper():
                sql = f"{sql.rstrip().rstrip(';')} LIMIT {limit}"

            result = conn.execute(sql)
            columns = [desc[0] for desc in result.description]
            rows = [tuple(row) for row in result.fetchall()]

            return QueryResult(
                columns=columns,
                rows=rows,
                row_count=len(rows),
                execution_time_ms=(time.time() - start_time) * 1000,
            )
        except Exception as e:
            return QueryResult(
                columns=[],
                rows=[],
                row_count=0,
                execution_time_ms=(time.time() - start_time) * 1000,
                error=str(e),
            )

    async def close(self) -> None:
        if self._duckdb_conn:
            self._duckdb_conn.close()
            self._duckdb_conn = None
        self._dataframes.clear()
        self._sheet_map.clear()
