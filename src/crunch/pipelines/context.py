"""
Runtime context handed to pipeline scripts.

Pipelines write into one of the user's Crunch *connections*. Resolving
that connection at the engine's boundary — once, before exec — means
user code never sees decrypted credentials in its own source and can
just call ``ctx.dlt_destination()`` or ``ctx.engine``.

This module is intentionally dependency-light so importing it costs
nothing if a caller only wants the dataclasses (e.g. typing).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class PipelineResult:
    """What `execute_pipeline` returns. ``log`` captures everything
    the script wrote to stdout/stderr, capped at a few hundred KB."""

    success: bool
    rows_loaded: int = 0
    log: str = ""
    error: str | None = None
    duration_ms: float = 0.0
    steps: list[Any] | None = None
    output_tables: list[Any] | None = None
    checkpoints: list[Any] | None = None


@dataclass
class PipelineContext:
    """Injected as ``ctx`` into user scripts. Bundles the destination
    credentials so user code can call ``ctx.dlt_destination()`` /
    ``ctx.engine`` without re-typing host/user/password."""

    destination_type: str
    destination_config: dict[str, Any]
    stream_max_seconds: int = 60
    stream_max_messages: int = 10000
    source_engine: Any = None  # populated for SQL-source pipelines
    source_config: dict[str, Any] | None = None

    def dlt_destination(self) -> Any:
        """Return a dlt destination instance pre-configured with the
        credentials of the user's Crunch connection. Falls back to a
        plain destination name when dlt is missing or the destination
        type isn't supported."""
        try:
            import dlt as _dlt
        except ImportError as e:
            raise RuntimeError(
                "This pipeline needs the 'dlt' package. Install with: pip install dlt"
            ) from e
        dt = self.destination_type
        c = self.destination_config

        if dt in ("postgres", "postgresql"):
            return _dlt.destinations.postgres(
                {
                    "host": c.get("host"),
                    "port": c.get("port") or 5432,
                    "database": c.get("database"),
                    "username": c.get("user"),
                    "password": c.get("password"),
                }
            )
        if dt == "duckdb":
            path = c.get("database") or ":memory:"
            return _dlt.destinations.duckdb(path)
        if dt == "snowflake":
            return _dlt.destinations.snowflake(
                {
                    "account": (c.get("options") or {}).get("account") or c.get("host"),
                    "username": c.get("user"),
                    "password": c.get("password"),
                    "database": c.get("database"),
                    "warehouse": (c.get("options") or {}).get("warehouse"),
                    "role": (c.get("options") or {}).get("role"),
                }
            )
        if dt == "bigquery":
            return _dlt.destinations.bigquery(
                {
                    "project_id": c.get("database"),
                    "credentials": (c.get("options") or {}).get("credentials_path"),
                }
            )
        if dt == "redshift":
            return _dlt.destinations.redshift(
                {
                    "host": c.get("host"),
                    "port": c.get("port") or 5439,
                    "database": c.get("database"),
                    "username": c.get("user"),
                    "password": c.get("password"),
                }
            )
        if dt == "databricks":
            opts = c.get("options") or {}
            return _dlt.destinations.databricks(
                {
                    "server_hostname": c.get("host"),
                    "http_path": opts.get("http_path"),
                    "access_token": opts.get("access_token") or c.get("password"),
                    "catalog": c.get("database"),
                }
            )
        if dt in ("mssql", "sqlserver"):
            return _dlt.destinations.mssql(
                {
                    "host": c.get("host"),
                    "port": c.get("port") or 1433,
                    "database": c.get("database"),
                    "username": c.get("user"),
                    "password": c.get("password"),
                }
            )
        # Fall back to a string name — dlt will read its own env config.
        return dt

    @property
    def engine(self) -> Any:
        """SQLAlchemy engine for the destination, for users who want
        to bypass dlt and write into the database directly."""
        from sqlalchemy import create_engine

        return create_engine(sqlalchemy_url(self.destination_type, self.destination_config))


def sqlalchemy_url(destination_type: str, config: dict[str, Any]) -> str:
    """Build a SQLAlchemy URL from a decrypted connection dict."""
    c = config or {}
    if c.get("connection_url"):
        return str(c["connection_url"])
    dt = (destination_type or str(c.get("type") or "")).lower()
    database = c.get("database") or ":memory:"
    user = c.get("user") or ""
    password = c.get("password") or ""
    host = c.get("host") or "localhost"
    port = c.get("port")
    if dt in ("postgres", "postgresql"):
        return (
            f"postgresql+psycopg2://{user}:{password}@{host}:{port or 5432}/{database}"
        )
    if dt == "sqlite":
        return f"sqlite:///{database}"
    if dt == "duckdb":
        return f"duckdb:///{database}"
    if dt in ("mysql", "mariadb"):
        return f"mysql+pymysql://{user}:{password}@{host}:{port or 3306}/{database}"
    if dt in ("mssql", "sqlserver"):
        return f"mssql+pyodbc://{user}:{password}@{host}:{port or 1433}/{database}"
    return "sqlite:///:memory:"
