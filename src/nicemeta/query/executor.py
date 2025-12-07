"""
Query execution engine.

Executes SQL queries against data sources with caching and result handling.
"""

import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import pandas as pd

from nicemeta.connections.base import ConnectionAdapter, QueryResult
from nicemeta.connections.manager import ConnectionManager, get_connection_manager
from nicemeta.query.validator import QueryValidator, ValidationResult


@dataclass
class ExecutionResult:
    """Result of query execution with metadata."""
    
    success: bool
    data: pd.DataFrame | None
    columns: list[str]
    row_count: int
    execution_time_ms: float
    error: str | None
    warnings: list[str]
    query: str
    connection_name: str
    executed_at: datetime

    def to_dict_list(self) -> list[dict]:
        """Convert result to list of dictionaries."""
        if self.data is None:
            return []
        return self.data.to_dict(orient="records")

    def to_json(self) -> str:
        """Convert result to JSON string."""
        if self.data is None:
            return "[]"
        return self.data.to_json(orient="records")


class QueryExecutor:
    """
    Executes SQL queries against data source connections.
    
    Provides validation, execution, and result handling with
    support for query limits and timeouts.
    """

    def __init__(
        self,
        connection_manager: ConnectionManager | None = None,
        validator: QueryValidator | None = None,
    ):
        """
        Initialize the query executor.
        
        Args:
            connection_manager: Connection manager instance (uses global if None)
            validator: Query validator instance (creates default if None)
        """
        self._connection_manager = connection_manager
        self._validator = validator or QueryValidator()

    @property
    def connection_manager(self) -> ConnectionManager:
        """Get the connection manager."""
        if self._connection_manager is None:
            self._connection_manager = get_connection_manager()
        return self._connection_manager

    async def execute(
        self,
        sql: str,
        connection_name: str,
        parameters: dict | None = None,
        limit: int | None = 10000,
        validate: bool = True,
    ) -> ExecutionResult:
        """
        Execute a SQL query.
        
        Args:
            sql: SQL query string
            connection_name: Name of the connection to use
            parameters: Optional query parameters
            limit: Maximum rows to return (None for no limit)
            validate: Whether to validate the query first
            
        Returns:
            ExecutionResult with data and metadata
        """
        warnings: list[str] = []
        executed_at = datetime.now()

        # Validate query
        if validate:
            validation = self._validator.validate(sql)
            warnings.extend(validation.warnings)
            
            if not validation.is_valid:
                return ExecutionResult(
                    success=False,
                    data=None,
                    columns=[],
                    row_count=0,
                    execution_time_ms=0,
                    error="; ".join(validation.errors),
                    warnings=warnings,
                    query=sql,
                    connection_name=connection_name,
                    executed_at=executed_at,
                )

        # Get connection
        adapter = self.connection_manager.get_connection(connection_name)
        if adapter is None:
            return ExecutionResult(
                success=False,
                data=None,
                columns=[],
                row_count=0,
                execution_time_ms=0,
                error=f"Connection '{connection_name}' not found",
                warnings=warnings,
                query=sql,
                connection_name=connection_name,
                executed_at=executed_at,
            )

        # Sanitize query
        sql = self._validator.sanitize(sql)

        # Execute query
        try:
            result = await adapter.execute_query(sql, parameters, limit)
            
            if result.error:
                return ExecutionResult(
                    success=False,
                    data=None,
                    columns=result.columns,
                    row_count=0,
                    execution_time_ms=result.execution_time_ms,
                    error=result.error,
                    warnings=warnings,
                    query=sql,
                    connection_name=connection_name,
                    executed_at=executed_at,
                )

            # Convert to DataFrame
            df = result.to_dataframe()
            
            return ExecutionResult(
                success=True,
                data=df,
                columns=result.columns,
                row_count=result.row_count,
                execution_time_ms=result.execution_time_ms,
                error=None,
                warnings=warnings,
                query=sql,
                connection_name=connection_name,
                executed_at=executed_at,
            )

        except Exception as e:
            return ExecutionResult(
                success=False,
                data=None,
                columns=[],
                row_count=0,
                execution_time_ms=0,
                error=str(e),
                warnings=warnings,
                query=sql,
                connection_name=connection_name,
                executed_at=executed_at,
            )

    async def get_preview(
        self,
        table: str,
        connection_name: str,
        schema: str | None = None,
        limit: int = 100,
    ) -> ExecutionResult:
        """
        Get a preview of table data.
        
        Args:
            table: Table name
            connection_name: Connection name
            schema: Optional schema name
            limit: Number of rows to preview
            
        Returns:
            ExecutionResult with preview data
        """
        if schema:
            full_table = f'"{schema}"."{table}"'
        else:
            full_table = f'"{table}"'

        sql = f"SELECT * FROM {full_table}"
        return await self.execute(sql, connection_name, limit=limit)

    async def explain_query(
        self,
        sql: str,
        connection_name: str,
    ) -> ExecutionResult:
        """
        Get the execution plan for a query.
        
        Args:
            sql: SQL query to explain
            connection_name: Connection name
            
        Returns:
            ExecutionResult with explain output
        """
        explain_sql = f"EXPLAIN {sql}"
        return await self.execute(explain_sql, connection_name, validate=False)


# Global executor instance
_executor: QueryExecutor | None = None


def get_query_executor() -> QueryExecutor:
    """Get the global query executor instance."""
    global _executor
    if _executor is None:
        _executor = QueryExecutor()
    return _executor

