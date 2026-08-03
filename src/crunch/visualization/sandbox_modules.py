"""
Import policy for the visualization sandbox.

Three categories, in priority order:

``blocked``
    Never importable, no matter what the whitelist says. These are the
    modules that turn the sandbox into a shell — filesystem, process,
    network, and introspection access. An admin cannot whitelist their way
    past this list; the check runs again at import time.

``stdlib``
    Part of Python itself. No pip involved and no version number to report,
    which is why the package manager has to special-case them: ``pip install
    time`` fails, and ``importlib.metadata.version("time")`` raises. They are
    reported as version ``"stdlib"``.

``pypi``
    Everything else — installed and versioned by pip as usual.

``SAFE_STDLIB`` is the subset always importable in the sandbox regardless of
the whitelist, so a chart can call ``time.time()`` or ``json.loads`` without
an admin having to add anything.
"""

from __future__ import annotations

import sys

#: Never importable. Filesystem, process, network, and introspection escapes.
BLOCKED_MODULES = frozenset({
    "os", "sys", "subprocess", "shutil", "pathlib", "tempfile", "glob",
    "fileinput", "importlib", "imp", "runpy", "compileall", "zipimport",
    "site", "sysconfig", "venv", "ctypes", "mmap", "fcntl", "pty", "tty",
    "termios", "resource", "signal", "gc", "inspect", "traceback", "atexit",
    "builtins", "__builtin__", "marshal", "pickle", "shelve", "dbm",
    "sqlite3", "socket", "ssl", "select", "selectors", "asyncio",
    "multiprocessing", "threading", "concurrent", "queue", "http", "urllib",
    "urllib2", "ftplib", "smtplib", "poplib", "imaplib", "telnetlib",
    "xmlrpc", "webbrowser", "cgi", "cgitb", "wsgiref", "requests",
    "platform", "getpass", "pwd", "grp", "crypt", "code", "codeop", "pdb",
    "bdb", "cProfile", "profile", "pstats", "trace", "tracemalloc",
    "faulthandler", "ast", "dis", "py_compile", "modulefinder", "pkgutil",
    "distutils", "setuptools", "pip", "ensurepip",
})

#: Always importable in the sandbox — pure computation, no I/O.
SAFE_STDLIB = frozenset({
    "time", "datetime", "calendar", "zoneinfo",
    "math", "cmath", "statistics", "random", "decimal", "fractions", "numbers",
    "json", "csv", "re", "string", "textwrap", "unicodedata", "difflib",
    "collections", "itertools", "functools", "operator", "heapq", "bisect",
    "array", "copy", "types", "typing", "dataclasses", "enum", "abc",
    "uuid", "hashlib", "hmac", "base64", "binascii", "struct", "zlib",
    "io", "warnings", "contextlib", "pprint", "reprlib", "locale", "gettext",
    "colorsys", "graphlib",
})


def is_blocked(name: str) -> bool:
    """True if the module may never be imported, whitelist or not."""
    return name.split(".")[0] in BLOCKED_MODULES


def is_stdlib(name: str) -> bool:
    """True if the module ships with Python (so pip must not be involved).

    Uses ``sys.stdlib_module_names`` (3.10+) rather than a hand-maintained
    list, so it stays correct across Python versions.
    """
    top = name.split(".")[0]
    return top in getattr(sys, "stdlib_module_names", frozenset()) or top in SAFE_STDLIB


def classify(name: str) -> str:
    """Return ``"blocked"``, ``"stdlib"``, or ``"pypi"``."""
    if is_blocked(name):
        return "blocked"
    if is_stdlib(name):
        return "stdlib"
    return "pypi"


def resolve_allowed(requested: list[str] | dict[str, str] | None) -> dict[str, str]:
    """Build the sandbox's import whitelist.

    Always folds in ``SAFE_STDLIB`` so basic modules work regardless of what
    the package table happens to contain, and always subtracts
    ``BLOCKED_MODULES`` so nothing in the table can widen the sandbox.
    """
    allowed: dict[str, str] = {name: name for name in SAFE_STDLIB}
    if isinstance(requested, dict):
        allowed.update(requested)
    elif requested:
        allowed.update({name: name for name in requested})
    return {k: v for k, v in allowed.items() if not is_blocked(k)}
