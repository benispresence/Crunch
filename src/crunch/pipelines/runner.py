"""
Killable pipeline worker.

Invoked as ``python -m crunch.pipelines.runner JOB.json``. Reads the
job payload (code + resolved destination secrets), runs
:func:`execute_pipeline`, writes ``JOB.json.result.json``, and exits.
The parent (Express) owns the process group and can SIGTERM/SIGKILL it.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    if not args:
        sys.stderr.write("usage: python -m crunch.pipelines.runner JOB.json\n")
        return 2
    job_path = Path(args[0])
    job = json.loads(job_path.read_text())
    from crunch.pipelines.context import PipelineContext
    from crunch.pipelines.executor import execute_pipeline

    dest = job.get("destination") or {}
    source_config = dict(job.get("source_config") or {})
    source_conn = job.get("source_connection") or None
    source_engine = None
    if source_conn and isinstance(source_conn, dict):
        from crunch.pipelines.context import sqlalchemy_url
        from sqlalchemy import create_engine

        if not source_config.get("connection_url"):
            source_config["connection_url"] = sqlalchemy_url(
                str(source_conn.get("type") or ""), source_conn,
            )
        for key in ("password", "user", "host", "port", "database", "auth_header"):
            if source_config.get(key) is None and source_conn.get(key) is not None:
                source_config[key] = source_conn[key]
        source_config["_source_type"] = source_conn.get("type")
        try:
            source_engine = create_engine(
                source_config["connection_url"]
                or sqlalchemy_url(str(source_conn.get("type") or ""), source_conn),
            )
        except Exception:
            source_engine = None
    elif source_config.get("connection_url"):
        try:
            from sqlalchemy import create_engine

            source_engine = create_engine(str(source_config["connection_url"]))
        except Exception:
            source_engine = None
    ctx = PipelineContext(
        destination_type=str(dest.get("type") or "").lower(),
        destination_config=dest,
        stream_max_seconds=int(job.get("stream_max_seconds") or 60),
        stream_max_messages=int(job.get("stream_max_messages") or 10_000),
        source_config=source_config,
        runtime_config=job.get("runtime_config") or {},
        source_engine=source_engine,
    )
    timeout = int(job.get("timeout_seconds") or 1800)
    result = execute_pipeline(job.get("code") or "", ctx, timeout_seconds=timeout)
    output_tables = list(getattr(result, "output_tables", None) or [])
    captured_rows: list = []
    for table in output_tables:
        if isinstance(table, dict) and isinstance(table.get("rows"), list):
            captured_rows.extend(
                r for r in table["rows"] if isinstance(r, dict)
            )
    payload = {
        "success": bool(result.success),
        "rows_loaded": int(result.rows_loaded or 0),
        "log": result.log or "",
        "error": result.error,
        "duration_ms": float(result.duration_ms or 0),
        "steps": list(getattr(result, "steps", None) or []),
        "output_tables": output_tables,
        "checkpoints": list(getattr(result, "checkpoints", None) or []),
        "rows": captured_rows,
    }
    result_path = Path(str(job_path) + ".result.json")
    temporary = Path(str(result_path) + ".tmp")
    temporary.write_text(json.dumps(payload, default=str))
    temporary.replace(result_path)
    return 0 if result.success else 1


if __name__ == "__main__":
    raise SystemExit(main())
