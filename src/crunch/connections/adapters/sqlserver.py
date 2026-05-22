"""
SQL Server connection adapter.
"""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from crunch.connections.base import (
    ColumnInfo,
    ConnectionAdapter,
    ConnectionInfo,
    TableInfo,
)


class SQLServerAdapter(ConnectionAdapter):
    """Adapter for Microsoft SQL Server databases."""

    @property
    def db_type(self) -> str:
        return "sqlserver"

    def get_connection_url(self) -> str:
        """Generate SQL Server connection URL."""
        info = self.info
        password = info.options.get("password", "") if info.options else ""
        driver = info.options.get("driver", "ODBC Driver 18 for SQL Server") if info.options else "ODBC Driver 18 for SQL Server"
        
        # URL encode the driver name
        driver_encoded = driver.replace(" ", "+")
        
        auth = f"{info.username}:{password}" if info.username else ""
        host_port = f"{info.host}:{info.port}"
        
        if auth:
            return f"mssql+pyodbc://{auth}@{host_port}/{info.database}?driver={driver_encoded}&TrustServerCertificate=yes"
        return f"mssql+pyodbc://{host_port}/{info.database}?driver={driver_encoded}&TrustServerCertificate=yes"

    def get_async_connection_url(self) -> str:
        """
        Generate async SQL Server connection URL.
        
        Note: aioodbc is experimental. For production, consider using
        synchronous execution in a thread pool.
        """
        # SQL Server async support is limited, use sync URL with run_sync
        return self.get_connection_url()

    async def test_connection(self) -> tuple[bool, str]:
        """Test SQL Server connection."""
        try:
            # SQL Server doesn't have great async support, use sync engine
            from sqlalchemy import create_engine
            
            engine = create_engine(
                self.get_connection_url(),
                pool_pre_ping=True,
            )
            with engine.connect() as conn:
                result = conn.execute(text("SELECT 1"))
                result.fetchone()
            engine.dispose()
            return True, "Connection successful"
        except Exception as e:
            return False, f"Connection failed: {str(e)}"

    async def get_schemas(self) -> list[str]:
        """Get list of schemas in SQL Server database."""
        query = """
            SELECT SCHEMA_NAME 
            FROM INFORMATION_SCHEMA.SCHEMATA 
            WHERE SCHEMA_NAME NOT IN ('guest', 'INFORMATION_SCHEMA', 'sys', 'db_owner', 'db_accessadmin', 'db_securityadmin', 'db_ddladmin', 'db_backupoperator', 'db_datareader', 'db_datawriter', 'db_denydatareader', 'db_denydatawriter')
            ORDER BY SCHEMA_NAME
        """
        result = await self.execute_query(query, limit=None)
        if result.error:
            return []
        return [row[0] for row in result.rows]

    async def get_tables(self, schema: str | None = None) -> list[TableInfo]:
        """Get list of tables in SQL Server database."""
        schema_filter = f"AND TABLE_SCHEMA = '{schema}'" if schema else ""
        
        query = f"""
            SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
            FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_TYPE IN ('BASE TABLE', 'VIEW')
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
        """Get columns for a SQL Server table."""
        schema_name = schema or "dbo"
        
        query = f"""
            SELECT 
                c.COLUMN_NAME,
                c.DATA_TYPE,
                c.IS_NULLABLE,
                c.COLUMN_DEFAULT,
                CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END as is_pk
            FROM INFORMATION_SCHEMA.COLUMNS c
            LEFT JOIN (
                SELECT ku.COLUMN_NAME
                FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
                    ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
                WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
                    AND tc.TABLE_SCHEMA = '{schema_name}'
                    AND tc.TABLE_NAME = '{table}'
            ) pk ON c.COLUMN_NAME = pk.COLUMN_NAME
            WHERE c.TABLE_SCHEMA = '{schema_name}'
                AND c.TABLE_NAME = '{table}'
            ORDER BY c.ORDINAL_POSITION
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
                primary_key=bool(row[4]),
            )
            for row in result.rows
        ]

    async def execute_query(
        self,
        sql: str,
        parameters: dict | None = None,
        limit: int | None = 10000,
    ):
        """
        Execute SQL Server query.
        
        Overrides base to use synchronous execution due to limited async support.
        """
        import time
        from sqlalchemy import create_engine
        
        from crunch.connections.base import QueryResult

        start_time = time.time()
        
        try:
            engine = create_engine(
                self.get_connection_url(),
                pool_pre_ping=True,
            )

            # Apply TOP limit for SQL Server (different syntax than LIMIT)
            if limit and "TOP" not in sql.upper() and "LIMIT" not in sql.upper():
                # Insert TOP after SELECT
                sql = sql.replace("SELECT", f"SELECT TOP {limit}", 1)

            with engine.connect() as conn:
                result = conn.execute(
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
        finally:
            if 'engine' in locals():
                engine.dispose()

