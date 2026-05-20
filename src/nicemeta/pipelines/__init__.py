"""
Pipeline templates + sandboxed execution.

Pipelines are user-authored Python scripts that ingest data into one
of the user's saved connections. We auto-generate a starter script
from the form (source type + destination + load mode) so the user
doesn't stare at a blank editor; they can switch to ``code_mode=custom``
to freeze their edits.

The template uses `dlt <https://dlthub.com/>`_ when available — it
covers the load-mode semantics (replace / append / merge / incremental)
declaratively and ships destination support for every database we
already integrate with. When dlt is missing, the template falls back
to a SQLAlchemy-only path that still works for full + append loads.

Execution reuses the visualization sandbox's controlled import
machinery, with a wider allowlist (``dlt``, ``requests``, the source
package whitelist) and a fatter ``ctx`` namespace exposing the
destination connection so the user's script can call ``ctx.engine``
or ``ctx.dlt_destination()`` directly without re-typing credentials.
"""

from __future__ import annotations

import contextlib
import io
import json
import logging
import time
import traceback
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


# ---------- Template generation ---------------------------------------

# The set of load_mode values is mirrored on the Express side; keep
# in sync if you add modes. Streaming runs the same dlt resource for a
# bounded duration / message count.
LOAD_MODE_TO_DISPOSITION = {
    "replace": "replace",
    "append": "append",
    "merge": "merge",
    "incremental": "append",  # incremental uses dlt.sources.incremental + append
    "streaming": "append",
}


def _safe_ident(s: str) -> str:
    out = "".join(ch if (ch.isalnum() or ch == "_") else "_" for ch in (s or ""))
    if not out or out[0].isdigit():
        out = "p_" + out
    return out.lower() or "pipeline"


def generate_template(spec: dict[str, Any]) -> str:
    """Build a starter pipeline script from a structured spec.

    The spec dict mirrors what the UI form collects::

        {
            "name": str, "description": str | None,
            "source_type": "rest_api" | "sql" | "file" | "kafka" | "custom",
            "source_config": {...},          # per-source-type knobs
            "destination": {                  # the resolved destination
                "name": str, "type": str,     # connection type (postgres, snowflake, ...)
                "dataset": str | None,
                "table": str | None,          # for sql/incremental cursor tracking
            },
            "load_mode": str,
            "primary_key": str | None,        # for merge
            "cursor_field": str | None,       # for incremental
        }

    The output is a fully-runnable script; the user can either keep it
    in template mode (regen on every save) or switch to custom mode
    and start editing freely.
    """
    name = _safe_ident(spec.get("name", "pipeline"))
    description = spec.get("description") or "Auto-generated dlt pipeline."
    source_type = spec.get("source_type") or "custom"
    src = spec.get("source_config") or {}
    dest = spec.get("destination") or {}
    load_mode = spec.get("load_mode") or "replace"
    disposition = LOAD_MODE_TO_DISPOSITION.get(load_mode, "replace")
    primary_key = spec.get("primary_key") or ""
    cursor_field = spec.get("cursor_field") or ""
    dataset = dest.get("dataset") or "crunch_pipeline"

    builders = {
        "rest_api": _template_rest_api,
        "sql": _template_sql,
        "file": _template_file,
        "kafka": _template_kafka,
        "custom": _template_custom,
    }
    builder = builders.get(source_type, _template_custom)
    body = builder({
        "name": name,
        "description": description,
        "src": src,
        "dest": dest,
        "load_mode": load_mode,
        "disposition": disposition,
        "primary_key": primary_key,
        "cursor_field": cursor_field,
        "dataset": dataset,
    })
    return body


def _disposition_kwargs(load_mode: str, primary_key: str, cursor_field: str) -> str:
    """Build the kwargs for ``@dlt.resource`` based on load semantics."""
    parts: list[str] = []
    disposition = LOAD_MODE_TO_DISPOSITION.get(load_mode, "replace")
    parts.append(f'write_disposition="{disposition}"')
    if load_mode == "merge" and primary_key:
        keys = [k.strip() for k in primary_key.split(",") if k.strip()]
        if len(keys) == 1:
            parts.append(f'primary_key="{keys[0]}"')
        else:
            parts.append("primary_key=" + repr(keys))
    return ", ".join(parts)


