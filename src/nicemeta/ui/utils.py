"""
Shared UI utilities for NiceMeta.
"""

from nicemeta.connections.base import ConnectionAdapter, ConnectionInfo


async def create_adapter_from_connection(conn: dict) -> ConnectionAdapter:
    """Create the appropriate adapter from a connection dict.

    Handles both file-based (DuckDB) and standard database connections.
    This centralises adapter creation logic used across SQL editor,
    query builder, connections page, and sidebar.
    """
    if conn["db_type"] == "file":
        from nicemeta.connections.adapters.file_adapter import FileAdapter

        options = conn.get("options") or {}
        file_paths = options.get("files", [])

        # Fallback: scan upload directory
        if not file_paths:
            from pathlib import Path

            upload_dir = Path(conn.get("database", ""))
            if upload_dir.is_dir():
                exts = {".csv", ".tsv", ".txt", ".xlsx", ".xls"}
                file_paths = [
                    str(p)
                    for p in sorted(upload_dir.iterdir())
                    if p.is_file() and p.suffix.lower() in exts
                ]

        info = ConnectionInfo(
            name=conn["name"],
            db_type="file",
            host="local",
            port=0,
            database=conn.get("database", ""),
            options={"files": file_paths},
        )
        return FileAdapter(info)
    else:
        from nicemeta.connections.manager import ConnectionManager
        from nicemeta.config.connections import ConnectionConfig

        config = ConnectionConfig(
            name=conn["name"],
            type=conn["db_type"],
            host=conn["host"],
            port=conn["port"],
            database=conn["database"],
            user=conn.get("user", "") or conn.get("username", ""),
            password=conn.get("password", ""),
        )

        manager = ConnectionManager()
        return manager.create_adapter(config)
