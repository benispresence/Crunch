"""
BigQuery adapter via ``sqlalchemy-bigquery``.

Connection config:

* ``database`` — GCP project id.
* ``options.dataset`` — optional default dataset (lets unqualified
  ``FROM table`` work).
* ``options.credentials_path`` — path to a service-account JSON.
  Falls back to Application Default Credentials if unset.
* ``options.location`` — optional, e.g. ``EU``, ``US``.
"""

from __future__ import annotations

import os

from nicemeta.connections.adapters.sqla_warehouse import SQLAlchemyWarehouseAdapter
from nicemeta.connections.base import ColumnInfo, TableInfo


class BigQueryAdapter(SQLAlchemyWarehouseAdapter):
    required_package = ("sqlalchemy_bigquery", "sqlalchemy-bigquery")

    @property
    def db_type(self) -> str:
        return "bigquery"

    def get_connection_url(self) -> str:
        info = self.info
        opts = info.options or {}
        project = info.database or opts.get("project") or ""
        dataset = opts.get("dataset")
        # bigquery://project[/dataset]?credentials_path=…&location=…
        url = f"bigquery://{project}"
        if dataset:
            url += f"/{dataset}"
        params: list[str] = []
        cred = opts.get("credentials_path")
        if cred:
            params.append(f"credentials_path={cred}")
            # The driver also reads GOOGLE_APPLICATION_CREDENTIALS; set it
            # too so any side-effecting client (e.g. for introspection)
            # picks the same key.
            os.environ.setdefault("GOOGLE_APPLICATION_CREDENTIALS", cred)
        if opts.get("location"):
            params.append(f"location={opts['location']}")
        if params:
            url += "?" + "&".join(params)
        return url

    # BigQuery's information_schema sits *inside* the dataset, so the
    # generic queries don't return anything useful. Override to use the
    # client library directly.

    async def get_schemas(self) -> list[str]:
        try:
            from google.cloud import bigquery as bq  # type: ignore
        except ImportError:
            return []
        opts = self.info.options or {}
        project = self.info.database or opts.get("project")
        client = bq.Client(project=project, location=opts.get("location"))
        try:
            return sorted(ds.dataset_id for ds in client.list_datasets())
        except Exception:
            return []

    async def get_tables(self, schema: str | None = None) -> list[TableInfo]:
        try:
            from google.cloud import bigquery as bq  # type: ignore
        except ImportError:
            return []
        opts = self.info.options or {}
        project = self.info.database or opts.get("project")
        client = bq.Client(project=project, location=opts.get("location"))
        out: list[TableInfo] = []
        try:
            datasets = [schema] if schema else [ds.dataset_id for ds in client.list_datasets()]
            for ds in datasets:
                for t in client.list_tables(ds):
                    out.append(TableInfo(
                        name=t.table_id, schema=ds,
                        table_type=("view" if t.table_type == "VIEW" else "table"),
                    ))
        except Exception:
            pass
        return out

    async def get_columns(self, table: str, schema: str | None = None) -> list[ColumnInfo]:
        try:
            from google.cloud import bigquery as bq  # type: ignore
        except ImportError:
            return []
        opts = self.info.options or {}
        project = self.info.database or opts.get("project")
        client = bq.Client(project=project, location=opts.get("location"))
        if not schema:
            schema = opts.get("dataset")
        if not schema:
            return []
        try:
            tbl = client.get_table(f"{project}.{schema}.{table}")
            return [
                ColumnInfo(
                    name=f.name, data_type=f.field_type, nullable=(f.mode != "REQUIRED"),
                )
                for f in tbl.schema
            ]
        except Exception:
            return []
