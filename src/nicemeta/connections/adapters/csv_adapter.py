"""
CSV file connection adapter.

Loads CSV files into pandas DataFrames and queries them using DuckDB.
"""

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


class CSVAdapter(ConnectionAdapter):
    """Adapter for CSV file data sources."""

    def __init__(self, info: ConnectionInfo):
        super().__init__(info)
        self._dataframes: dict[str, pd.DataFrame] = {}
        self._duckdb_conn: duckdb.DuckDBPyConnection | None = None

    @property
    def db_type(self) -> str:
        return "csv"

    def get_connection_url(self) -> str:
        return f"csv:///{self.info.database}"

    def get_async_connection_url(self) -> str:
        return self.get_connection_url()

    def _resolve_path(self) -> Path:
        return Path(self.info.database).expanduser().resolve()

    def _csv_options(self) -> dict:
        opts = {"encoding": "utf-8", "delimiter": ","}
        if self.info.options:
            if self.info.options.get("csv_delimiter"):
                opts["delimiter"] = self.info.options["csv_delimiter"]
            if self.info.options.get("csv_encoding"):
                opts["encoding"] = self.info.options["csv_encoding"]
        return opts

    async def test_connection(self) -> tuple[bool, str]:
        path = self._resolve_path()
        if not path.exists():
            return False, f"Path not found: {path}"

        try:
            if path.is_file():
                if not path.suffix.lower() == ".csv":
                    return False, f"Not a CSV file: {path.name}"
                df = pd.read_csv(path, nrows=5, **self._csv_options())
                return True, f"OK — {len(df.columns)} columns"
            elif path.is_dir():
                csv_files = list(path.glob("*.csv"))
                if not csv_files:
                    return False, f"No .csv files in directory: {path}"
                df = pd.read_csv(csv_files[0], nrows=5, **self._csv_options())
                return True, f"OK — {len(csv_files)} CSV file(s), first has {len(df.columns)} columns"
            else:
                return False, f"Path is not a file or directory: {path}"
        except Exception as e:
            return False, str(e)

    async def get_schemas(self) -> list[str]:
        return ["default"]

    async def get_tables(self, schema: str | None = None) -> list[TableInfo]:
        path = self._resolve_path()
        tables = []
        if path.is_file():
            tables.append(TableInfo(name=path.stem, schema="default"))
        elif path.is_dir():
            for csv_file in sorted(path.glob("*.csv")):
                tables.append(TableInfo(name=csv_file.stem, schema="default"))
        return tables

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

        path = self._resolve_path()
        if path.is_file():
            file_path = path
        elif path.is_dir():
            file_path = path / f"{table_name}.csv"
        else:
            raise FileNotFoundError(f"Invalid path: {path}")

        if not file_path.exists():
            raise FileNotFoundError(f"CSV file not found: {file_path}")

        df = pd.read_csv(file_path, **self._csv_options())
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
            # Load all available tables
            tables = await self.get_tables()
            for t in tables:
                self._load_dataframe(t.name)

            conn = self._get_duckdb()

            # Register DataFrames
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
