"""
ClickHouse adapter via ``clickhouse-sqlalchemy``.

Defaults to the HTTP interface (port 8123 / 8443 with TLS) since that's
the most common deployment. Set ``options.protocol = 'native'`` to use
the binary TCP protocol on 9000/9440.
"""

from __future__ import annotations

from urllib.parse import quote_plus

from crunch.connections.adapters.sqla_warehouse import SQLAlchemyWarehouseAdapter


class ClickHouseAdapter(SQLAlchemyWarehouseAdapter):
    required_package = ("clickhouse_sqlalchemy", "clickhouse-sqlalchemy")

    @property
    def db_type(self) -> str:
        return "clickhouse"

    def get_connection_url(self) -> str:
        info = self.info
        opts = info.options or {}
        user = quote_plus(info.username or "default")
        pw = quote_plus(opts.get("password", "") or "")
        host = info.host or "localhost"
        protocol = (opts.get("protocol") or "http").lower()
        secure = bool(opts.get("secure"))
        default_port = (
            8443 if (protocol == "http" and secure) else
            8123 if protocol == "http" else
            9440 if secure else
            9000
        )
        port = info.port or default_port
        db = info.database or "default"
        dialect = "clickhouse+native" if protocol == "native" else "clickhouse+http"
        params: list[str] = []
        if secure and protocol == "http":
            params.append("protocol=https")
        if secure and protocol == "native":
            params.append("secure=true")
        qs = ("?" + "&".join(params)) if params else ""
        auth = f"{user}:{pw}@" if user else ""
        return f"{dialect}://{auth}{host}:{port}/{db}{qs}"
