"""
MongoDB adapter via ``pymongo``.

MongoDB is not SQL; instead of a SELECT, the "query" field carries a
JSON document with one of two shapes:

1. **Find query**::

       {"collection": "users", "find": {"status": "active"},
        "sort": {"created_at": -1}, "limit": 100}

2. **Aggregation pipeline**::

       {"collection": "orders",
        "pipeline": [{"$match": {"status": "paid"}},
                     {"$group": {"_id": "$user_id", "n": {"$sum": 1}}}]}

Either form returns top-level scalar fields as columns; nested objects
and arrays are JSON-stringified so they still fit a tabular result.
The python engine recognises ``mongodb`` connections and skips its
SQL validator + ``{{var}}`` templating before handing the body here.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

from nicemeta.connections.base import (
    ColumnInfo,
    ConnectionAdapter,
    ConnectionInfo,
    QueryResult,
    TableInfo,
)

logger = logging.getLogger(__name__)


class MongoDBAdapter(ConnectionAdapter):
    """Adapter for MongoDB databases."""

    def __init__(self, info: ConnectionInfo):
        super().__init__(info)
        self._client: Any | None = None

    @property
    def db_type(self) -> str:
        return "mongodb"

    def get_connection_url(self) -> str:  # MongoDB URIs aren't SQLAlchemy URLs
        return self._mongo_uri()

    def get_async_connection_url(self) -> str:
        return self._mongo_uri()

    def _mongo_uri(self) -> str:
        info = self.info
        opts = info.options or {}
        if opts.get("uri"):
            return str(opts["uri"])
        from urllib.parse import quote_plus

        user = quote_plus(info.username or "")
        pw = quote_plus(opts.get("password", "") or "")
        host = info.host or "localhost"
        port = info.port or 27017
        auth = f"{user}:{pw}@" if user else ""
        return f"mongodb://{auth}{host}:{port}/{info.database or ''}"

    def _ensure_client(self) -> Any:
        if self._client is None:
            try:
                from pymongo import MongoClient  # type: ignore
            except ImportError as exc:
                raise RuntimeError(
                    "MongoDB support requires pymongo. Install with: pip install pymongo"
                ) from exc
            self._client = MongoClient(self._mongo_uri(), serverSelectionTimeoutMS=5000)
        return self._client

    def _db(self) -> Any:
        client = self._ensure_client()
        name = self.info.database or "test"
        return client[name]

    async def test_connection(self) -> tuple[bool, str]:
        try:
            client = self._ensure_client()
            client.admin.command("ping")
            return True, f"OK — connected to {self.info.database or '(no db selected)'}"
        except Exception as e:
            return False, f"Connection failed: {e}"

    async def get_schemas(self) -> list[str]:
        try:
            return self._ensure_client().list_database_names()
        except Exception:
            return []

    async def get_tables(self, schema: str | None = None) -> list[TableInfo]:
        try:
            client = self._ensure_client()
            name = schema or self.info.database or "test"
            return [
                TableInfo(name=c, schema=name, table_type="table")
                for c in client[name].list_collection_names()
            ]
        except Exception:
            return []

    async def get_columns(self, table: str, schema: str | None = None) -> list[ColumnInfo]:
        # Sample one document to infer field names. Mongo is schemaless,
        # so this is necessarily approximate.
        try:
            client = self._ensure_client()
            name = schema or self.info.database or "test"
            doc = client[name][table].find_one()
            if not doc:
                return []
            return [
                ColumnInfo(name=str(k), data_type=type(v).__name__, nullable=True)
                for k, v in doc.items()
            ]
        except Exception:
            return []

    async def execute_query(
        self,
        sql: str,
        parameters: dict | None = None,
        limit: int | None = 10000,
    ) -> QueryResult:
        started = time.time()
        try:
            spec = self._parse_query(sql)
        except ValueError as e:
            return QueryResult(
                columns=[], rows=[], row_count=0,
                execution_time_ms=(time.time() - started) * 1000, error=str(e),
            )
        coll_name = spec.get("collection")
        if not coll_name:
            return QueryResult(
                columns=[], rows=[], row_count=0,
                execution_time_ms=(time.time() - started) * 1000,
                error="MongoDB query must include a 'collection' field",
            )
        try:
            coll = self._db()[coll_name]
            if "pipeline" in spec:
                pipeline = spec["pipeline"]
                if limit and not any("$limit" in stage for stage in pipeline if isinstance(stage, dict)):
                    pipeline = list(pipeline) + [{"$limit": limit}]
                cursor = coll.aggregate(pipeline)
                docs = list(cursor)
            else:
                find_filter = spec.get("find", {})
                projection = spec.get("projection")
                sort = spec.get("sort")
                eff_limit = spec.get("limit") or limit
                cursor = coll.find(find_filter, projection)
                if sort:
                    # Mongo expects [(field, dir), ...]; accept {field: dir} too.
                    if isinstance(sort, dict):
                        sort = list(sort.items())
                    cursor = cursor.sort(sort)
                if eff_limit:
                    cursor = cursor.limit(int(eff_limit))
                docs = list(cursor)

            columns, rows = _docs_to_table(docs)
            return QueryResult(
                columns=columns, rows=rows, row_count=len(rows),
                execution_time_ms=(time.time() - started) * 1000,
            )
        except Exception as e:
            return QueryResult(
                columns=[], rows=[], row_count=0,
                execution_time_ms=(time.time() - started) * 1000, error=str(e),
            )

    def _parse_query(self, body: str) -> dict:
        try:
            spec = json.loads(body)
        except json.JSONDecodeError as e:
            raise ValueError(f"MongoDB queries must be JSON: {e}") from e
        if not isinstance(spec, dict):
            raise ValueError("MongoDB query must be a JSON object")
        return spec

    async def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None


def _docs_to_table(docs: list[dict]) -> tuple[list[str], list[tuple]]:
    """Flatten a list of MongoDB documents into a columns/rows pair.

    Top-level keys become columns (union across all docs, in
    first-seen order). Nested ``dict``/``list`` values get JSON-encoded
    so they fit a scalar cell — the user can ``$project`` them apart
    in the pipeline if they want columns.
    """
    columns: list[str] = []
    seen: set[str] = set()
    for d in docs:
        for k in d.keys():
            key = str(k)
            if key not in seen:
                seen.add(key)
                columns.append(key)
    rows: list[tuple] = []
    for d in docs:
        row: list[Any] = []
        for col in columns:
            v = d.get(col)
            if isinstance(v, (dict, list)):
                try:
                    v = json.dumps(v, default=str)
                except Exception:
                    v = str(v)
            elif _is_objectid(v):
                v = str(v)
            row.append(v)
        rows.append(tuple(row))
    return columns, rows


def _is_objectid(v: Any) -> bool:
    return type(v).__name__ == "ObjectId"
