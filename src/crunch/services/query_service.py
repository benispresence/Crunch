"""
Query service for database CRUD operations.

Handles persistence of saved queries to the internal database.
"""

from datetime import datetime

from sqlalchemy import select, delete as sql_delete
from sqlalchemy.ext.asyncio import AsyncSession

from crunch.core.database import get_session_context
from crunch.core.models import Query


class QueryService:
    """Service for managing saved queries in the database."""

    @staticmethod
    async def get_all() -> list[dict]:
        """Get all saved queries."""
        async with get_session_context() as session:
            result = await session.execute(
                select(Query).order_by(Query.updated_at.desc())
            )
            queries = result.scalars().all()
            return [QueryService._to_dict(q) for q in queries]

    @staticmethod
    async def get_by_id(query_id: str) -> dict | None:
        """Get a query by ID."""
        async with get_session_context() as session:
            result = await session.execute(
                select(Query).where(Query.id == query_id)
            )
            query = result.scalar_one_or_none()
            return QueryService._to_dict(query) if query else None

    @staticmethod
    async def create(
        name: str,
        sql: str,
        connection_id: str | None = None,
        folder_id: str | None = None,
        description: str | None = None,
    ) -> dict:
        """Create a new query."""
        async with get_session_context() as session:
            query = Query(
                name=name,
                sql=sql,
                connection_id=connection_id,
                folder_id=folder_id,
                description=description,
                query_type="sql",
            )
            session.add(query)
            await session.flush()
            await session.refresh(query)
            return QueryService._to_dict(query)

    @staticmethod
    async def update(
        query_id: str,
        name: str | None = None,
        sql: str | None = None,
        connection_id: str | None = None,
        folder_id: str | None = None,
        description: str | None = None,
    ) -> dict | None:
        """Update an existing query."""
        async with get_session_context() as session:
            result = await session.execute(
                select(Query).where(Query.id == query_id)
            )
            query = result.scalar_one_or_none()
            
            if not query:
                return None
            
            if name is not None:
                query.name = name
            if sql is not None:
                query.sql = sql
            if connection_id is not None:
                query.connection_id = connection_id
            if folder_id is not None:
                query.folder_id = folder_id
            if description is not None:
                query.description = description
            
            await session.flush()
            await session.refresh(query)
            return QueryService._to_dict(query)

    @staticmethod
    async def delete(query_id: str) -> bool:
        """Delete a query by ID."""
        async with get_session_context() as session:
            result = await session.execute(
                sql_delete(Query).where(Query.id == query_id)
            )
            return result.rowcount > 0

    @staticmethod
    async def save(
        name: str,
        sql: str,
        connection_id: str | None = None,
        folder_id: str | None = None,
        query_id: str | None = None,
    ) -> dict:
        """
        Save a query (create or update).
        
        If query_id is provided and exists, updates. Otherwise creates new.
        """
        if query_id:
            existing = await QueryService.get_by_id(query_id)
            if existing:
                return await QueryService.update(
                    query_id=query_id,
                    name=name,
                    sql=sql,
                    connection_id=connection_id,
                    folder_id=folder_id,
                )
        
        return await QueryService.create(
            name=name,
            sql=sql,
            connection_id=connection_id,
            folder_id=folder_id,
        )

    @staticmethod
    def _to_dict(query: Query) -> dict:
        """Convert a Query model to a dictionary."""
        return {
            "id": query.id,
            "name": query.name,
            "description": query.description,
            "sql": query.sql,
            "query_type": query.query_type,
            "connection_id": query.connection_id,
            "folder_id": query.folder_id,
            "owner_id": query.owner_id,
            "is_public": query.is_public,
            "created_at": query.created_at.isoformat() if query.created_at else None,
            "updated_at": query.updated_at.isoformat() if query.updated_at else None,
            "last_run_at": query.last_run_at.isoformat() if query.last_run_at else None,
            "last_run_row_count": query.last_run_row_count,
        }


# Convenience functions for direct import
async def get_saved_queries() -> list[dict]:
    """Get all saved queries."""
    return await QueryService.get_all()


async def get_query_by_id(query_id: str) -> dict | None:
    """Get a query by ID."""
    return await QueryService.get_by_id(query_id)


async def save_query(
    name: str,
    sql: str,
    connection_id: str | None = None,
    folder_id: str | None = None,
    query_id: str | None = None,
) -> dict:
    """Save a query (create or update)."""
    return await QueryService.save(
        name=name,
        sql=sql,
        connection_id=connection_id,
        folder_id=folder_id,
        query_id=query_id,
    )


async def delete_query(query_id: str) -> bool:
    """Delete a query."""
    return await QueryService.delete(query_id)
