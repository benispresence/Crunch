"""
Query service for managing saved queries.
"""

from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from nicemeta.core.models import Query, Visualization
from nicemeta.query.executor import QueryExecutor, ExecutionResult


class QueryService:
    """
    Service for managing queries.
    
    Provides CRUD operations and execution for saved queries.
    """

    def __init__(self, session: AsyncSession, executor: QueryExecutor | None = None):
        """
        Initialize the query service.
        
        Args:
            session: Database session
            executor: Query executor (uses default if None)
        """
        self.session = session
        self.executor = executor or QueryExecutor()

    async def create_query(
        self,
        name: str,
        owner_id: str,
        connection_id: str | None = None,
        sql: str | None = None,
        visual_query: dict | None = None,
        folder_id: str | None = None,
        description: str | None = None,
    ) -> Query:
        """
        Create a new query.
        
        Args:
            name: Query name
            owner_id: Owner user ID
            connection_id: Data source connection ID
            sql: Raw SQL (for SQL queries)
            visual_query: Visual query definition (for visual queries)
            folder_id: Parent folder ID
            description: Query description
            
        Returns:
            Created Query object
        """
        query_type = "visual" if visual_query else "sql"
        
        query = Query(
            name=name,
            description=description,
            query_type=query_type,
            sql=sql,
            visual_query=visual_query,
            connection_id=connection_id,
            folder_id=folder_id,
            owner_id=owner_id,
        )
        
        self.session.add(query)
        await self.session.flush()
        
        return query

    async def get_query(self, query_id: str) -> Query | None:
        """Get a query by ID."""
        result = await self.session.execute(
            select(Query).where(Query.id == query_id)
        )
        return result.scalar_one_or_none()

    async def get_queries_by_owner(
        self,
        owner_id: str,
        folder_id: str | None = None,
    ) -> list[Query]:
        """Get all queries owned by a user."""
        stmt = select(Query).where(Query.owner_id == owner_id)
        
        if folder_id is not None:
            stmt = stmt.where(Query.folder_id == folder_id)
        
        result = await self.session.execute(stmt.order_by(Query.updated_at.desc()))
        return list(result.scalars().all())

    async def update_query(
        self,
        query_id: str,
        **updates,
    ) -> Query | None:
        """
        Update a query.
        
        Args:
            query_id: Query ID
            **updates: Fields to update
            
        Returns:
            Updated Query or None if not found
        """
        query = await self.get_query(query_id)
        if not query:
            return None
        
        for key, value in updates.items():
            if hasattr(query, key):
                setattr(query, key, value)
        
        await self.session.flush()
        return query

    async def delete_query(self, query_id: str) -> bool:
        """
        Delete a query.
        
        Args:
            query_id: Query ID
            
        Returns:
            True if deleted, False if not found
        """
        query = await self.get_query(query_id)
        if not query:
            return False
        
        await self.session.delete(query)
        await self.session.flush()
        return True

    async def execute_query(
        self,
        query_id: str,
        connection_name: str | None = None,
        limit: int = 10000,
    ) -> ExecutionResult:
        """
        Execute a saved query.
        
        Args:
            query_id: Query ID
            connection_name: Override connection name
            limit: Row limit
            
        Returns:
            ExecutionResult with data
        """
        query = await self.get_query(query_id)
        if not query:
            return ExecutionResult(
                success=False,
                data=None,
                columns=[],
                row_count=0,
                execution_time_ms=0,
                error="Query not found",
                warnings=[],
                query="",
                connection_name="",
                executed_at=datetime.now(),
            )
        
        # Get SQL
        if query.query_type == "sql":
            sql = query.sql or ""
        else:
            from nicemeta.query.builder import QueryBuilder, VisualQuery
            builder = QueryBuilder()
            visual = VisualQuery.from_dict(query.visual_query or {})
            sql = builder.build(visual)
        
        # Determine connection
        conn_name = connection_name
        if not conn_name and query.connection_id:
            # In production, lookup connection name from ID
            conn_name = query.connection_id
        
        if not conn_name:
            return ExecutionResult(
                success=False,
                data=None,
                columns=[],
                row_count=0,
                execution_time_ms=0,
                error="No connection specified",
                warnings=[],
                query=sql,
                connection_name="",
                executed_at=datetime.now(),
            )
        
        # Execute
        result = await self.executor.execute(sql, conn_name, limit=limit)
        
        # Update query metadata
        query.last_run_at = datetime.now()
        query.last_run_row_count = result.row_count
        await self.session.flush()
        
        return result

    async def duplicate_query(
        self,
        query_id: str,
        new_name: str | None = None,
        new_owner_id: str | None = None,
    ) -> Query | None:
        """
        Duplicate a query.
        
        Args:
            query_id: Query ID to duplicate
            new_name: Name for the copy
            new_owner_id: Owner for the copy
            
        Returns:
            New Query or None if original not found
        """
        original = await self.get_query(query_id)
        if not original:
            return None
        
        copy = Query(
            name=new_name or f"{original.name} (Copy)",
            description=original.description,
            query_type=original.query_type,
            sql=original.sql,
            visual_query=original.visual_query,
            connection_id=original.connection_id,
            folder_id=original.folder_id,
            owner_id=new_owner_id or original.owner_id,
        )
        
        self.session.add(copy)
        await self.session.flush()
        
        return copy

