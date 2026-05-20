"""
Trino (and PrestoDB) adapter via ``sqlalchemy-trino``.

Connection config:

* ``host``, ``port`` (default 8080 / 8443 with TLS).
* ``user`` — required by Trino (no password by default).
* ``database`` — the catalog name (Trino's "database" is a catalog).
* ``options.schema`` — default schema (optional).
* ``options.http_scheme`` — ``http`` (default) or ``https``.
* ``options.password`` — for BASIC auth deployments.
"""

from __future__ import annotations

from urllib.parse import quote_plus

from nicemeta.connections.adapters.sqla_warehouse import SQLAlchemyWarehouseAdapter


class TrinoAdapter(SQLAlchemyWarehouseAdapter):
    required_package = ("sqlalchemy_trino", "sqlalchemy-trino trino")

    @property
    def db_type(self) -> str:
        return "trino"

    def get_connection_url(self) -> str:
        info = self.info
        opts = info.options or {}
        user = quote_plus(info.username or "anonymous")
        pw = quote_plus(opts.get("password", "") or "")
        host = info.host or "localhost"
        scheme = (opts.get("http_scheme") or "http").lower()
        port = info.port or (8443 if scheme == "https" else 8080)
        catalog = info.database or ""
        schema = opts.get("schema") or ""
        auth = f"{user}:{pw}@" if pw else f"{user}@"
        path = f"/{catalog}" if catalog else ""
        if catalog and schema:
            path += f"/{schema}"
        params = []
        if scheme == "https":
            params.append("protocol=https")
        qs = ("?" + "&".join(params)) if params else ""
        return f"trino://{auth}{host}:{port}{path}{qs}"
