"""
MySQL connection adapter.
"""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from nicemeta.connections.base import (
    ColumnInfo,
    ConnectionAdapter,
    ConnectionInfo,
    TableInfo,
)


class MySQLAdapter(ConnectionAdapter):
    """Adapter for MySQL databases."""

    @property
    def db_type(self) -> str:
        return "mysql"

    def get_connection_url(self) -> str:
        """Generate MySQL connection URL."""
        info = self.info
        password = info.options.get("password", "") if info.options else ""
        auth = f"{info.username}:{password}" if info.username else ""
        host_port = f"{info.host}:{info.port}"
        charset = info.options.get("charset", "utf8mb4") if info.options else "utf8mb4"
        
        if auth:
            return f"mysql://{auth}@{host_port}/{info.database}?charset={charset}"
        return f"mysql://{host_port}/{info.database}?charset={charset}"

    def get_async_connection_url(self) -> str:
        """Generate async MySQL connection URL using aiomysql."""
        info = self.info
        password = info.options.get("password", "") if info.options else ""
        auth = f"{info.username}:{password}" if info.username else ""
        host_port = f"{info.host}:{info.port}"
        charset = info.options.get("charset", "utf8mb4") if info.options else "utf8mb4"
        
        if auth:
            return f"mysql+aiomysql://{auth}@{host_port}/{info.database}?charset={charset}"
        return f"mysql+aiomysql://{host_port}/{info.database}?charset={charset}"

    async def test_connection(self) -> tuple[bool, str]:
        """Test MySQL connection."""
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
        """Get list of schemas (databases) in MySQL."""
        query = """
            SELECT SCHEMA_NAME 
            FROM information_schema.SCHEMATA 
            WHERE SCHEMA_NAME NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
            ORDER BY SCHEMA_NAME
        """
        result = await self.execute_query(query, limit=None)
        if result.error:
            return []
        return [row[0] for row in result.rows]

    async def get_tables(self, schema: str | None = None) -> list[TableInfo]:
        """Get list of tables in MySQL database."""
        # Use current database if no schema specified
        schema_filter = f"AND TABLE_SCHEMA = '{schema}'" if schema else f"AND TABLE_SCHEMA = DATABASE()"
        
        query = f"""
            SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
            FROM information_schema.TABLES
            WHERE TABLE_SCHEMA NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
            {schema_filter}
            ORDER BY TABLE_SCHEMA, TABLE_NAME
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
        """Get columns for a MySQL table."""
        schema_filter = f"TABLE_SCHEMA = '{schema}'" if schema else "TABLE_SCHEMA = DATABASE()"
        
        query = f"""
            SELECT 
                COLUMN_NAME,
                DATA_TYPE,
                IS_NULLABLE,
                COLUMN_DEFAULT,
                COLUMN_KEY
            FROM information_schema.COLUMNS
            WHERE {schema_filter}
                AND TABLE_NAME = '{table}'
            ORDER BY ORDINAL_POSITION
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
                primary_key=row[4] == "PRI",
            )
            for row in result.rows
        ]

