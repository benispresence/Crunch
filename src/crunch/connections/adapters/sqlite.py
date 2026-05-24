"""
SQLite connection adapter.
"""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from crunch.connections.base import (
    ColumnInfo,
    ConnectionAdapter,
    ConnectionInfo,
    TableInfo,
)


class SQLiteAdapter(ConnectionAdapter):
    """Adapter for SQLite databases."""

    @property
    def db_type(self) -> str:
        return "sqlite"

    def get_connection_url(self) -> str:
        """Generate SQLite connection URL."""
        return f"sqlite:///{self.info.database}"

    def get_async_connection_url(self) -> str:
        """Generate async SQLite connection URL using aiosqlite."""
        return f"sqlite+aiosqlite:///{self.info.database}"

    async def test_connection(self) -> tuple[bool, str]:
        """Test SQLite connection."""
        try:
            engine = create_async_engine(
                self.get_async_connection_url(),
                connect_args={"check_same_thread": False},
            )
            async with engine.connect() as conn:
                result = await conn.execute(text("SELECT 1"))
                result.fetchone()
            await engine.dispose()
            return True, "Connection successful"
        except Exception as e:
            return False, f"Connection failed: {str(e)}"

    async def get_schemas(self) -> list[str]:
        """SQLite doesn't have schemas, return main."""
        return ["main"]

    async def get_tables(self, schema: str | None = None) -> list[TableInfo]:
        """Get list of tables in SQLite database."""
        query = """
            SELECT name, type 
            FROM sqlite_master 
            WHERE type IN ('table', 'view') 
                AND name NOT LIKE 'sqlite_%'
            ORDER BY name
        """
        result = await self.execute_query(query, limit=None)
        if result.error:
            return []
        
        return [
            TableInfo(
                name=row[0],
                schema="main",
                table_type=row[1],
            )
            for row in result.rows
        ]

    async def get_columns(
        self, table: str, schema: str | None = None
    ) -> list[ColumnInfo]:
        """Get columns for a SQLite table."""
        query = f"PRAGMA table_info('{table}')"
        result = await self.execute_query(query, limit=None)
        if result.error:
            return []
        
        # PRAGMA table_info returns: cid, name, type, notnull, dflt_value, pk
        return [
            ColumnInfo(
                name=row[1],
                data_type=row[2] or "TEXT",
                nullable=row[3] == 0,
                default=row[4],
                primary_key=row[5] == 1,
            )
            for row in result.rows
        ]

