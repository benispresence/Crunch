"""
Databricks SQL adapter via ``databricks-sql-connector``.

Connection config:

* ``host`` — server hostname, e.g. ``adb-1234567890.4.azuredatabricks.net``.
* ``options.http_path`` — the HTTP path of the SQL warehouse
  (``/sql/1.0/warehouses/<id>``).
* ``options.access_token`` — personal access token.
* ``database`` — default catalog.
* ``options.schema`` — default schema (optional).
"""

from __future__ import annotations

from urllib.parse import quote_plus

from crunch.connections.adapters.sqla_warehouse import SQLAlchemyWarehouseAdapter


class DatabricksAdapter(SQLAlchemyWarehouseAdapter):
    required_package = ("databricks.sqlalchemy", "databricks-sql-connector")

    @property
    def db_type(self) -> str:
        return "databricks"

    def get_connection_url(self) -> str:
        info = self.info
        opts = info.options or {}
        host = info.host or ""
        token = quote_plus(opts.get("access_token") or opts.get("password") or "")
        http_path = opts.get("http_path", "")
        catalog = info.database or ""
        schema = opts.get("schema") or ""
        params = [f"http_path={quote_plus(http_path)}"] if http_path else []
        if catalog:
            params.append(f"catalog={quote_plus(catalog)}")
        if schema:
            params.append(f"schema={quote_plus(schema)}")
        qs = ("?" + "&".join(params)) if params else ""
        return f"databricks://token:{token}@{host}{qs}"