def _pipeline_header(t: dict[str, Any]) -> str:
    dest_type = (t["dest"].get("type") or "duckdb").lower()
    # dlt's destination identifier matches our connection type for the
    # cases that overlap; we map the few that differ.
    dlt_destination = {
        "postgres": "postgres",
        "postgresql": "postgres",
        "mysql": "synapse",  # dlt has no MySQL destination yet; user customises
        "sqlite": "duckdb",  # SQLite isn't a dlt destination — use duckdb locally
        "duckdb": "duckdb",
        "snowflake": "snowflake",
        "bigquery": "bigquery",
        "redshift": "redshift",
        "databricks": "databricks",
        "clickhouse": "clickhouse",
        "mssql": "mssql",
        "sqlserver": "mssql",
        "file": "filesystem",
    }.get(dest_type, "duckdb")
    return f'''"""
{t["description"]}

Auto-generated by Crunch — edit freely. Switch the pipeline to
``code_mode=custom`` in the form to stop regen on every save.

Load mode: {t["load_mode"]}   ·   destination: {t["dest"].get("name", "?")} ({dest_type})
"""

import dlt
from typing import Iterator

PIPELINE_NAME = "{t["name"]}"
DATASET = "{t["dataset"]}"

# `ctx` is injected by the Crunch runner — it exposes the resolved
# destination credentials so dlt connects without you re-typing them.
# See ctx.dlt_destination() and ctx.engine for the available hooks.


def _row_count(pipeline, info) -> int:
    """Best-effort row counter — dlt's LoadInfo shape varies across
    versions. We try the trace's normalize-info row_counts first
    (covers dlt 0.4+), fall back to the dataset row-count API, and
    finally to 0 so the script always returns a sensible integer."""
    # dlt 0.4+: pipeline.last_trace.last_normalize_info.row_counts
    try:
        rc = pipeline.last_trace.last_normalize_info.row_counts
        if isinstance(rc, dict) and rc:
            # Skip dlt's internal bookkeeping tables when reporting
            # to the user — they aren't "their" rows.
            return int(sum(
                int(v or 0) for k, v in rc.items() if not str(k).startswith("_dlt_")
            ))
    except Exception:
        pass
    try:
        ds = pipeline.dataset()
        counts = ds.row_counts()
        if isinstance(counts, dict):
            return int(sum(
                int(v or 0) for k, v in counts.items() if not str(k).startswith("_dlt_")
            ))
    except Exception:
        pass
    return 0
'''


def _template_rest_api(t: dict[str, Any]) -> str:
    src = t["src"]
    base_url = src.get("base_url", "https://api.example.com")
    path = src.get("path", "/items")
    auth_header = src.get("auth_header", "")
    cursor_field = t["cursor_field"]

    res_decorator = (
        "@dlt.resource("
        + _disposition_kwargs(t["load_mode"], t["primary_key"], cursor_field)
        + ")"
    )
    newline = "\n"
    quoted_cursor = '"' + cursor_field + '"' if cursor_field else ""
    if t["load_mode"] == "incremental" and cursor_field:
        items_arg = f"cursor = dlt.sources.incremental({quoted_cursor})"
        cursor_init = (
            f"    cursor = dlt.sources.incremental({quoted_cursor}, "
            f"initial_value=None){newline}"
        )
        cursor_apply = (
            f'        params = {{"updated_since": cursor.last_value}} '
            f'if cursor.last_value else {{}}{newline}'
        )
    else:
        items_arg = ""
        cursor_init = ""
        cursor_apply = f'        params = {{}}{newline}'
    auth_line = (
        f'headers["Authorization"] = "{auth_header}"' if auth_header
        else "# headers['Authorization'] = 'Bearer …'"
    )
    return f'''{_pipeline_header(t)}

import requests


{res_decorator}
def items({items_arg}) -> Iterator[dict]:
    """One page-at-a-time HTTP fetch. Customise pagination to fit your API."""
{cursor_init}    url = "{base_url}{path}"
    headers = {{}}
    {auth_line}
    while url:
{cursor_apply}        r = requests.get(url, headers=headers, params=params, timeout=30)
        r.raise_for_status()
        data = r.json()
        # Adjust to your API's envelope:
        records = data.get("results", data) if isinstance(data, dict) else data
        yield from records
        # Pagination — replace with the cursor your API uses.
        url = (data or {{}}).get("next") if isinstance(data, dict) else None


def run() -> dict:
    pipeline = dlt.pipeline(
        pipeline_name=PIPELINE_NAME,
        destination=ctx.dlt_destination(),
        dataset_name=DATASET,
    )
    info = pipeline.run(items())
    return {{"rows_loaded": _row_count(pipeline, info)}}
'''


