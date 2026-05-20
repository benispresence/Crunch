"""
Metabase-style SQL/Python templating with variables and optional clauses.

Two syntax constructs, identical to Metabase's templated questions so
that imported queries Just Work:

* ``{{var}}``        — variable reference. Replaced with a SQL bind
                      parameter (``:var``) so values flow through the
                      driver and can never be SQL-injected.
* ``[[ ... {{v}} ... ]]`` — optional clause. The entire bracketed
                            chunk is dropped if any referenced variable
                            is unset or blank; otherwise the brackets
                            are stripped and the inner variables are
                            substituted normally.

Nesting of optional clauses is not supported, matching Metabase.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

# Permissive identifier — Metabase allows letters, digits, underscores,
# and hyphens / spaces are usually not in names. We accept the same.
_VAR_NAME = r"[A-Za-z_][A-Za-z0-9_]*"
_VAR_RE = re.compile(r"\{\{\s*(" + _VAR_NAME + r")\s*\}\}")
# Optional clauses can't contain nested [[ ]] (matches Metabase). We
# capture the inner text lazily so consecutive clauses don't fuse.
_OPT_RE = re.compile(r"\[\[(.+?)\]\]", re.DOTALL)


class TemplateError(ValueError):
    """A parameter is referenced by the template but not supplied or
    has the wrong type. The error message is safe to surface to users."""


@dataclass(frozen=True)
class ParameterSpec:
    """How to coerce and validate a parameter value.

    Mirrors the per-query ``parameters_json`` rows. ``type`` controls
    coercion: text values stay strings, number → float/int, date →
    ISO-formatted string, boolean → 0/1 ints (so MySQL/SQLite/Postgres
    all accept it as a boolean).
    """

    name: str
    type: str = "text"  # "text" | "number" | "date" | "boolean"
    default: Any = None
    required: bool = False


def parse_variable_names(sql: str) -> list[str]:
    """Return the unique variable names referenced in ``sql`` in
    document order. Used by the editor's auto-detect feature."""
    seen: list[str] = []
    for m in _VAR_RE.finditer(sql):
        name = m.group(1)
        if name not in seen:
            seen.append(name)
    return seen


def _coerce(spec: ParameterSpec, raw: Any) -> Any:
    """Coerce ``raw`` to the SQL-bind value for ``spec.type``. Returns
    None if the value is blank — the caller treats that as 'unset'."""
    if raw is None:
        return None
    if isinstance(raw, str) and raw.strip() == "":
        return None
    t = spec.type
    try:
        if t == "number":
            # Floats stay floats; integral floats collapse to int so the
            # downstream driver picks the right binding.
            f = float(raw)
            return int(f) if f.is_integer() else f
        if t == "boolean":
            if isinstance(raw, bool):
                return 1 if raw else 0
            s = str(raw).strip().lower()
            if s in ("true", "1", "yes", "y"):
                return 1
            if s in ("false", "0", "no", "n"):
                return 0
            raise ValueError(f"not a boolean: {raw!r}")
        if t == "date":
            if isinstance(raw, (date, datetime)):
                return raw.isoformat()
            # Accept any string the driver will parse — we just hand it
            # through. Validation that it's a real date is the driver's job.
            return str(raw)
        # text — strings unchanged.
        return str(raw)
    except (TypeError, ValueError) as exc:
        raise TemplateError(
            f"Parameter '{spec.name}' is not a valid {t}: {exc}"
        ) from exc


def _resolve(
    name: str,
    specs: dict[str, ParameterSpec],
    values: dict[str, Any],
) -> Any:
    """Look up a single variable. Falls back to spec.default if no
    explicit value was provided. Returns None for "unset"."""
    spec = specs.get(name)
    if spec is None:
        # Treat undeclared vars as plain text — keeps the editor flow
        # forgiving (you can type {{x}} before defining x).
        spec = ParameterSpec(name=name)
    raw = values.get(name, spec.default if spec.default not in ("", None) else None)
    return _coerce(spec, raw)


def render(
    sql: str,
    parameters: list[ParameterSpec] | None = None,
    values: dict[str, Any] | None = None,
) -> tuple[str, dict[str, Any]]:
    """Apply Metabase-style templating.

    Returns ``(rendered_sql, bind_params)``. ``rendered_sql`` has
    ``:name`` placeholders that map to entries in ``bind_params``;
    drivers like SQLAlchemy + psycopg/pymysql turn those into
    parametrised queries.

    * Optional clauses are dropped if any referenced variable is unset.
    * Unmatched required parameters raise :class:`TemplateError`.
    """
    parameters = parameters or []
    values = values or {}
    specs: dict[str, ParameterSpec] = {p.name: p for p in parameters}
    binds: dict[str, Any] = {}

    # First pass: optional clauses. We resolve each one before touching
    # the surrounding required variables so a missing-but-required
    # variable doesn't error if it only appears inside a clause that
    # gets dropped anyway.
    def _opt_sub(match: re.Match[str]) -> str:
        body = match.group(1)
        names_in_body = _VAR_RE.findall(body)
        # Drop the clause entirely if *any* variable inside is unset.
        for nm in names_in_body:
            if _resolve(nm, specs, values) is None:
                return ""
        # Otherwise keep the inner text — the second pass will swap
        # {{v}} for :v and seed the binds.
        return body

    after_opt = _OPT_RE.sub(_opt_sub, sql)

    def _var_sub(match: re.Match[str]) -> str:
        name = match.group(1)
        val = _resolve(name, specs, values)
        if val is None:
            spec = specs.get(name)
            if spec is not None and spec.required:
                raise TemplateError(
                    f"Required parameter '{name}' is not set"
                )
            # Unrequired-and-missing variable outside an optional
            # clause: bind NULL. Mirrors Metabase behaviour for
            # plain {{var}} when no value provided.
            binds[name] = None
        else:
            binds[name] = val
        return f":{name}"

    rendered = _VAR_RE.sub(_var_sub, after_opt)
    return rendered, binds


def coerce_values(
    parameters: list[ParameterSpec],
    values: dict[str, Any] | None,
) -> dict[str, Any]:
    """Coerce a value bag against declared specs for Python-side use
    (e.g. exposing ``params`` to user chart code). Drops blanks. Raises
    :class:`TemplateError` if a required parameter is missing."""
    values = values or {}
    out: dict[str, Any] = {}
    for spec in parameters:
        val = _coerce(spec, values.get(spec.name, spec.default))
        if val is None:
            if spec.required:
                raise TemplateError(
                    f"Required parameter '{spec.name}' is not set"
                )
            continue
        out[spec.name] = val
    return out
