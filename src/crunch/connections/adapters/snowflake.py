"""
Snowflake adapter via ``snowflake-sqlalchemy``.

Connection config (in addition to standard host/database/user/password):

* ``options.account`` — Snowflake account locator (e.g. ``ab12345.us-east-1``).
* ``options.warehouse`` — virtual warehouse name.
* ``options.role`` — role to assume after connect (optional).
* ``options.schema`` — default schema (optional, falls back to ``PUBLIC``).
"""

from __future__ import annotations

from urllib.parse import quote_plus

from crunch.connections.adapters.sqla_warehouse import SQLAlchemyWarehouseAdapter


class SnowflakeAdapter(SQLAlchemyWarehouseAdapter):
    required_package = ("snowflake.sqlalchemy", "snowflake-sqlalchemy")

    @property
    def db_type(self) -> str:
        return "snowflake"

    def get_connection_url(self) -> str:
        info = self.info
        opts = info.options or {}
        account = opts.get("account") or info.host or ""
        user = quote_plus(info.username or "")
        pw = quote_plus(opts.get("password", "") or "")
        db = info.database or ""
        schema = opts.get("schema") or "PUBLIC"
        params: list[str] = []
        if opts.get("warehouse"):
            params.append(f"warehouse={quote_plus(opts['warehouse'])}")
        if opts.get("role"):
            params.append(f"role={quote_plus(opts['role'])}")
        if opts.get("authenticator"):
            params.append(f"authenticator={quote_plus(opts['authenticator'])}")
        qs = ("?" + "&".join(params)) if params else ""
        return f"snowflake://{user}:{pw}@{account}/{db}/{schema}{qs}"
