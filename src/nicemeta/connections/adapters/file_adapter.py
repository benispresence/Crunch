"""
File-based connection adapter using DuckDB.

Supports querying flat-file data sources with standard SQL. The
adapter wraps DuckDB's native readers so the same query language
works across formats:

* CSV / TSV / TXT (including ``.csv.gz``, ``.csv.zst``)
* Apache Parquet (``.parquet``)
* JSON and newline-delimited JSON (``.json``, ``.jsonl``, ``.ndjson``)
* Apache Arrow / Feather (``.arrow``, ``.feather``)
* Excel (``.xlsx``, ``.xls``) — via openpyxl + pandas

Sources can be local file paths *or* cloud URIs (``s3://``, ``gs://``,
``az://``, ``https://``). Cloud reads use DuckDB's ``httpfs`` extension,
loaded lazily on first use; credentials are pulled from the connection
config's ``options`` (e.g. ``s3_access_key_id``, ``s3_secret_access_key``,
``s3_region``).
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

# DuckDB picks the reader from the extension, including double extensions
# for compressed CSV (.csv.gz / .csv.zst). We list the canonical leaf
# extensions and an explicit "compressed CSV" suffix check below.
CSV_EXTENSIONS = {".csv", ".tsv", ".txt"}
EXCEL_EXTENSIONS = {".xlsx", ".xls"}
PARQUET_EXTENSIONS = {".parquet", ".pq"}
JSON_EXTENSIONS = {".json", ".jsonl", ".ndjson"}
ARROW_EXTENSIONS = {".arrow", ".feather", ".ipc"}
ALL_EXTENSIONS = (
    CSV_EXTENSIONS
    | EXCEL_EXTENSIONS
    | PARQUET_EXTENSIONS
    | JSON_EXTENSIONS
    | ARROW_EXTENSIONS
)
COMPRESSED_CSV_SUFFIXES = (".csv.gz", ".csv.zst", ".tsv.gz", ".tsv.zst")

# Recognised cloud schemes. https:// is included so direct URLs to
# parquet/csv files on a CDN also work.
REMOTE_SCHEMES = ("s3://", "gs://", "gcs://", "az://", "azure://", "http://", "https://")


def sanitize_table_name(filename: str) -> str:
    """Convert a filename to a valid SQL table name."""
    name = Path(filename).stem
    # Strip secondary compression suffix so foo.csv.gz becomes foo, not foo.csv.
    if name.endswith(".csv") or name.endswith(".tsv"):
        name = name[: -len(".csv")] if name.endswith(".csv") else name[: -len(".tsv")]
    name = re.sub(r"[^a-zA-Z0-9_]", "_", name)
    name = re.sub(r"_+", "_", name).strip("_").lower()
    if not name or name[0].isdigit():
        name = f"t_{name}"
    return name


def _looks_remote(uri: str) -> bool:
    return uri.lower().startswith(REMOTE_SCHEMES)


def _extension_of(uri: str) -> str:
    """Return the recognised leaf extension, stripping a single trailing
    compression suffix. ``foo.csv.gz`` → ``.csv``; ``data.parquet`` →
    ``.parquet``."""
    lower = uri.lower().split("?", 1)[0]  # drop query string from https URLs
    base = lower.rsplit("/", 1)[-1]
    if base.endswith((".csv.gz", ".csv.zst")):
        return ".csv"
    if base.endswith((".tsv.gz", ".tsv.zst")):
        return ".tsv"
    return Path(base).suffix


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

    def _get_sources(self) -> list[str]:
        """Return the list of sources to register. Each entry is either
        a local path or a cloud URI (``s3://...``, ``https://...``).

        Priority:
        1. ``options["files"]`` — an explicit list of paths *or* URIs
           the connection should expose.
        2. ``info.database`` if it itself looks like a cloud URI
           (handy for single-bucket connections).
        3. Otherwise, treat ``info.database`` as a directory and scan
           it for supported file extensions.
        """
        sources: list[str] = []

        if self.info.options and self.info.options.get("files"):
            for f in self.info.options["files"]:
                uri = str(f).strip()
                if not uri:
                    continue
                if _looks_remote(uri):
                    sources.append(uri)
                else:
                    p = Path(uri)
                    if p.exists() and _extension_of(uri) in ALL_EXTENSIONS:
                        sources.append(str(p))

        # `database` itself may be a cloud URI pointing at a single
        # object or a bucket-prefix glob.
        db = (self.info.database or "").strip()
        if not sources and db and _looks_remote(db):
            sources.append(db)

        # Fallback: scan a local directory.
        if not sources and db:
            upload_dir = Path(db)
            if upload_dir.is_dir():
                for p in sorted(upload_dir.iterdir()):
                    if p.is_file() and _extension_of(p.name) in ALL_EXTENSIONS:
                        sources.append(str(p))

        return sources

    def _configure_httpfs(self, conn: duckdb.DuckDBPyConnection) -> None:
        """Load DuckDB's httpfs extension and apply credentials/region
        from ``options`` so s3://, gs://, and https:// URIs work. No-op
        when only local files are in play."""
        try:
            conn.execute("INSTALL httpfs")
        except Exception:
            pass  # already installed in image / no network — fall through
        conn.execute("LOAD httpfs")
        opts = self.info.options or {}
        # S3 / S3-compatible. Settings map 1:1 to DuckDB's httpfs vars.
        setters = {
            "s3_region": opts.get("s3_region") or opts.get("region"),
            "s3_access_key_id": opts.get("s3_access_key_id") or opts.get("aws_access_key_id"),
            "s3_secret_access_key": opts.get("s3_secret_access_key") or opts.get("aws_secret_access_key"),
            "s3_session_token": opts.get("s3_session_token") or opts.get("aws_session_token"),
            "s3_endpoint": opts.get("s3_endpoint"),
            "s3_url_style": opts.get("s3_url_style"),  # 'path' for MinIO etc
            # Azure: connection string is the simplest path.
            "azure_storage_connection_string": opts.get("azure_storage_connection_string"),
        }
        for key, val in setters.items():
            if val is None or val == "":
                continue
            escaped = str(val).replace("'", "''")
            try:
                conn.execute(f"SET {key} = '{escaped}'")
            except Exception as e:
                logger.warning("Could not apply DuckDB setting %s: %s", key, e)

    def _init_duckdb(self) -> duckdb.DuckDBPyConnection:
        """Initialize DuckDB and register all sources as views."""
        if self._duckdb_conn is not None:
            return self._duckdb_conn

        self._duckdb_conn = duckdb.connect(":memory:")
        self._registered_tables.clear()

        sources = self._get_sources()
        # Set up cloud credentials once if we see any remote URIs. Local
        # only? Keep startup cheap and skip the extension load.
        if any(_looks_remote(s) for s in sources):
            try:
                self._configure_httpfs(self._duckdb_conn)
            except Exception as e:
                logger.warning("httpfs setup failed: %s", e)

        for src in sources:
            base_name = src.rsplit("/", 1)[-1].split("?", 1)[0]
            table_name = sanitize_table_name(base_name)
            base = table_name
            counter = 1
            while table_name in self._registered_tables:
                table_name = f"{base}_{counter}"
                counter += 1

            try:
                ext = _extension_of(src)
                escaped = src.replace("'", "''")

                if ext in CSV_EXTENSIONS:
                    # read_csv_auto handles plain + gzip + zstd transparently.
                    self._duckdb_conn.execute(
                        f'CREATE OR REPLACE VIEW "{table_name}" AS '
                        f"SELECT * FROM read_csv_auto('{escaped}')"
                    )
                elif ext in PARQUET_EXTENSIONS:
                    self._duckdb_conn.execute(
                        f'CREATE OR REPLACE VIEW "{table_name}" AS '
                        f"SELECT * FROM read_parquet('{escaped}')"
                    )
                elif ext in JSON_EXTENSIONS:
                    # read_json_auto handles both regular and newline-
                    # delimited JSON; format='auto' picks the right one.
                    self._duckdb_conn.execute(
                        f'CREATE OR REPLACE VIEW "{table_name}" AS '
                        f"SELECT * FROM read_json_auto('{escaped}', "
                        f"format='auto')"
                    )
                elif ext in ARROW_EXTENSIONS:
                    # DuckDB doesn't have a read_arrow function for URIs;
                    # for local files we go through pyarrow and register
                    # the resulting Arrow table. Remote .arrow is rare in
                    # practice; users can convert to parquet.
                    import pyarrow.feather as feather  # type: ignore

                    if _looks_remote(src):
                        raise ValueError(
                            "Remote Arrow/Feather files aren't supported — "
                            "convert to Parquet for cloud reads."
                        )
                    tbl = feather.read_table(src)
                    self._duckdb_conn.register(table_name, tbl)
                elif ext in EXCEL_EXTENSIONS:
                    import pandas as pd

                    if _looks_remote(src):
                        # pandas can read https:// directly; s3/gs need
                        # fsspec/gcsfs and are out of scope here.
                        df = pd.read_excel(src, engine="openpyxl")
                    else:
                        df = pd.read_excel(src, engine="openpyxl")
                    self._duckdb_conn.register(table_name, df)
                else:
                    logger.warning("Skipping unknown extension %s for %s", ext, src)
                    continue

                self._registered_tables[table_name] = src
                logger.info("Registered '%s' as table '%s'", src, table_name)

            except Exception as e:
                logger.warning("Failed to register source '%s': %s", src, e)

        return self._duckdb_conn

    async def test_connection(self) -> tuple[bool, str]:
        """Test that the configured sources can be loaded."""
        try:
            sources = self._get_sources()
            if not sources:
                db = self.info.database
                if db and not _looks_remote(db) and not Path(db).exists():
                    return False, f"Source not found: {db}"
                return False, "No readable files / URIs configured"

            conn = self._init_duckdb()
            conn.execute("SELECT 1").fetchone()

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
