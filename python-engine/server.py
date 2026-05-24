"""
Crunch Python Engine - thin FastAPI service that exposes the existing
SQL execution, visualization rendering, and sandboxed Python code
execution to the Express/TypeScript backend.

This service deliberately has no UI and no business logic. It is the
"Python engine" the user asked us to keep, sitting behind Express.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from crunch.connections.adapters import (  # noqa: E402
    BigQueryAdapter,
    ClickHouseAdapter,
    DatabricksAdapter,
    DuckDBAdapter,
    FileAdapter,
    MariaDBAdapter,
    MongoDBAdapter,
    MySQLAdapter,
    PostgreSQLAdapter,
    RedshiftAdapter,
    SnowflakeAdapter,
    SQLiteAdapter,
    SQLServerAdapter,
    TrinoAdapter,
)
from crunch.connections.base import ConnectionAdapter, ConnectionInfo  # noqa: E402
from crunch.connections.file_scanner import scan_folder  # noqa: E402
from crunch.pipelines import (  # noqa: E402
    PipelineContext,
    execute_pipeline,
    generate_template,
)
from crunch.query.template import (  # noqa: E402
    ParameterSpec,
    TemplateError,
    coerce_values,
    parse_variable_names,
    render as render_template,
)
from crunch.query.validator import QueryValidator  # noqa: E402
from crunch.visualization.code_executor import CodeExecutor  # noqa: E402
from crunch.visualization.factory import ChartFactory  # noqa: E402

_DEV_ENGINE_TOKEN = "dev-engine-token"
ENGINE_TOKEN = os.environ.get("PYTHON_ENGINE_TOKEN", _DEV_ENGINE_TOKEN)
_ENGINE_ENV = os.environ.get("ENGINE_ENV", "development")
if _ENGINE_ENV == "production" and (
    not os.environ.get("PYTHON_ENGINE_TOKEN") or ENGINE_TOKEN == _DEV_ENGINE_TOKEN
):
    sys.stderr.write(
        "\nRefusing to start: PYTHON_ENGINE_TOKEN is unset or the dev default. "
        "Set ENGINE_ENV=development for local dev, or provide a strong token in production.\n\n"
    )
    sys.exit(1)

# Map both the user-facing alias ("postgres") and the canonical
# Python-side name ("postgresql") to the same adapter class so the
# Express backend's enum and the existing Python registry agree.
ADAPTER_REGISTRY: dict[str, type[ConnectionAdapter]] = {
    "postgres": PostgreSQLAdapter,
    "postgresql": PostgreSQLAdapter,
    "mysql": MySQLAdapter,
    "mariadb": MariaDBAdapter,
    "sqlite": SQLiteAdapter,
    "sqlserver": SQLServerAdapter,
    "file": FileAdapter,
    "duckdb": DuckDBAdapter,
    "snowflake": SnowflakeAdapter,
    "bigquery": BigQueryAdapter,
    "redshift": RedshiftAdapter,
    "databricks": DatabricksAdapter,
    "clickhouse": ClickHouseAdapter,
    "trino": TrinoAdapter,
    "presto": TrinoAdapter,  # PrestoDB is wire-compatible enough for our use.
    "mongodb": MongoDBAdapter,
    "mongo": MongoDBAdapter,
}

# Connection types that bypass the SQL validator + Metabase-style
# templating because their query language isn't SQL. The engine runs
# the body straight through to the adapter.
NON_SQL_TYPES = {"mongodb", "mongo"}

# Cached adapters keyed by a stable signature of the connection config so
# repeated queries reuse the same DuckDB / DB-API connection.
_adapter_cache: dict[str, ConnectionAdapter] = {}


def _adapter_for(connection: dict[str, Any]) -> ConnectionAdapter:
    db_type = (connection.get("type") or "").lower()
    cls = ADAPTER_REGISTRY.get(db_type)
    if cls is None:
        raise ValueError(
            f"Unsupported connection type: {connection.get('type')}. "
            f"Supported: {sorted(set(ADAPTER_REGISTRY))}"
        )
    cache_key = "|".join(
        str(connection.get(k, "")) for k in ("type", "host", "port", "database", "user")
    )
    cached = _adapter_cache.get(cache_key)
    if cached is not None:
        return cached
    # Canonicalise aliases so the rest of the engine sees one name.
    canonical = {
        "postgres": "postgresql",
        "presto": "trino",
        "mongo": "mongodb",
    }.get(db_type, db_type)
    info = ConnectionInfo(
        name=connection.get("name") or f"{canonical}_conn",
        db_type=canonical,
        host=connection.get("host") or "localhost",
        port=connection.get("port") or 0,
        database=connection.get("database") or "",
        username=connection.get("user"),
        options={
            "password": connection.get("password"),
            **(connection.get("options") or {}),
        },
    )
    adapter = cls(info)
    _adapter_cache[cache_key] = adapter
    return adapter

app = FastAPI(title="Crunch Python Engine", version="1.0.0")
# The engine is server-to-server only — the Express backend is the sole
# caller. Locking the allowed origins to that backend prevents any browser
# script from talking to the engine even if the listen address gets
# widened later. ENGINE_ALLOWED_ORIGIN can override for non-default
# deployments.
_ALLOWED_ORIGIN = os.environ.get("ENGINE_ALLOWED_ORIGIN", "http://127.0.0.1:3691")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[_ALLOWED_ORIGIN] if _ALLOWED_ORIGIN != "*" else ["*"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

query_validator = QueryValidator()
chart_factory = ChartFactory()


def _check_token(token: str | None) -> None:
    if token != ENGINE_TOKEN:
        raise HTTPException(status_code=401, detail="invalid engine token")


class ConnectionConfig(BaseModel):
    type: str
    host: str | None = None
    port: int | None = None
    database: str | None = None
    user: str | None = None
    password: str | None = None
    options: dict[str, Any] = Field(default_factory=dict)


class ParameterSpecModel(BaseModel):
    name: str
    type: str = "text"
    default: Any = None
    required: bool = False


class ExecuteSqlRequest(BaseModel):
    token: str
    connection: ConnectionConfig
    sql: str
    limit: int | None = 5000
    # Defence in depth: the engine refuses writes unless the backend
    # explicitly opts in. The backend currently never sets this true.
    allow_writes: bool = False
    # Metabase-style template parameters. ``parameters`` declares
    # types + defaults; ``parameter_values`` provides the per-run
    # values. The engine substitutes {{name}} via SQL bind params.
    parameters: list[ParameterSpecModel] = Field(default_factory=list)
    parameter_values: dict[str, Any] = Field(default_factory=dict)


class ScanFolderRequest(BaseModel):
    token: str
    path: str
    recursive: bool = True
    max_files: int = 5000


class ScannedFileModel(BaseModel):
    uri: str
    name: str
    format: str
    size_bytes: int
    relative_path: str
    sheet: str | None = None


class ScanFolderResponse(BaseModel):
    root: str
    files: list[ScannedFileModel] = Field(default_factory=list)
    skipped: int = 0
    error: str | None = None


class ExecuteSqlResponse(BaseModel):
    success: bool
    columns: list[str] = []
    rows: list[list[Any]] = []
    row_count: int = 0
    execution_time_ms: float = 0
    error: str | None = None


class PipelineTemplateRequest(BaseModel):
    token: str
    spec: dict[str, Any]


class PipelineExecuteRequest(BaseModel):
    token: str
    code: str
    destination: ConnectionConfig
    stream_max_seconds: int = 60
    stream_max_messages: int = 10000
    timeout_seconds: int = 1800


class PipelineExecuteResponse(BaseModel):
    success: bool
    rows_loaded: int = 0
    log: str = ""
    error: str | None = None
    duration_ms: float = 0.0


class ValidateSqlRequest(BaseModel):
    token: str
    sql: str


class RenderChartRequest(BaseModel):
    token: str
    chart_type: str
    renderer: str = "plotly"
    data: dict[str, list[Any]]
    config: dict[str, Any] = Field(default_factory=dict)


class RenderChartResponse(BaseModel):
    success: bool
    spec: dict[str, Any] | None = None
    html: str | None = None
    error: str | None = None


class ExecutePythonRequest(BaseModel):
    token: str
    code: str
    data: dict[str, list[Any]] = Field(default_factory=dict)
    allowed_packages: list[str] = Field(default_factory=list)
    timeout_seconds: int = 30
    # Same parameter machinery as SQL. Validated values are exposed to
    # user code as ``params`` so chart scripts can react to filters.
    parameters: list[ParameterSpecModel] = Field(default_factory=list)
    parameter_values: dict[str, Any] = Field(default_factory=dict)


class ExecutePythonResponse(BaseModel):
    success: bool
    spec: dict[str, Any] | None = None
    stdout: str = ""
    error: str | None = None


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "crunch-python-engine"}


@app.get("/viz/chart-types")
async def list_chart_types() -> dict[str, Any]:
    """Return the catalog of supported chart types for the picker."""
    from crunch.visualization.chart_types import CHART_TYPES

    out = []
    for ct in CHART_TYPES.values():
        out.append({
            "id": ct.id,
            "name": ct.name,
            "description": ct.description,
            "category": ct.category.value,
            "supported_renderers": list(ct.supported_renderers),
            "required_fields": list(ct.required_fields),
            "optional_fields": list(ct.optional_fields),
            "default_renderer": ct.default_renderer,
            "icon": ct.icon,
        })
    out.sort(key=lambda c: (c["category"], c["name"]))
    return {"chart_types": out}


@app.post("/sql/validate")
async def validate_sql(req: ValidateSqlRequest) -> dict[str, Any]:
    _check_token(req.token)
    result = query_validator.validate(req.sql)
    return {
        "valid": result.is_valid,
        "error": "; ".join(result.errors) if result.errors else None,
    }


@app.post("/files/scan", response_model=ScanFolderResponse)
async def scan(req: ScanFolderRequest) -> ScanFolderResponse:
    """Walk a folder and return every supported data file underneath,
    one entry per file (and one per sheet for Excel workbooks). The UI
    uses this to populate a multi-select dialog so the user can pick
    which files become tables on a File connection."""
    _check_token(req.token)
    result = scan_folder(
        req.path,
        recursive=req.recursive,
        max_files=req.max_files,
    )
    return ScanFolderResponse(
        root=result.root,
        files=[
            ScannedFileModel(
                uri=f.uri, name=f.name, format=f.format,
                size_bytes=f.size_bytes, relative_path=f.relative_path,
                sheet=f.sheet,
            )
            for f in result.files
        ],
        skipped=result.skipped,
        error=result.error,
    )


@app.post("/sql/execute", response_model=ExecuteSqlResponse)
async def execute_sql(req: ExecuteSqlRequest) -> ExecuteSqlResponse:
    _check_token(req.token)
    conn_type = (req.connection.type or "").lower()
    is_non_sql = conn_type in NON_SQL_TYPES

    # Render the template first — drop optional clauses with unset
    # variables and replace {{var}} with :var bind placeholders. The
    # validator then sees the same shape the driver will, including
    # the rewritten clauses, so e.g. "[[ AND x = {{x}} ]]"
    # turns into a clean SELECT before classification. Non-SQL
    # connections (MongoDB) carry JSON in req.sql, so we skip both
    # templating and the SQL validator for them.
    if is_non_sql:
        rendered_sql = req.sql
        binds: dict[str, Any] = {}
    else:
        try:
            specs = [
                ParameterSpec(
                    name=p.name,
                    type=p.type,
                    default=p.default,
                    required=p.required,
                )
                for p in req.parameters
            ]
            rendered_sql, binds = render_template(req.sql, specs, req.parameter_values)
        except TemplateError as exc:
            return ExecuteSqlResponse(success=False, error=str(exc))

        validation = query_validator.validate(rendered_sql)
        if not validation.is_valid:
            return ExecuteSqlResponse(
                success=False,
                error="; ".join(validation.errors) or "invalid sql",
            )
        # Reject anything that isn't a read by default. The validator already
        # classifies the statement; we just refuse the non-read kinds here so
        # a backend bug that forwards a DROP/UPDATE can't trash a user's DB.
        if not req.allow_writes and not validation.is_read_only:
            return ExecuteSqlResponse(
                success=False,
                error=(
                    f"engine refused {validation.query_type.value.upper()} statement: "
                    "only SELECT is allowed (set allow_writes to opt in)"
                ),
            )

    started = time.perf_counter()
    try:
        adapter = _adapter_for(req.connection.model_dump())
        result = await adapter.execute_query(
            rendered_sql, parameters=binds, limit=req.limit,
        )
    except Exception as exc:  # surface engine errors to backend
        return ExecuteSqlResponse(
            success=False,
            error=f"{type(exc).__name__}: {exc}",
            execution_time_ms=(time.perf_counter() - started) * 1000,
        )

    elapsed_ms = (time.perf_counter() - started) * 1000
    if result.error:
        return ExecuteSqlResponse(
            success=False,
            error=result.error,
            execution_time_ms=elapsed_ms,
        )
    rows = [list(row) for row in result.rows]
    return ExecuteSqlResponse(
        success=True,
        columns=list(result.columns),
        rows=rows,
        row_count=result.row_count,
        execution_time_ms=elapsed_ms,
    )


@app.post("/viz/render", response_model=RenderChartResponse)
async def render_chart(req: RenderChartRequest) -> RenderChartResponse:
    _check_token(req.token)
    try:
        import pandas as pd
        from crunch.visualization.base import ChartConfig

        df = pd.DataFrame(req.data)
        cfg_kwargs = {"chart_type": req.chart_type}
        # Map common fields from the picker config (x, y, color, size, etc.)
        for key in (
            "x", "y", "z", "color", "size", "labels", "values",
            "parents", "source", "target", "open", "high", "low", "close",
            "lat", "lon", "locations", "title", "x_label", "y_label",
        ):
            if req.config.get(key) not in (None, ""):
                cfg_kwargs[key] = req.config[key]
        config = ChartConfig(**cfg_kwargs)
        result = chart_factory.render(df, config, renderer=req.renderer)
        if not result.success:
            return RenderChartResponse(success=False, error=result.error)
        return RenderChartResponse(
            success=True,
            spec=result.json_data,
            html=result.html,
        )
    except Exception as exc:
        return RenderChartResponse(success=False, error=f"{type(exc).__name__}: {exc}")


class PackageRequest(BaseModel):
    token: str
    package_name: str
    version_spec: str | None = None


@app.post("/packages/install")
async def install_package(req: PackageRequest) -> dict[str, Any]:
    _check_token(req.token)
    spec = req.package_name + (req.version_spec or "")
    try:
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "pip", "install", "--quiet", spec,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=180)
        if proc.returncode != 0:
            return {"success": False, "error": stderr.decode()[:1000]}
    except asyncio.TimeoutError:
        return {"success": False, "error": "install timed out"}
    except Exception as exc:
        return {"success": False, "error": f"{type(exc).__name__}: {exc}"}

    version = await _resolve_installed_version(req.package_name)
    return {"success": True, "version": version}


@app.post("/packages/uninstall")
async def uninstall_package(req: PackageRequest) -> dict[str, Any]:
    _check_token(req.token)
    try:
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "pip", "uninstall", "-y", "--quiet", req.package_name,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
        if proc.returncode != 0:
            return {"success": False, "error": stderr.decode()[:1000]}
    except asyncio.TimeoutError:
        return {"success": False, "error": "uninstall timed out"}
    except Exception as exc:
        return {"success": False, "error": f"{type(exc).__name__}: {exc}"}
    return {"success": True}


async def _resolve_installed_version(package_name: str) -> str | None:
    try:
        from importlib.metadata import PackageNotFoundError, version

        return version(package_name)
    except PackageNotFoundError:
        return None
    except Exception:
        return None


@app.post("/python/execute", response_model=ExecutePythonResponse)
async def execute_python(req: ExecutePythonRequest) -> ExecutePythonResponse:
    _check_token(req.token)
    try:
        import pandas as pd

        df = pd.DataFrame(req.data) if req.data else pd.DataFrame()
        try:
            specs = [
                ParameterSpec(
                    name=p.name,
                    type=p.type,
                    default=p.default,
                    required=p.required,
                )
                for p in req.parameters
            ]
            params = coerce_values(specs, req.parameter_values)
        except TemplateError as exc:
            return ExecutePythonResponse(success=False, error=str(exc))
        # CodeExecutor.execute is sync; run in threadpool to keep the loop free.
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            lambda: CodeExecutor.execute(
                req.code, df, timeout=req.timeout_seconds, params=params,
            ),
        )
    except Exception as exc:
        return ExecutePythonResponse(success=False, error=f"{type(exc).__name__}: {exc}")

    if not result.success:
        return ExecutePythonResponse(success=False, error=result.error or "execution failed")

    spec: dict[str, Any] | None = None
    fig = result.figure
    if fig is not None:
        # Plotly figures: serialize via plotly.io.to_json so numpy arrays
        # become plain JSON-serializable lists. Matplotlib figures have no
        # spec — we fall back to the rendered HTML.
        try:
            import json as _json

            import plotly.io as pio

            spec = _json.loads(pio.to_json(fig))
        except Exception:
            spec = None
    return ExecutePythonResponse(
        success=True,
        spec=spec,
        stdout=result.html or "",
        error=None,
    )


@app.post("/pipelines/template")
async def pipeline_template(req: PipelineTemplateRequest) -> dict[str, str]:
    """Generate a starter Python script from a structured spec.

    The Express side calls this when the pipeline is in
    ``code_mode='template'`` and any of the inputs that feed the
    template change (source type, load mode, destination, ...).
    """
    _check_token(req.token)
    code = generate_template(req.spec)
    return {"code": code}


@app.post("/pipelines/execute", response_model=PipelineExecuteResponse)
async def pipeline_execute(req: PipelineExecuteRequest) -> PipelineExecuteResponse:
    """Run a user-authored pipeline script in the sandbox. Returns
    rows-loaded + captured stdout/stderr + duration."""
    _check_token(req.token)
    ctx = PipelineContext(
        destination_type=(req.destination.type or "").lower(),
        destination_config=req.destination.model_dump(),
        stream_max_seconds=req.stream_max_seconds,
        stream_max_messages=req.stream_max_messages,
    )
    # CPU-bound script; off-load to a thread so the asyncio loop stays
    # responsive and the FastAPI worker can serve health checks.
    # SIGALRM inside execute_pipeline only works from the main thread,
    # so we also bound the asyncio await — a runaway script can no
    # longer hold the engine's request indefinitely.  The orphaned
    # worker thread will finish eventually (Python can't kill threads
    # cooperatively), but the engine is freed to handle further calls.
    loop = asyncio.get_event_loop()
    try:
        result = await asyncio.wait_for(
            loop.run_in_executor(
                None,
                lambda: execute_pipeline(
                    req.code, ctx, timeout_seconds=req.timeout_seconds,
                ),
            ),
            # Add a small grace beyond the in-process SIGALRM so we
            # don't race with the script's own timeout report.
            timeout=req.timeout_seconds + 30,
        )
    except asyncio.TimeoutError:
        return PipelineExecuteResponse(
            success=False,
            rows_loaded=0,
            log="",
            error=(
                f"pipeline exceeded {req.timeout_seconds + 30}s wall-clock "
                "limit (engine-side abort)"
            ),
            duration_ms=(req.timeout_seconds + 30) * 1000,
        )
    return PipelineExecuteResponse(
        success=result.success,
        rows_loaded=result.rows_loaded,
        log=result.log,
        error=result.error,
        duration_ms=result.duration_ms,
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "server:app",
        host=os.environ.get("PYTHON_ENGINE_HOST", "127.0.0.1"),
        port=int(os.environ.get("PYTHON_ENGINE_PORT", "8765")),
        reload=False,
    )
