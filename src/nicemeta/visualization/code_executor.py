"""
Safe code executor for visualization code.

Executes user-provided Python code in a restricted namespace
with a controlled import function that only allows whitelisted modules.
"""

import signal
import time
import traceback
from dataclasses import dataclass
from typing import Any

import pandas as pd


class _ExecutionTimeout(Exception):
    pass


@dataclass
class ExecutionResult:
    """Result of code execution."""

    success: bool
    figure: Any | None = None  # The plotly/matplotlib figure
    html: str | None = None  # Rendered HTML
    error: str | None = None
    error_line: int | None = None


class CodeExecutor:
    """
    Safely executes visualization code in a restricted namespace.

    Uses a controlled import function that only allows admin-whitelisted
    modules. Dangerous modules (os, sys, subprocess, etc.) are blocked
    both by static validation and by the import whitelist.
    """

    # Fallback whitelist used when DB is unavailable.
    _FALLBACK_WHITELIST: dict[str, str] = {
        "pandas": "pandas", "numpy": "numpy",
        "plotly": "plotly", "datetime": "datetime", "math": "math",
        "matplotlib": "matplotlib", "seaborn": "seaborn",
        "json": "json", "re": "re", "collections": "collections",
        "itertools": "itertools", "functools": "functools",
        "statistics": "statistics", "decimal": "decimal",
    }

    # Class-level cache for the whitelist
    _allowed_modules_cache: dict[str, str] | None = None
    _cache_timestamp: float = 0
    _CACHE_TTL: float = 60.0  # seconds

    @classmethod
    def execute(
        cls,
        code: str,
        df: pd.DataFrame,
        timeout: float = 30.0,
    ) -> ExecutionResult:
        """
        Execute visualization code and return the result.

        Args:
            code: Python code to execute
            df: DataFrame to make available as 'df'
            timeout: Maximum execution time in seconds

        Returns:
            ExecutionResult with figure or error
        """
        try:
            # Validate before execution
            errors = cls.validate_code(code)
            if errors:
                return ExecutionResult(
                    success=False,
                    error="; ".join(errors),
                )

            # Load the allowed modules whitelist
            allowed_modules = cls._get_allowed_modules()

            # Build the restricted namespace
            namespace = cls._build_namespace(df, allowed_modules)

            # Execute with timeout enforcement
            def _timeout_handler(signum, frame):
                raise _ExecutionTimeout("Code execution timed out")

            old_handler = None
            try:
                old_handler = signal.signal(signal.SIGALRM, _timeout_handler)
                signal.alarm(int(timeout))
            except (ValueError, OSError, AttributeError):
                pass  # SIGALRM not available (Windows / non-main thread)

            try:
                exec(code, namespace)
            finally:
                try:
                    signal.alarm(0)
                    if old_handler is not None:
                        signal.signal(signal.SIGALRM, old_handler)
                except (ValueError, OSError, AttributeError):
                    pass

            # Look for 'fig' in the namespace (the expected output)
            fig = namespace.get("fig")

            if fig is None:
                # Try to find any figure-like object
                for var_name, var_value in namespace.items():
                    if var_name.startswith("_"):
                        continue
                    if cls._is_figure(var_value):
                        fig = var_value
                        break

            if fig is None:
                return ExecutionResult(
                    success=False,
                    error="No figure found. Make sure your code creates a 'fig' variable.",
                )

            # Render the figure to HTML
            html = cls._render_to_html(fig)

            return ExecutionResult(
                success=True,
                figure=fig,
                html=html,
            )

        except _ExecutionTimeout:
            return ExecutionResult(
                success=False,
                error=f"Code execution timed out after {timeout} seconds",
            )
        except SyntaxError as e:
            return ExecutionResult(
                success=False,
                error=f"Syntax error on line {e.lineno}: {e.msg}",
                error_line=e.lineno,
            )
        except Exception as e:
            # Get the line number from traceback
            tb = traceback.extract_tb(e.__traceback__)
            error_line = None
            for frame in reversed(tb):
                if frame.filename == "<string>":
                    error_line = frame.lineno
                    break

            return ExecutionResult(
                success=False,
                error=f"{type(e).__name__}: {str(e)}",
                error_line=error_line,
            )

    @classmethod
    def _get_allowed_modules(cls) -> dict[str, str]:
        """Get allowed modules whitelist, cached for performance."""
        now = time.time()
        if cls._allowed_modules_cache is not None and (now - cls._cache_timestamp) < cls._CACHE_TTL:
            return cls._allowed_modules_cache

        try:
            import asyncio
            import concurrent.futures

            async def _load():
                from nicemeta.services.package_service import get_whitelist
                return await get_whitelist()

            try:
                loop = asyncio.get_running_loop()
                # We're inside an async context — run in a thread
                with concurrent.futures.ThreadPoolExecutor() as pool:
                    result = pool.submit(asyncio.run, _load()).result(timeout=5)
            except RuntimeError:
                # No running loop
                result = asyncio.run(_load())

            if result:
                cls._allowed_modules_cache = result
                cls._cache_timestamp = now
                return result
        except Exception:
            pass

        # Fallback to hardcoded defaults
        cls._allowed_modules_cache = cls._FALLBACK_WHITELIST.copy()
        cls._cache_timestamp = now
        return cls._allowed_modules_cache

    @classmethod
    def invalidate_cache(cls) -> None:
        """Force the whitelist cache to reload on next execution."""
        cls._allowed_modules_cache = None
        cls._cache_timestamp = 0

    @classmethod
    def _make_controlled_import(cls, allowed_modules: dict[str, str]) -> callable:
        """
        Create a controlled __import__ function for the sandbox.

        Only allows importing modules whose top-level name is in the whitelist.
        """
        _real_import = __import__

        def _controlled_import(name, globals=None, locals=None, fromlist=(), level=0):
            top_level = name.split(".")[0]
            if top_level not in allowed_modules:
                raise ImportError(
                    f"Module '{name}' is not in the allowed package list. "
                    f"Ask an admin to add it via Settings > Packages."
                )
            return _real_import(name, globals, locals, fromlist, level)

        return _controlled_import

    @classmethod
    def _build_namespace(cls, df: pd.DataFrame, allowed_modules: dict[str, str]) -> dict[str, Any]:
        """Build the restricted execution namespace with controlled imports."""
        import datetime
        import math

        import numpy as np
        import pandas as pd_module
        import plotly.express as px
        import plotly.graph_objects as go
        from plotly.subplots import make_subplots

        controlled_import = cls._make_controlled_import(allowed_modules)

        namespace = {
            # Controlled builtins — only __import__ is exposed
            "__builtins__": {
                "__import__": controlled_import,
            },

            # Data
            "df": df,

            # Pre-imported modules (backward compatibility)
            "pd": pd_module,
            "DataFrame": pd_module.DataFrame,
            "Series": pd_module.Series,
            "np": np,
            "px": px,
            "go": go,
            "make_subplots": make_subplots,
            "datetime": datetime,
            "math": math,

            # Built-in functions (safe subset)
            "len": len,
            "range": range,
            "list": list,
            "dict": dict,
            "str": str,
            "int": int,
            "float": float,
            "bool": bool,
            "tuple": tuple,
            "set": set,
            "sum": sum,
            "min": min,
            "max": max,
            "abs": abs,
            "round": round,
            "sorted": sorted,
            "reversed": reversed,
            "enumerate": enumerate,
            "zip": zip,
            "map": map,
            "filter": filter,
            "isinstance": isinstance,
            "hasattr": hasattr,
            "print": print,
            "type": type,
            "True": True,
            "False": False,
            "None": None,
        }

        return namespace

    @classmethod
    def _is_figure(cls, obj: Any) -> bool:
        """Check if an object is a figure."""
        try:
            import plotly.graph_objects as go
            if isinstance(obj, go.Figure):
                return True
        except ImportError:
            pass

        try:
            import matplotlib.figure
            if isinstance(obj, matplotlib.figure.Figure):
                return True
        except ImportError:
            pass

        return False

    @classmethod
    def _render_to_html(cls, fig: Any) -> str:
        """Render a figure to HTML."""
        try:
            import plotly.graph_objects as go
            if isinstance(fig, go.Figure):
                return fig.to_html(
                    include_plotlyjs="cdn",
                    full_html=False,
                    config={"responsive": True},
                )
        except (ImportError, AttributeError):
            pass

        try:
            import io
            import base64
            import matplotlib.figure
            if isinstance(fig, matplotlib.figure.Figure):
                buf = io.BytesIO()
                fig.savefig(buf, format='png', bbox_inches='tight')
                buf.seek(0)
                img_base64 = base64.b64encode(buf.read()).decode('utf-8')
                return f'<img src="data:image/png;base64,{img_base64}" />'
        except (ImportError, AttributeError):
            pass

        return "<div>Unable to render figure</div>"

    @classmethod
    def validate_code(cls, code: str) -> list[str]:
        """
        Validate code before execution.

        Args:
            code: Python code to validate

        Returns:
            List of validation errors (empty if valid)
        """
        errors = []

        import re

        # Dangerous patterns — modules and functions that are never allowed
        dangerous_words = [
            "os", "sys", "subprocess", "shutil",
            "socket", "urllib", "requests", "http",
            "__import__", "exec", "eval", "compile",
            "open", "file", "input",
            "getattr", "setattr", "delattr",
            "globals", "locals", "vars",
            "breakpoint", "exit", "quit",
        ]

        for danger in dangerous_words:
            if danger in code:
                pattern = rf'\b{re.escape(danger)}\b'
                if re.search(pattern, code):
                    errors.append(f"Unsafe operation detected: '{danger}' is not allowed")

        # Block sandbox-escape patterns
        sandbox_patterns = [
            r"__builtins__",
            r"__subclasses__",
            r"__class__",
            r"__bases__",
            r"__mro__",
            r"__globals__",
            r"__code__",
            r"__import__",
        ]
        for pat in sandbox_patterns:
            if re.search(pat, code):
                errors.append(f"Unsafe pattern detected: '{pat}' is not allowed")

        # Check for syntax errors
        try:
            compile(code, "<string>", "exec")
        except SyntaxError as e:
            errors.append(f"Syntax error on line {e.lineno}: {e.msg}")

        return errors


def execute_visualization_code(
    code: str,
    df: pd.DataFrame,
) -> ExecutionResult:
    """
    Convenience function to execute visualization code.

    Args:
        code: Python code to execute
        df: DataFrame with the data

    Returns:
        ExecutionResult with figure or error
    """
    return CodeExecutor.execute(code, df)


def validate_visualization_code(code: str) -> list[str]:
    """
    Convenience function to validate visualization code.

    Args:
        code: Python code to validate

    Returns:
        List of validation errors
    """
    return CodeExecutor.validate_code(code)
