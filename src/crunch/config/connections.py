"""
Data source connection configuration loader.

Loads external database connections from YAML configuration.
"""

from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field


class ConnectionConfig(BaseModel):
    """Configuration for a single data source connection."""

    name: str
    type: Literal["postgresql", "mysql", "sqlite", "sqlserver", "file"]
    host: str = "localhost"
    port: int | None = None
    database: str = ""
    user: str = ""
    password: str = ""
    
    # Optional settings
    ssl_mode: str | None = None
    charset: str | None = None
    driver: str | None = None  # For SQL Server ODBC driver

    @property
    def default_port(self) -> int:
        """Get default port for connection type."""
        ports = {
            "postgresql": 5432,
            "mysql": 3306,
            "sqlite": 0,
            "sqlserver": 1433,
        }
        return ports.get(self.type, 0)

    @property
    def effective_port(self) -> int:
        """Get the effective port (specified or default)."""
        return self.port if self.port is not None else self.default_port


class ConnectionsConfig(BaseModel):
    """Root configuration containing all connections."""

    connections: list[ConnectionConfig] = Field(default_factory=list)


def find_connections_file() -> Path | None:
    """
    Find the connections configuration file in standard locations.
    
    Searches in order:
    1. ./config/connections.yaml
    2. ./connections.yaml
    3. ~/.config/nicemeta/connections.yaml
    """
    search_paths = [
        Path("config/connections.yaml"),
        Path("connections.yaml"),
        Path.home() / ".config" / "nicemeta" / "connections.yaml",
    ]

    for path in search_paths:
        if path.exists():
            return path

    return None


def load_connections(path: Path | str | None = None) -> ConnectionsConfig:
    """
    Load connections from a YAML file.
    
    Args:
        path: Path to YAML file. If None, searches standard locations.
        
    Returns:
        ConnectionsConfig with loaded connections (empty if no file found).
    """
    if path is None:
        path = find_connections_file()
    
    if path is None:
        return ConnectionsConfig()
    
    path = Path(path)
    if not path.exists():
        return ConnectionsConfig()

    with open(path, "r") as f:
        data = yaml.safe_load(f) or {}

    return ConnectionsConfig(**data)


def save_connections(config: ConnectionsConfig, path: Path | str) -> None:
    """
    Save connections to a YAML file.
    
    Args:
        config: Connections configuration to save.
        path: Path to save the YAML file.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    data = config.model_dump(exclude_none=True)
    
    with open(path, "w") as f:
        yaml.dump(data, f, default_flow_style=False, sort_keys=False)

