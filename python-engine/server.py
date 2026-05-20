"""
NiceMeta Python Engine - thin FastAPI service that exposes the existing
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

from nicemeta.connections.adapters import (  # noqa: E402
    FileAdapter,
    MySQLAdapter,
    PostgreSQLAdapter,
    SQLiteAdapter,
    SQLServerAdapter,
)
from nicemeta.connections.base import ConnectionAdapter, ConnectionInfo  # noqa: E402
from nicemeta.query.template import (  # noqa: E402
    ParameterSpec,
    TemplateError,
    coerce_values,
    parse_variable_names,
    render as render_template,
)
from nicemeta.query.validator import QueryValidator  # noqa: E402
from nicemeta.visualization.code_executor import CodeExecutor  # noqa: E402
from nicemeta.visualization.factory import ChartFactory  # noqa: E402

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
    "sqlite": SQLiteAdapter,
    "sqlserver": SQLServerAdapter,
    "file": FileAdapter,
}

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
    info = ConnectionInfo(
        name=connection.get("name") or f"{db_type}_conn",
        db_type="postgresql" if db_type == "postgres" else db_type,
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


class ExecuteSqlResponse(BaseModel):
    success: bool
    columns: list[str] = []
    rows: list[list[Any]] = []
    row_count: int = 0
    execution_time_ms: float = 0
    error: str | None = None


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
    return {"status": "ok", "service": "nicemeta-python-engine"}


@app.get("/viz/chart-types")
async def list_chart_types() -> dict[str, Any]:
    """Return the catalog of supported chart types for the picker."""
    from nicemeta.visualization.chart_types import CHART_TYPES

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


@app.post("/sql/execute", response_model=ExecuteSqlResponse)
async def execute_sql(req: ExecuteSqlRequest) -> ExecuteSqlResponse:
    _check_token(req.token)
    # Render the template first — drop optional clauses with unset
    # variables and replace {{var}} with :var bind placeholders. The
    # validator then sees the same shape the driver will, including
    # the rewritten clauses, so e.g. "[[ AND x = {{x}} ]]"
    # turns into a clean SELECT before classification.
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
        from nicemeta.visualization.base import ChartConfig

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


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "server:app",
        host=os.environ.get("PYTHON_ENGINE_HOST", "127.0.0.1"),
        port=int(os.environ.get("PYTHON_ENGINE_PORT", "8765")),
        reload=False,
    )
