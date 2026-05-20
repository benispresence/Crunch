"""Database-specific connection adapters."""

from nicemeta.connections.adapters.bigquery import BigQueryAdapter
from nicemeta.connections.adapters.clickhouse import ClickHouseAdapter
from nicemeta.connections.adapters.databricks import DatabricksAdapter
from nicemeta.connections.adapters.duckdb_adapter import DuckDBAdapter
from nicemeta.connections.adapters.file_adapter import FileAdapter
from nicemeta.connections.adapters.mariadb import MariaDBAdapter
from nicemeta.connections.adapters.mongodb import MongoDBAdapter
from nicemeta.connections.adapters.mysql import MySQLAdapter
from nicemeta.connections.adapters.postgresql import PostgreSQLAdapter
from nicemeta.connections.adapters.redshift import RedshiftAdapter
from nicemeta.connections.adapters.snowflake import SnowflakeAdapter
from nicemeta.connections.adapters.sqlite import SQLiteAdapter
from nicemeta.connections.adapters.sqlserver import SQLServerAdapter
from nicemeta.connections.adapters.trino import TrinoAdapter

__all__ = [
    "BigQueryAdapter",
    "ClickHouseAdapter",
    "DatabricksAdapter",
    "DuckDBAdapter",
    "FileAdapter",
    "MariaDBAdapter",
    "MongoDBAdapter",
    "MySQLAdapter",
    "PostgreSQLAdapter",
    "RedshiftAdapter",
    "SnowflakeAdapter",
    "SQLiteAdapter",
    "SQLServerAdapter",
    "TrinoAdapter",
]
