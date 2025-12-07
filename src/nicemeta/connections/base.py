"""
Base connection adapter interface.

Defines the abstract interface for all database connection adapters.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

import pandas as pd
from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession


@dataclass
class ConnectionInfo:
    """Information about a database connection."""

    name: str
    db_type: str
    host: str
    port: int
    database: str
    username: str | None = None
    options: dict | None = None


@dataclass
class TableInfo:
    """Information about a database table."""

    name: str
    schema: str | None = None
    table_type: str = "table"  # table, view, etc.


@dataclass
class ColumnInfo:
    """Information about a table column."""

    name: str
    data_type: str
    nullable: bool = True
    primary_key: bool = False
    default: str | None = None


@dataclass
class QueryResult:
    """Result of a query execution."""

    columns: list[str]
    rows: list[tuple]
    row_count: int
    execution_time_ms: float
    error: str | None = None

    def to_dataframe(self) -> pd.DataFrame:
        """Convert result to pandas DataFrame."""
        return pd.DataFrame(self.rows, columns=self.columns)

    def to_dict_list(self) -> list[dict]:
        """Convert result to list of dictionaries."""
        return [dict(zip(self.columns, row)) for row in self.rows]


class ConnectionAdapter(ABC):
    """
    Abstract base class for database connection adapters.
    
    Implements the Adapter pattern to provide a uniform interface
    for different database types.
    """

    def __init__(self, info: ConnectionInfo):
        """Initialize adapter with connection info."""
        self.info = info
        self._engine: AsyncEngine | None = None

    @property
    @abstractmethod
    def db_type(self) -> str:
        """Return the database type identifier."""
        pass

    @abstractmethod
    def get_connection_url(self) -> str:
        """Generate the SQLAlchemy connection URL."""
        pass

    @abstractmethod
    def get_async_connection_url(self) -> str:
        """Generate the async SQLAlchemy connection URL."""
        pass

    @abstractmethod
    async def test_connection(self) -> tuple[bool, str]:
        """
        Test if the connection is valid.
        
        Returns:
            Tuple of (success, message)
        """
        pass

    @abstractmethod
    async def get_tables(self, schema: str | None = None) -> list[TableInfo]:
        """
        Get list of tables in the database.
        
        Args:
            schema: Optional schema name to filter by
            
        Returns:
            List of TableInfo objects
        """
        pass

    @abstractmethod
    async def get_columns(
        self, table: str, schema: str | None = None
    ) -> list[ColumnInfo]:
        """
        Get columns for a specific table.
        
        Args:
            table: Table name
            schema: Optional schema name
            
        Returns:
            List of ColumnInfo objects
        """
        pass

    @abstractmethod
    async def get_schemas(self) -> list[str]:
        """Get list of schemas in the database."""
        pass

    async def execute_query(
        self,
        sql: str,
        parameters: dict | None = None,
        limit: int | None = 10000,
    ) -> QueryResult:
        """
        Execute a SQL query and return results.
        
        Args:
            sql: SQL query string
            parameters: Optional query parameters
            limit: Maximum number of rows to return
            
        Returns:
            QueryResult with columns and rows
        """
        import time
        from sqlalchemy.ext.asyncio import create_async_engine

        start_time = time.time()
        
        try:
            if self._engine is None:
                self._engine = create_async_engine(
                    self.get_async_connection_url(),
                    pool_pre_ping=True,
                )

            # Apply limit if not already in query
            if limit and "LIMIT" not in sql.upper():
                sql = f"{sql.rstrip().rstrip(';')} LIMIT {limit}"

            async with self._engine.connect() as conn:
                result = await conn.execute(
                    text(sql),
                    parameters or {},
                )
                
                columns = list(result.keys())
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
        """Close the connection and cleanup resources."""
        if self._engine is not None:
            await self._engine.dispose()
            self._engine = None