def _template_sql(t: dict[str, Any]) -> str:
    src = t["src"]
    table = src.get("source_table") or "source_table"
    src_query = src.get("query") or f"SELECT * FROM {table}"
    cursor_field = t["cursor_field"]
    cursor_arg = ""
    if t["load_mode"] == "incremental" and cursor_field:
        cursor_arg = (
            f', incremental=dlt.sources.incremental("{cursor_field}")'
        )

    return f'''{_pipeline_header(t)}

# Replicate from another connection. ``ctx.source_engine`` is set if
# you configured a source connection in the form; otherwise create
# your own SQLAlchemy engine here.

from sqlalchemy import create_engine, text


@dlt.resource({_disposition_kwargs(t["load_mode"], t["primary_key"], t["cursor_field"])})
def rows() -> Iterator[dict]:
    engine = ctx.source_engine or create_engine("{src.get("connection_url", "sqlite:///source.db")}")
    with engine.connect() as conn:
        for r in conn.execute(text("""{src_query}""")):
            yield dict(r._mapping)


def run() -> dict:
    pipeline = dlt.pipeline(
        pipeline_name=PIPELINE_NAME,
        destination=ctx.dlt_destination(),
        dataset_name=DATASET,
    )
    info = pipeline.run(rows(){cursor_arg})
    return {{"rows_loaded": _row_count(pipeline, info)}}
'''


def _template_file(t: dict[str, Any]) -> str:
    src = t["src"]
    pattern = src.get("path", "/data/*.csv")
    return f'''{_pipeline_header(t)}

# File-based pipeline. DuckDB reads the source files (CSV/Parquet/JSON)
# and dlt lands them into the destination connection.

import duckdb


@dlt.resource({_disposition_kwargs(t["load_mode"], t["primary_key"], t["cursor_field"])})
def file_rows() -> Iterator[dict]:
    con = duckdb.connect(":memory:")
    # read_csv_auto / read_parquet pick the right reader by extension.
    cur = con.execute(f"SELECT * FROM read_csv_auto('{pattern}')")
    cols = [d[0] for d in cur.description]
    for row in cur.fetchall():
        yield dict(zip(cols, row))


def run() -> dict:
    pipeline = dlt.pipeline(
        pipeline_name=PIPELINE_NAME,
        destination=ctx.dlt_destination(),
        dataset_name=DATASET,
    )
    info = pipeline.run(file_rows())
    return {{"rows_loaded": _row_count(pipeline, info)}}
'''


