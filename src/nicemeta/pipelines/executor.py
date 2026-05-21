"""
Pipeline execution sandbox.

The trust model:

* Pipelines need outbound network and many third-party libraries
  (dlt, requests, kafka), which is fundamentally different from the
  visualisation sandbox where viz code shouldn't reach the network.
* So we apply an *allowlist* on imports — admin-curated via
  Admin → Allowed packages — plus a small default list of libraries
  pipelines reliably need.
* A SIGALRM-based wall-clock guard kills any script that runs past
  its ``timeout_seconds``. SIGALRM only fires from POSIX main
  threads; the FastAPI route adds an `asyncio.wait_for` belt to
  cover the thread-pool case where SIGALRM is a no-op.
* A simple static validator rejects obvious foot-guns
  (``subprocess``, ``shutil``, ``eval``, sandbox-escape dunders)
  *before* exec runs.

This is *not* a hard isolation boundary — it can't be, since pipelines
need pip-installed code. The honest hardening path is to subprocess
the run; see ``BRANCH_AUDIT.md`` rework #1.
"""

from __future__ import annotations

import contextlib
import io
import logging
import sys as _sys
import time
import traceback
import types as _types
from typing import Any

from .context import PipelineContext, PipelineResult

logger = logging.getLogger(__name__)


# Default modules pipelines can import even when the DB-backed
# allowlist isn't reachable (unit tests, freshly cloned repo). Admin
# Settings → Packages overrides this; nothing here should depend on
# subprocess / shutil / socket / os / sys.
_DEFAULT_PIPELINE_ALLOWLIST: dict[str, str] = {
    # data tools
    "dlt": "dlt", "pandas": "pandas", "numpy": "numpy", "pyarrow": "pyarrow",
    "duckdb": "duckdb",
    # HTTP / stream sources
    "requests": "requests", "httpx": "httpx", "http": "http",
    "json": "json", "csv": "csv", "io": "io",
    # SQL driver layer
    "sqlalchemy": "sqlalchemy", "psycopg2": "psycopg2", "psycopg": "psycopg",
    # broker subscribers
    "kafka": "kafka",
    # std-lib utilities that are read-only / pure
    "datetime": "datetime", "math": "math", "re": "re",
    "collections": "collections", "itertools": "itertools",
    "functools": "functools", "statistics": "statistics",
    "decimal": "decimal", "time": "time", "typing": "typing",
    "urllib": "urllib",  # parse / quote — no urllib.request RCE alone
}


_LOG_BYTE_CAP = 200_000


class _PipelineTimeout(Exception):
    """Raised when a pipeline runs longer than its ``timeout_seconds``."""


def _validate_pipeline_code(code: str) -> list[str]:
    """Quick static checks that catch obvious foot-guns before exec.

    Defence in depth — the real boundary is the import allowlist
    in :func:`_build_safe_builtins`. This just makes a few classes of
    abuse (subprocess, eval, sandbox-escape dunders) refuse at lint
    time so the error surfaces immediately rather than at runtime.
    """
    import re as _re

    errors: list[str] = []
    blocked_words = ["subprocess", "shutil", "eval"]
    for term in blocked_words:
        if _re.search(rf"\b{_re.escape(term)}\b", code):
            errors.append(f"Unsafe operation detected: '{term}' is not allowed")
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


def _make_controlled_import(allowed_modules: dict[str, str]):
    """Return a ``__import__`` replacement that only allows top-level
    modules from ``allowed_modules``. Matches the visualisation
    sandbox's controlled_import implementation so pipelines + viz
    scripts share one model."""
    import builtins as _b

    real_import = _b.__import__

    def _controlled_import(name, globals=None, locals=None, fromlist=(), level=0):
        top = name.split(".")[0]
        if top not in allowed_modules:
            raise ImportError(
                f"Module '{name}' is not in the allowed package list. "
                "Ask an admin to add it via Admin → Allowed packages."
            )
        return real_import(name, globals, locals, fromlist, level)

    return _controlled_import


