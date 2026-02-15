"""
Shared UI helper utilities for NiceMeta.
"""

from nicemeta.config.connections import ConnectionConfig


def connection_config_from_dict(conn: dict) -> ConnectionConfig:
    """Convert a connection dict (from cache/DB) to a ConnectionConfig."""
    return ConnectionConfig(
        name=conn["name"],
        type=conn["db_type"],
        host=conn["host"],
        port=conn["port"],
        database=conn["database"],
        user=conn.get("user", "") or conn.get("username", ""),
        password=conn.get("password", ""),
    )
