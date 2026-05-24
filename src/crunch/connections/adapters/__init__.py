"""Database-specific connection adapters."""

from crunch.connections.adapters.bigquery import BigQueryAdapter
from crunch.connections.adapters.clickhouse import ClickHouseAdapter
from crunch.connections.adapters.databricks import DatabricksAdapter
from crunch.connections.adapters.duckdb_adapter import DuckDBAdapter
from crunch.connections.adapters.file_adapter import FileAdapter
from crunch.connections.adapters.mariadb import MariaDBAdapter
from crunch.connections.adapters.mongodb import MongoDBAdapter
from crunch.connections.adapters.mysql import MySQLAdapter
from crunch.connections.adapters.postgresql import PostgreSQLAdapter
from crunch.connections.adapters.redshift import RedshiftAdapter
from crunch.connections.adapters.snowflake import SnowflakeAdapter
from crunch.connections.adapters.sqlite import SQLiteAdapter
from crunch.connections.adapters.sqlserver import SQLServerAdapter
from crunch.connections.adapters.trino import TrinoAdapter

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
