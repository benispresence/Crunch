"""
PostgreSQL connection adapter.
"""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from nicemeta.connections.base import (
    ColumnInfo,
    ConnectionAdapter,
    ConnectionInfo,
    TableInfo,
)


class PostgreSQLAdapter(ConnectionAdapter):
    """Adapter for PostgreSQL databases."""

    @property
    def db_type(self) -> str:
        return "postgresql"

    def get_connection_url(self) -> str:
        """Generate PostgreSQL connection URL."""
        info = self.info
        auth = f"{info.username}:{info.options.get('password', '')}" if info.username else ""
        host_port = f"{info.host}:{info.port}"
        
        if auth:
            return f"postgresql://{auth}@{host_port}/{info.database}"
        return f"postgresql://{host_port}/{info.database}"

    def get_async_connection_url(self) -> str:
        """Generate async PostgreSQL connection URL using asyncpg."""
        info = self.info
        password = info.options.get("password", "") if info.options else ""
        auth = f"{info.username}:{password}" if info.username else ""
        host_port = f"{info.host}:{info.port}"
        
        if auth:
            return f"postgresql+asyncpg://{auth}@{host_port}/{info.database}"
        return f"postgresql+asyncpg://{host_port}/{info.database}"

    async def test_connection(self) -> tuple[bool, str]:
        """Test PostgreSQL connection."""
        try:
            engine = create_async_engine(
                self.get_async_connection_url(),
                pool_pre_ping=True,
            )
            async with engine.connect() as conn:
                result = await conn.execute(text("SELECT 1"))
                result.fetchone()
            await engine.dispose()
            return True, "Connection successful"
        except Exception as e:
            return False, f"Connection failed: {str(e)}"

    async def get_schemas(self) -> list[str]:
        """Get list of schemas in PostgreSQL database."""
        query = """
            SELECT schema_name 
            FROM information_schema.schemata 
            WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
            ORDER BY schema_name
        """
        result = await self.execute_query(query, limit=None)
        if result.error:
            return []
        return [row[0] for row in result.rows]

    async def get_tables(self, schema: str | None = None) -> list[TableInfo]:
        """Get list of tables in PostgreSQL database."""
        schema_filter = f"AND table_schema = '{schema}'" if schema else ""
        
        query = f"""
            SELECT table_schema, table_name, table_type
            FROM information_schema.tables
            WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
            {schema_filter}
            ORDER BY table_schema, table_name
        """
        result = await self.execute_query(query, limit=None)
        if result.error:
            return []
        
        return [
            TableInfo(
                name=row[1],
                schema=row[0],
                table_type="view" if row[2] == "VIEW" else "table",
            )
            for row in result.rows
        ]

    async def get_columns(
        self, table: str, schema: str | None = None
    ) -> list[ColumnInfo]:
        """Get columns for a PostgreSQL table."""
        schema_name = schema or "public"
        
        query = f"""
            SELECT 
                c.column_name,
                c.data_type,
                c.is_nullable,
                c.column_default,
                CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_pk
            FROM information_schema.columns c
            LEFT JOIN (
                SELECT ku.column_name
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage ku
                    ON tc.constraint_name = ku.constraint_name
                WHERE tc.constraint_type = 'PRIMARY KEY'
                    AND tc.table_schema = '{schema_name}'
                    AND tc.table_name = '{table}'
            ) pk ON c.column_name = pk.column_name
            WHERE c.table_schema = '{schema_name}'
                AND c.table_name = '{table}'
            ORDER BY c.ordinal_position
        """
        result = await self.execute_query(query, limit=None)
        if result.error:
            return []
        
        return [
            ColumnInfo(
                name=row[0],
                data_type=row[1],
                nullable=row[2] == "YES",
                default=row[3],
                primary_key=row[4],
            )
            for row in result.rows
        ]

