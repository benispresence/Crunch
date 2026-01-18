"""
Connection service for database CRUD operations.

Handles persistence of database connections to the internal database.
"""

from sqlalchemy import select, delete as sql_delete
from sqlalchemy.ext.asyncio import AsyncSession

from nicemeta.core.database import get_session_context
from nicemeta.core.models import Connection


class ConnectionService:
    """Service for managing database connections in the database."""

    @staticmethod
    async def get_all() -> list[dict]:
        """Get all connections."""
        async with get_session_context() as session:
            result = await session.execute(
                select(Connection).where(Connection.is_active == True).order_by(Connection.name)
            )
            connections = result.scalars().all()
            return [ConnectionService._to_dict(c) for c in connections]

    @staticmethod
    async def get_by_id(connection_id: str) -> dict | None:
        """Get a connection by ID."""
        async with get_session_context() as session:
            result = await session.execute(
                select(Connection).where(Connection.id == connection_id)
            )
            connection = result.scalar_one_or_none()
            return ConnectionService._to_dict(connection) if connection else None

    @staticmethod
    async def create(
        name: str,
        db_type: str,
        host: str,
        port: int,
        database: str,
        username: str | None = None,
        password: str | None = None,
        description: str | None = None,
    ) -> dict:
        """Create a new connection."""
        async with get_session_context() as session:
            connection = Connection(
                name=name,
                db_type=db_type,
                host=host,
                port=port,
                database=database,
                username=username,
                password=password,
                description=description,
            )
            session.add(connection)
            await session.flush()
            await session.refresh(connection)
            return ConnectionService._to_dict(connection)

    @staticmethod
    async def update(
        connection_id: str,
        name: str | None = None,
        db_type: str | None = None,
        host: str | None = None,
        port: int | None = None,
        database: str | None = None,
        username: str | None = None,
        password: str | None = None,
        description: str | None = None,
    ) -> dict | None:
        """Update an existing connection."""
        async with get_session_context() as session:
            result = await session.execute(
                select(Connection).where(Connection.id == connection_id)
            )
            connection = result.scalar_one_or_none()
            
            if not connection:
                return None
            
            if name is not None:
                connection.name = name
            if db_type is not None:
                connection.db_type = db_type
            if host is not None:
                connection.host = host
            if port is not None:
                connection.port = port
            if database is not None:
                connection.database = database
            if username is not None:
                connection.username = username
            if password is not None:
                connection.password = password
            if description is not None:
                connection.description = description
            
            await session.flush()
            await session.refresh(connection)
            return ConnectionService._to_dict(connection)

    @staticmethod
    async def delete(connection_id: str) -> bool:
        """Delete a connection by ID (soft delete by setting is_active=False)."""
        async with get_session_context() as session:
            result = await session.execute(
                select(Connection).where(Connection.id == connection_id)
            )
            connection = result.scalar_one_or_none()
            
            if not connection:
                return False
            
            connection.is_active = False
            await session.flush()
            return True

    @staticmethod
    async def hard_delete(connection_id: str) -> bool:
        """Permanently delete a connection."""
        async with get_session_context() as session:
            result = await session.execute(
                sql_delete(Connection).where(Connection.id == connection_id)
            )
            return result.rowcount > 0

    @staticmethod
    def _to_dict(connection: Connection) -> dict:
        """Convert a Connection model to a dictionary."""
        return {
            "id": connection.id,
            "name": connection.name,
            "description": connection.description,
            "db_type": connection.db_type,
            "host": connection.host,
            "port": connection.port,
            "database": connection.database,
            "user": connection.username,  # Alias for compatibility
            "username": connection.username,
            "password": connection.password,
            "is_active": connection.is_active,
            "owner_id": connection.owner_id,
            "created_at": connection.created_at.isoformat() if connection.created_at else None,
            "updated_at": connection.updated_at.isoformat() if connection.updated_at else None,
        }


# Convenience functions for direct import
async def get_connections() -> list[dict]:
    """Get all active connections."""
    return await ConnectionService.get_all()


async def get_connection_by_id(connection_id: str) -> dict | None:
    """Get a connection by ID."""
    return await ConnectionService.get_by_id(connection_id)


async def create_connection(
    name: str,
    db_type: str,
    host: str,
    port: int,
    database: str,
    username: str | None = None,
    password: str | None = None,
) -> dict:
    """Create a new connection."""
    return await ConnectionService.create(
        name=name,
        db_type=db_type,
        host=host,
        port=port,
        database=database,
        username=username,
        password=password,
    )


async def update_connection(
    connection_id: str,
    name: str | None = None,
    db_type: str | None = None,
    host: str | None = None,
    port: int | None = None,
    database: str | None = None,
    username: str | None = None,
    password: str | None = None,
) -> dict | None:
    """Update an existing connection."""
    return await ConnectionService.update(
        connection_id=connection_id,
        name=name,
        db_type=db_type,
        host=host,
        port=port,
        database=database,
        username=username,
        password=password,
    )


async def delete_connection(connection_id: str) -> bool:
    """Delete (soft) a connection."""
    return await ConnectionService.delete(connection_id)