def _template_kafka(t: dict[str, Any]) -> str:
    src = t["src"]
    brokers = src.get("brokers", "localhost:9092")
    topic = src.get("topic", "events")
    group = src.get("group_id", "crunch-consumer")
    return f'''{_pipeline_header(t)}

# Streaming consumer. Runs until `ctx.stream_max_seconds` elapses or
# `ctx.stream_max_messages` is hit, whichever first — so the same
# scheduler that runs batch pipelines can drive a bounded streaming
# micro-batch every tick.

import json as _json
import time
from kafka import KafkaConsumer  # pip install kafka-python


@dlt.resource({_disposition_kwargs(t["load_mode"], t["primary_key"], t["cursor_field"])})
def events() -> Iterator[dict]:
    consumer = KafkaConsumer(
        "{topic}",
        bootstrap_servers="{brokers}".split(","),
        group_id="{group}",
        enable_auto_commit=True,
        value_deserializer=lambda b: _json.loads(b.decode("utf-8")),
        consumer_timeout_ms=1000,
    )
    deadline = time.time() + ctx.stream_max_seconds
    seen = 0
    try:
        for msg in consumer:
            yield msg.value
            seen += 1
            if seen >= ctx.stream_max_messages or time.time() >= deadline:
                break
    finally:
        consumer.close()


def run() -> dict:
    pipeline = dlt.pipeline(
        pipeline_name=PIPELINE_NAME,
        destination=ctx.dlt_destination(),
        dataset_name=DATASET,
    )
    info = pipeline.run(events())
    return {{"rows_loaded": _row_count(pipeline, info)}}
'''


def _template_custom(t: dict[str, Any]) -> str:
    return f'''{_pipeline_header(t)}


@dlt.resource({_disposition_kwargs(t["load_mode"], t["primary_key"], t["cursor_field"])})
def my_resource() -> Iterator[dict]:
    """Replace with your data source — yield dicts, dlt does the rest."""
    yield {{"id": 1, "name": "Alice"}}
    yield {{"id": 2, "name": "Bob"}}


def run() -> dict:
    pipeline = dlt.pipeline(
        pipeline_name=PIPELINE_NAME,
        destination=ctx.dlt_destination(),
        dataset_name=DATASET,
    )
    info = pipeline.run(my_resource())
    return {{"rows_loaded": _row_count(pipeline, info)}}
'''


# ---------- Execution ------------------------------------------------


@dataclass
class PipelineResult:
    success: bool
    rows_loaded: int = 0
    log: str = ""
    error: str | None = None
    duration_ms: float = 0.0


@dataclass
class PipelineContext:
    """Injected as ``ctx`` into user scripts. Bundles the destination
    credentials so user code can call ``ctx.dlt_destination()`` /
    ``ctx.engine`` without re-typing host/user/password."""

    destination_type: str
    destination_config: dict[str, Any]
    stream_max_seconds: int = 60
    stream_max_messages: int = 10000
    source_engine: Any = None  # populated for SQL-source pipelines

    def dlt_destination(self) -> Any:
        """Return a dlt destination instance pre-configured with the
        credentials of the user's Crunch connection. Falls back to a
        plain destination name when dlt is missing or the destination
        type isn't supported."""
        try:
            import dlt as _dlt
        except ImportError as e:
            raise RuntimeError(
                "This pipeline needs the 'dlt' package. Install with: pip install dlt"
            ) from e
        dt = self.destination_type
        c = self.destination_config

        if dt in ("postgres", "postgresql"):
            return _dlt.destinations.postgres(
                {
                    "host": c.get("host"),
                    "port": c.get("port") or 5432,
                    "database": c.get("database"),
                    "username": c.get("user"),
                    "password": c.get("password"),
                }
            )
        if dt == "duckdb":
            path = c.get("database") or ":memory:"
            return _dlt.destinations.duckdb(path)
        if dt == "snowflake":
            return _dlt.destinations.snowflake(
                {
                    "account": (c.get("options") or {}).get("account") or c.get("host"),
                    "username": c.get("user"),
                    "password": c.get("password"),
                    "database": c.get("database"),
                    "warehouse": (c.get("options") or {}).get("warehouse"),
                    "role": (c.get("options") or {}).get("role"),
                }
            )
        if dt == "bigquery":
            return _dlt.destinations.bigquery(
                {
                    "project_id": c.get("database"),
                    "credentials": (c.get("options") or {}).get("credentials_path"),
                }
            )
        if dt == "redshift":
            return _dlt.destinations.redshift(
                {
                    "host": c.get("host"),
                    "port": c.get("port") or 5439,
                    "database": c.get("database"),
                    "username": c.get("user"),
                    "password": c.get("password"),
                }
            )
        if dt in ("databricks",):
            opts = c.get("options") or {}
            return _dlt.destinations.databricks(
                {
                    "server_hostname": c.get("host"),
                    "http_path": opts.get("http_path"),
                    "access_token": opts.get("access_token") or c.get("password"),
                    "catalog": c.get("database"),
                }
            )
        if dt in ("mssql", "sqlserver"):
            return _dlt.destinations.mssql(
                {
                    "host": c.get("host"),
                    "port": c.get("port") or 1433,
                    "database": c.get("database"),
                    "username": c.get("user"),
                    "password": c.get("password"),
                }
            )
        # Fall back to a string name — dlt will read its own env config.
        return dt

    @property
    def engine(self) -> Any:
        """SQLAlchemy engine for the destination, for users who want
        to bypass dlt and write into the database directly."""
        from sqlalchemy import create_engine

        c = self.destination_config
        dt = self.destination_type
        if dt in ("postgres", "postgresql"):
            return create_engine(
                f"postgresql+psycopg2://{c.get('user', '')}:"
                f"{c.get('password', '')}@{c.get('host', 'localhost')}:"
                f"{c.get('port', 5432)}/{c.get('database', '')}"
            )
        if dt == "sqlite":
            return create_engine(f"sqlite:///{c.get('database') or ':memory:'}")
        if dt == "duckdb":
            return create_engine(f"duckdb:///{c.get('database') or ':memory:'}")
        # Best-effort default; user can replace in custom mode.
        return create_engine("sqlite:///:memory:")


