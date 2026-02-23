"""
Safe code executor for visualization code.

Executes user-provided Python code in a restricted namespace.
"""

import signal
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
    
    Only allows specific imports and operations to prevent
    arbitrary code execution vulnerabilities.
    """
    
    # Allowed modules that can be imported
    ALLOWED_MODULES = {
        "pandas": "pd",
        "numpy": "np",
        "plotly.express": "px",
        "plotly.graph_objects": "go",
        "plotly.subplots": None,
        "datetime": None,
        "math": None,
    }

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

            # Build the restricted namespace
            namespace = cls._build_namespace(df)

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
                # Check if the last expression was a figure
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
    def _build_namespace(cls, df: pd.DataFrame) -> dict[str, Any]:
        """Build the restricted execution namespace."""
        import datetime
        import math
        
        import numpy as np
        import pandas as pd_module
        import plotly.express as px
        import plotly.graph_objects as go
        from plotly.subplots import make_subplots
        
        namespace = {
            # Block access to __builtins__ to prevent sandbox escape
            "__builtins__": {},

            # Data
            "df": df,

            # Pandas
            "pd": pd_module,
            "DataFrame": pd_module.DataFrame,
            "Series": pd_module.Series,

            # NumPy
            "np": np,

            # Plotly
            "px": px,
            "go": go,
            "make_subplots": make_subplots,

            # Standard library
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
            "True": True,
            "False": False,
            "None": None,
        }

        return namespace

    @classmethod
    def _is_figure(cls, obj: Any) -> bool:
        """Check if an object is a figure."""
        # Check for Plotly figures
        try:
            import plotly.graph_objects as go
            if isinstance(obj, go.Figure):
                return True
        except ImportError:
            pass
        
        # Check for matplotlib figures
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
        # Try Plotly
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
        
        # Try matplotlib
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

        # Check for dangerous patterns
        import re

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

        # Block sandbox-escape patterns (attribute access tricks)
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

