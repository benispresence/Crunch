"""
Amazon Redshift adapter.

Uses the dedicated ``redshift_connector`` driver (preferred over
``psycopg2`` against the postgres dialect because Redshift's wire
quirks — particularly around BYTEA and large result sets — are handled
correctly). The SQLAlchemy dialect is registered as
``redshift+redshift_connector``.

Connection config:

* ``host``, ``port`` (default 5439), ``database``, ``user``, ``password``
* ``options.iam`` — bool, enable IAM auth (uses access key/secret from
  env or ``options``).
* ``options.cluster_identifier`` — required for IAM auth.
* ``options.region``, ``options.access_key_id``, ``options.secret_access_key``.
"""

from __future__ import annotations

from urllib.parse import quote_plus

from nicemeta.connections.adapters.sqla_warehouse import SQLAlchemyWarehouseAdapter


class RedshiftAdapter(SQLAlchemyWarehouseAdapter):
    required_package = ("sqlalchemy_redshift", "sqlalchemy-redshift redshift_connector")

    @property
    def db_type(self) -> str:
        return "redshift"

    def get_connection_url(self) -> str:
        info = self.info
        opts = info.options or {}
        user = quote_plus(info.username or "")
        pw = quote_plus(opts.get("password", "") or "")
        host = info.host or ""
        port = info.port or 5439
        db = info.database or ""
        # Default driver. IAM-auth users typically run via Redshift Data
        # API or boto3, not the SQLAlchemy dialect — we stick to the
        # username/password path here.
        auth = f"{user}:{pw}@" if user else ""
        return f"redshift+redshift_connector://{auth}{host}:{port}/{db}"
