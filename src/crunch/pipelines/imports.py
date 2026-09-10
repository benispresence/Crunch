"""
Static import analysis for pipeline code.

The pipeline sandbox refuses two different things with two different
fixes, and the traceback alone doesn't tell them apart:

* ``ImportError: not in the allowed package list`` — the module exists
  in the worker, but no admin has allowed it.
* ``ModuleNotFoundError`` — the module *is* allowed, but nobody has pip
  installed it into the interpreter that runs pipelines.

Both are an admin round-trip, so the editor surfaces them before a run
rather than after one. This module does the analysis; the engine
exposes it over ``/pipelines/imports`` and runs it inside the very
interpreter that will execute the pipeline, so "installed" means
installed *there*.
"""

from __future__ import annotations

import ast
import importlib.util
import sys

#: Import fine, no admin action needed.
STATUS_OK = "ok"
#: Allowed, but not importable in the worker — an admin has to install it.
STATUS_NOT_INSTALLED = "not_installed"
#: Not on the allowlist — an admin has to add it.
STATUS_NOT_ALLOWED = "not_allowed"

#: Import name → PyPI distribution when they differ.
PIP_NAME_FOR_IMPORT = {
    "kafka": "kafka-python",
    "bs4": "beautifulsoup4",
    "sklearn": "scikit-learn",
    "cv2": "opencv-python",
    "yaml": "PyYAML",
    "PIL": "Pillow",
    "dateutil": "python-dateutil",
    "psycopg2": "psycopg2-binary",
    "MySQLdb": "mysqlclient",
    "psycopg": "psycopg[binary]",
}


def pip_name_for_import(module: str) -> str:
    """PyPI name to install for a top-level import."""
    return PIP_NAME_FOR_IMPORT.get(module, module)


def extract_imports(code: str) -> list[tuple[str, int]]:
    """Return ``(top_level_module, line_number)`` for every import.

    Parse errors yield an empty list: the editor's job here is to flag
    packages, and a syntax error is already reported by validation.
    """
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return []
    found: dict[str, int] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.split(".")[0]
                found.setdefault(top, node.lineno)
        elif isinstance(node, ast.ImportFrom):
            # ``from . import x`` has no module to allowlist.
            if node.level or not node.module:
                continue
            top = node.module.split(".")[0]
            found.setdefault(top, node.lineno)
    return sorted(found.items(), key=lambda item: item[1])


def _is_importable(module: str) -> bool:
    if module in getattr(sys, "stdlib_module_names", frozenset()):
        return True
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


def analyze_imports(
    code: str, allowed_modules: dict[str, str] | None = None,
) -> list[dict[str, object]]:
    """Classify each import in ``code`` as ok / not installed / not allowed.

    ``allowed_modules`` is the admin table as the caller knows it; it
    is merged with the pipeline defaults so ``requests`` / ``dlt`` stay
    allowed even when the table is empty. Analysis runs in the engine
    interpreter, so "installed" means installed *there*.
    """
    from .executor import _merge_allowlist

    allowed_modules = _merge_allowlist(allowed_modules)

    out: list[dict[str, object]] = []
    for module, line in extract_imports(code):
        pip_name = pip_name_for_import(module)
        base = {
            "module": module,
            "line": line,
            "pip_name": pip_name,
            "action": "",
        }
        if module == "os":
            # Not allowlisted and not blocked — the executor swaps in a
            # curated stand-in. See executor._build_os_module.
            out.append({
                **base, "status": STATUS_OK,
                "detail": "Built in: os.environ, os.getenv and os.path only.",
            })
            continue
        if module not in allowed_modules:
            out.append({
                **base, "status": STATUS_NOT_ALLOWED,
                "action": "allow_and_install",
                "detail": (
                    f"'{module}' is not in the allowed package list. "
                    "An admin can allow and install it from Admin → Allowed packages."
                ),
            })
            continue
        if not _is_importable(module):
            out.append({
                **base, "status": STATUS_NOT_INSTALLED,
                "action": "install",
                "detail": (
                    f"'{module}' is allowed for pipelines but not installed "
                    "in the Python engine. An admin can install it from "
                    "Admin → Allowed packages."
                ),
            })
            continue
        out.append({**base, "status": STATUS_OK, "detail": ""})
    return out
