"""Database-specific connection adapters."""

from crunch.connections.adapters.file_adapter import FileAdapter
from crunch.connections.adapters.mysql import MySQLAdapter
from crunch.connections.adapters.postgresql import PostgreSQLAdapter
from crunch.connections.adapters.sqlite import SQLiteAdapter
from crunch.connections.adapters.sqlserver import SQLServerAdapter

__all__ = [
    "FileAdapter",
    "PostgreSQLAdapter",
    "MySQLAdapter",
    "SQLiteAdapter",
    "SQLServerAdapter",
]

