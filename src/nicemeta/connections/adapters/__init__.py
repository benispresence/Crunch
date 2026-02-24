"""Database-specific connection adapters."""

from nicemeta.connections.adapters.file_adapter import FileAdapter
from nicemeta.connections.adapters.mysql import MySQLAdapter
from nicemeta.connections.adapters.postgresql import PostgreSQLAdapter
from nicemeta.connections.adapters.sqlite import SQLiteAdapter
from nicemeta.connections.adapters.sqlserver import SQLServerAdapter

__all__ = [
    "FileAdapter",
    "PostgreSQLAdapter",
    "MySQLAdapter",
    "SQLiteAdapter",
    "SQLServerAdapter",
]

