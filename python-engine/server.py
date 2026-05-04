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
from nicemeta.query.validator import QueryValidator  # noqa: E402
from nicemeta.visualization.code_executor import CodeExecutor  # noqa: E402
from nicemeta.visualization.factory import ChartFactory  # noqa: E402

ENGINE_TOKEN = os.environ.get("PYTHON_ENGINE_TOKEN", "dev-engine-token")

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

app = FastAPI(title="NiceMeta Python Engine", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
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


class ExecuteSqlRequest(BaseModel):
    token: str
    connection: ConnectionConfig
    sql: str
    limit: int | None = 5000


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


class ExecutePythonResponse(BaseModel):
    success: bool
    spec: dict[str, Any] | None = None
    stdout: str = ""
    error: str | None = None


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "nicemeta-python-engine"}


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
    validation = query_validator.validate(req.sql)
    if not validation.is_valid:
        return ExecuteSqlResponse(
            success=False,
            error="; ".join(validation.errors) or "invalid sql",
        )

    started = time.perf_counter()
    try:
        adapter = _adapter_for(req.connection.model_dump())
        result = await adapter.execute_query(req.sql, limit=req.limit)
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
        chart = chart_factory.create(
            chart_type=req.chart_type,
            renderer=req.renderer,
            data=req.data,
            config=req.config,
        )
        spec = chart.to_spec()
        html = chart.to_html() if hasattr(chart, "to_html") else None
        return RenderChartResponse(success=True, spec=spec, html=html)
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
    executor = CodeExecutor(allowed_packages=req.allowed_packages or None)
    try:
        result = await asyncio.wait_for(
            executor.run(req.code, data=req.data),
            timeout=req.timeout_seconds,
        )
    except asyncio.TimeoutError:
        return ExecutePythonResponse(success=False, error="execution timed out")
    except Exception as exc:
        return ExecutePythonResponse(success=False, error=f"{type(exc).__name__}: {exc}")

    return ExecutePythonResponse(
        success=result.success,
        spec=result.spec,
        stdout=result.stdout,
        error=result.error,
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "server:app",
        host=os.environ.get("PYTHON_ENGINE_HOST", "127.0.0.1"),
        port=int(os.environ.get("PYTHON_ENGINE_PORT", "8765")),
        reload=False,
    )