def _build_safe_builtins(allowed_modules: dict[str, str] | None = None) -> dict[str, Any]:
    """Build the restricted ``__builtins__`` dict for pipeline scripts.

    We reuse the visualization sandbox's import-allowlist model so a
    pipeline can't ``import subprocess`` or any other module unless an
    admin has explicitly enabled it via the *Allowed packages* tab.
    This is the same trust boundary as visualisation Python — there is
    no second tier.
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
    out["__import__"] = _make_controlled_import(allowed_modules or _DEFAULT_PIPELINE_ALLOWLIST)
    return out


def _load_admin_allowlist() -> dict[str, str]:
    """Look up the DB-backed allowlist if available; otherwise fall
    back to the conservative default. The viz CodeExecutor already
    implements the caching + DB lookup, so we reuse it."""
    try:
        from nicemeta.visualization.code_executor import CodeExecutor

        modules = CodeExecutor._get_allowed_modules()  # type: ignore[attr-defined]
        if modules:
            # Merge in pipeline-only defaults so the admin doesn't have
            # to remember to add dlt/requests to the viz allowlist.
            merged = dict(_DEFAULT_PIPELINE_ALLOWLIST)
            merged.update(modules)
            return merged
    except Exception:
        pass
    return _DEFAULT_PIPELINE_ALLOWLIST


def _make_capturing_print(buf: io.StringIO):
    """Wrap print() so the user's writes end up in our log buffer."""
    def _p(*args, **kwargs):
        kwargs.setdefault("file", buf)
        print(*args, **kwargs)
    return _p


def _cap_log(s: str) -> str:
    if len(s) <= _LOG_BYTE_CAP:
        return s
    head = s[: _LOG_BYTE_CAP // 2]
    tail = s[-_LOG_BYTE_CAP // 2 :]
    return f"{head}\n…[truncated {len(s) - _LOG_BYTE_CAP} bytes]…\n{tail}"


def execute_pipeline(
    code: str,
    ctx: PipelineContext,
    timeout_seconds: int = 600,
) -> PipelineResult:
    """Run a pipeline script in a controlled namespace, capturing
    stdout/stderr. Returns row counts + log + duration.

    A SIGALRM-based deadline kills the script after
    ``timeout_seconds`` so a malformed source (infinite paging loop,
    stuck Kafka subscriber, blocking SQL) can't permanently hold a
    scheduler slot. SIGALRM only works on POSIX from the main thread;
    we skip the wall-clock guard otherwise (Windows / threadpool).
    """
    import signal as _signal

    started = time.perf_counter()
    log_buf = io.StringIO()
    # Standard module dunders so libraries that introspect via
    # ``inspect.getmodule(f)`` (notably dlt's @resource decorator)
    # find the function's module in sys.modules. Skipping these caused
    # ``AttributeError: 'NoneType' object has no attribute '__name__'``
    # in dlt 1.x because ``__module__`` defaulted to None.
    allowed_modules = _load_admin_allowlist()
    namespace: dict[str, Any] = {
        "__name__": "__crunch_pipeline__",
        "__package__": None,
        "__doc__": None,
        "__loader__": None,
        "__spec__": None,
        "__builtins__": _build_safe_builtins(allowed_modules),
        "ctx": ctx,
        "print": _make_capturing_print(log_buf),
    }
    # Register the namespace as a fake module so ``inspect.getmodule``
    # can locate it. We unregister on exit to avoid leaking across runs.
    fake_mod = _types.ModuleType(namespace["__name__"])
    fake_mod.__dict__.update(namespace)
    _sys.modules[namespace["__name__"]] = fake_mod
    # Reuse the same dict so updates to ``namespace`` are visible via
    # the module entry — exec() mutates ``namespace`` in place.
    namespace = fake_mod.__dict__

    errors = _validate_pipeline_code(code)
    if errors:
        return PipelineResult(
            success=False,
            error="; ".join(errors),
            duration_ms=(time.perf_counter() - started) * 1000,
        )

    # SIGALRM-based wall-clock guard. POSIX + main thread only — the
    # FastAPI worker hands pipeline runs off via ``run_in_executor``,
    # so SIGALRM won't fire there; in that case we degrade to "no
    # timeout" and rely on the per-resource deadlines instead (Kafka
    # consumer_timeout_ms, etc.). When we DO arm it, the script gets
    # cleanly aborted at the deadline with a useful error message.
    prev_handler = None
    alarm_armed = False
    try:
        prev_handler = _signal.signal(
            _signal.SIGALRM,
            lambda *_: (_ for _ in ()).throw(_PipelineTimeout(
                f"pipeline killed: ran longer than {timeout_seconds}s"
            )),
        )
        _signal.alarm(int(max(1, timeout_seconds)))
        alarm_armed = True
    except (ValueError, OSError, AttributeError):
        # Not the main thread, or not POSIX — skip the guard but keep
        # running.
        pass

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
    except _PipelineTimeout as exc:
        log_buf.write("\n")
        log_buf.write(str(exc) + "\n")
        return PipelineResult(
            success=False,
            log=_cap_log(log_buf.getvalue()),
            error=str(exc),
            duration_ms=(time.perf_counter() - started) * 1000,
        )
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
        if alarm_armed:
            try:
                _signal.alarm(0)
                if prev_handler is not None:
                    _signal.signal(_signal.SIGALRM, prev_handler)
            except (ValueError, OSError, AttributeError):
                pass
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
