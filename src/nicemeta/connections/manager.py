"""
Connection manager for external data sources.

Provides a unified interface for managing database connections
using the Factory pattern.
"""

from typing import Type

from nicemeta.connections.adapters.csv_adapter import CSVAdapter
from nicemeta.connections.adapters.excel_adapter import ExcelAdapter
from nicemeta.connections.adapters.mysql import MySQLAdapter
from nicemeta.connections.adapters.postgresql import PostgreSQLAdapter
from nicemeta.connections.adapters.sqlite import SQLiteAdapter
from nicemeta.connections.adapters.sqlserver import SQLServerAdapter
from nicemeta.connections.base import ConnectionAdapter, ConnectionInfo
from nicemeta.config.connections import ConnectionConfig, load_connections


class ConnectionManager:
    """
    Manager for database connections.
    
    Uses Factory pattern to create appropriate adapters for different
    database types. Maintains a pool of active connections.
    """

    # Registry of adapter classes by database type
    _adapter_registry: dict[str, Type[ConnectionAdapter]] = {
        "postgresql": PostgreSQLAdapter,
        "mysql": MySQLAdapter,
        "sqlite": SQLiteAdapter,
        "sqlserver": SQLServerAdapter,
        "csv": CSVAdapter,
        "excel": ExcelAdapter,
    }

    def __init__(self):
        """Initialize the connection manager."""
        self._connections: dict[str, ConnectionAdapter] = {}

    @classmethod
    def get_supported_types(cls) -> list[str]:
        """Get list of supported database types."""
        return list(cls._adapter_registry.keys())

    @classmethod
    def register_adapter(
        cls, db_type: str, adapter_class: Type[ConnectionAdapter]
    ) -> None:
        """
        Register a new adapter type.
        
        Allows extending the manager with custom database adapters.
        
        Args:
            db_type: Database type identifier
            adapter_class: Adapter class to use for this type
        """
        cls._adapter_registry[db_type] = adapter_class

    def create_adapter(self, config: ConnectionConfig) -> ConnectionAdapter:
        """
        Create a connection adapter from configuration.
        
        Factory method that returns the appropriate adapter based on
        the connection type.
        
        Args:
            config: Connection configuration
            
        Returns:
            Appropriate ConnectionAdapter instance
            
        Raises:
            ValueError: If database type is not supported
        """
        adapter_class = self._adapter_registry.get(config.type)
        if adapter_class is None:
            raise ValueError(
                f"Unsupported database type: {config.type}. "
                f"Supported types: {', '.join(self.get_supported_types())}"
            )

        info = ConnectionInfo(
            name=config.name,
            db_type=config.type,
            host=config.host,
            port=config.effective_port,
            database=config.database,
            username=config.user,
            options={
                "password": config.password,
                "ssl_mode": config.ssl_mode,
                "charset": config.charset,
                "driver": config.driver,
            },
        )

        return adapter_class(info)

    def add_connection(
        self, name: str, config: ConnectionConfig
    ) -> ConnectionAdapter:
        """
        Add a new connection to the manager.
        
        Args:
            name: Unique name for this connection
            config: Connection configuration
            
        Returns:
            The created adapter
        """
        if name in self._connections:
            raise ValueError(f"Connection '{name}' already exists")

        adapter = self.create_adapter(config)
        self._connections[name] = adapter
        return adapter

    def get_connection(self, name: str) -> ConnectionAdapter | None:
        """
        Get a connection by name.
        
        Args:
            name: Connection name
            
        Returns:
            ConnectionAdapter or None if not found
        """
        return self._connections.get(name)

    def remove_connection(self, name: str) -> bool:
        """
        Remove a connection from the manager.
        
        Args:
            name: Connection name
            
        Returns:
            True if removed, False if not found
        """
        if name in self._connections:
            del self._connections[name]
            return True
        return False

    def list_connections(self) -> list[str]:
        """Get list of all connection names."""
        return list(self._connections.keys())

    def load_from_config(self, path: str | None = None) -> int:
        """
        Load connections from YAML configuration file.
        
        Args:
            path: Path to config file (uses default locations if None)
            
        Returns:
            Number of connections loaded
        """
        config = load_connections(path)
        count = 0

        for conn_config in config.connections:
            try:
                self.add_connection(conn_config.name, conn_config)
                count += 1
            except ValueError:
                # Connection already exists, skip
                pass

        return count

    async def test_connection(self, name: str) -> tuple[bool, str]:
        """
        Test a connection by name.
        
        Args:
            name: Connection name
            
        Returns:
            Tuple of (success, message)
        """
        adapter = self.get_connection(name)
        if adapter is None:
            return False, f"Connection '{name}' not found"

        return await adapter.test_connection()

    async def close_all(self) -> None:
        """Close all connections and cleanup resources."""
        for adapter in self._connections.values():
            await adapter.close()
        self._connections.clear()


# Global connection manager instance
_manager: ConnectionManager | None = None


def get_connection_manager() -> ConnectionManager:
    """
    Get the global connection manager instance.
    
    Creates the instance on first call (lazy initialization).
    """
    global _manager
    if _manager is None:
        _manager = ConnectionManager()
    return _manager