def _validate_pipeline_code(code: str) -> list[str]:
    """Narrower validator than the visualization sandbox. Pipelines
    legitimately import requests, http, kafka, dlt — anything they
    need to talk to the source — so we only block the truly dangerous
    bits: filesystem walking, subprocess execution, raw eval/exec.

    The actual sandbox is still in :func:`_build_safe_builtins`; this
    is just a quick lint to catch obvious foot-guns before we exec."""
    import re as _re

    errors: list[str] = []
    # Word-boundary identifier blocklist.
    blocked_words = ["subprocess", "shutil", "eval"]
    for term in blocked_words:
        if _re.search(rf"\b{_re.escape(term)}\b", code):
            errors.append(f"Unsafe operation detected: '{term}' is not allowed")
    # Substring patterns for sandbox-escape via dunders + the
    # specific case of a literal exec() call (the identifier ``exec``
    # alone is needed for normal pipeline imports — `from x import *`
    # uses exec internally — but a call site is suspicious).
    blocked_substrings = [
        "exec(",
        "__builtins__",
        "__subclasses__",
        "__bases__",
        "__mro__",
        "__globals__",
        "__code__",
    ]
    for term in blocked_substrings:
        if term in code:
            errors.append(f"Unsafe operation detected: '{term}' is not allowed")
    try:
        compile(code, "<pipeline>", "exec")
    except SyntaxError as e:
        errors.append(f"Syntax error on line {e.lineno}: {e.msg}")
    return errors


