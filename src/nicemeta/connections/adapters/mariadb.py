"""
MariaDB adapter — wire-compatible with MySQL, so we just relabel the
existing MySQL adapter. Keeps the connection type chip honest and lets
us special-case anything MariaDB-only in the future without touching
the MySQL path.
"""

from __future__ import annotations

from nicemeta.connections.adapters.mysql import MySQLAdapter


class MariaDBAdapter(MySQLAdapter):
    @property
    def db_type(self) -> str:
        return "mariadb"