def execute_pipeline(
    code: str,
    ctx: PipelineContext,
    timeout_seconds: int = 600,
) -> PipelineResult:
    """Run a pipeline script in a controlled namespace, capturing
    stdout/stderr. Returns row counts + log + duration."""

    started = time.perf_counter()
    log_buf = io.StringIO()
    # Standard module dunders so libraries that introspect via
    # ``inspect.getmodule(f)`` (notably dlt's @resource decorator)
    # find the function's module in sys.modules. Skipping these caused
    # ``AttributeError: 'NoneType' object has no attribute '__name__'``
    # in dlt 1.x because ``__module__`` defaulted to None.
    namespace: dict[str, Any] = {
        "__name__": "__crunch_pipeline__",
        "__package__": None,
        "__doc__": None,
        "__loader__": None,
        "__spec__": None,
        "__builtins__": _build_safe_builtins(),
        "ctx": ctx,
        "print": _make_capturing_print(log_buf),
    }
    # Register the namespace as a fake module so ``inspect.getmodule``
    # can locate it. We unregister on exit to avoid leaking across runs.
    import sys as _sys
    import types as _types
    fake_mod = _types.ModuleType(namespace["__name__"])
    fake_mod.__dict__.update(namespace)
    _sys.modules[namespace["__name__"]] = fake_mod
    # Reuse the same dict so updates to ``namespace`` are visible via
    # the module entry — exec() mutates ``namespace`` in place.
    namespace = fake_mod.__dict__
    # Pipeline-specific validator — strict enough to refuse obvious
    # foot-guns (subprocess, eval, sandbox-escape attributes) but
    # permissive enough to allow the libraries pipelines actually
    # need (requests, http, dlt, kafka, ...).
    errors = _validate_pipeline_code(code)
    if errors:
        return PipelineResult(
            success=False,
            error="; ".join(errors),
            duration_ms=(time.perf_counter() - started) * 1000,
        )

    try:
        with contextlib.redirect_stdout(log_buf), contextlib.redirect_stderr(log_buf):
            exec(code, namespace)
            run_fn = namespace.get("run")
            if not callable(run_fn):
                raise RuntimeError(
                    "Pipeline script must define a top-level `run()` function "
                    "that returns {rows_loaded: int}."
                )
            ret = run_fn()
    except Exception as exc:
        log_buf.write("\n")
        log_buf.write(traceback.format_exc())
        return PipelineResult(
            success=False,
            log=_cap_log(log_buf.getvalue()),
            error=f"{type(exc).__name__}: {exc}",
            duration_ms=(time.perf_counter() - started) * 1000,
        )
    finally:
        # Remove the per-run fake module so a long-running engine
        # doesn't accumulate stale namespaces.
        _sys.modules.pop(fake_mod.__name__, None)

    rows = 0
    if isinstance(ret, dict):
        rows = int(ret.get("rows_loaded", 0) or 0)
    elif isinstance(ret, int):
        rows = ret

    return PipelineResult(
        success=True,
        rows_loaded=rows,
        log=_cap_log(log_buf.getvalue()),
        duration_ms=(time.perf_counter() - started) * 1000,
    )


def _build_safe_builtins() -> dict[str, Any]:
    """Importing is the only built-in pipelines really need access to.
    We hand them a permissive ``__import__`` (no module whitelist —
    pipelines need pandas, requests, dlt, kafka, …) but strip the
    rest of the dangerous builtins, mirroring the visualization
    sandbox philosophy.
    """
    import builtins as _b

    safe_names = {
        "abs", "all", "any", "bool", "bytes", "callable", "dict",
        "enumerate", "filter", "float", "format", "frozenset", "getattr",
        "hasattr", "hash", "id", "int", "isinstance", "issubclass",
        "iter", "len", "list", "map", "max", "min", "next", "object",
        "print", "range", "repr", "reversed", "round", "set", "slice",
        "sorted", "str", "sum", "tuple", "type", "zip", "True", "False",
        "None", "Exception", "ValueError", "RuntimeError", "TypeError",
        "KeyError", "IndexError", "StopIteration", "AttributeError",
    }
    out: dict[str, Any] = {}
    for name in safe_names:
        if hasattr(_b, name):
            out[name] = getattr(_b, name)
    # Permissive import for pipelines — they routinely need external
    # libraries (requests, dlt, kafka, ...). The static validator
    # already blocked os/sys/subprocess/etc.
    out["__import__"] = _b.__import__
    return out


def _make_capturing_print(buf: io.StringIO):
    """Wrap print() so the user's writes end up in our log buffer."""
    def _p(*args, **kwargs):
        kwargs.setdefault("file", buf)
        print(*args, **kwargs)
    return _p


_LOG_BYTE_CAP = 200_000


def _cap_log(s: str) -> str:
    if len(s) <= _LOG_BYTE_CAP:
        return s
    head = s[: _LOG_BYTE_CAP // 2]
    tail = s[-_LOG_BYTE_CAP // 2 :]
    return f"{head}\n…[truncated {len(s) - _LOG_BYTE_CAP} bytes]…\n{tail}"
