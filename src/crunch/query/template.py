"""
Metabase-style SQL/Python templating with variables, optional clauses,
and field filters.

Three syntax constructs, matching Metabase's native SQL questions so
imported queries Just Work:

* ``{{var}}`` — variable reference. By default replaced with a SQL bind
  parameter (``:var``) so values flow through the driver and can never
  be SQL-injected.
* ``{{var}}`` with a mapped column (``type="field"`` / ``target=...``)
  — **field filter**. Replaced with a SQL *clause*
  (``column = :var``, ``column >= :var__start AND column < :var__end``,
  …) rather than a scalar bind. An unset field filter becomes ``1=1``.
* ``[[ ... {{v}} ... ]]`` — optional clause. The entire bracketed
  chunk is dropped if any referenced variable is unset or blank;
  otherwise the brackets are stripped and the inner variables are
  substituted normally.

Nesting of optional clauses is not supported, matching Metabase.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

# Permissive identifier — Metabase allows letters, digits, underscores,
# and hyphens / spaces are usually not in names. We accept the same.
_VAR_NAME = r"[A-Za-z_][A-Za-z0-9_]*"
_VAR_RE = re.compile(r"\{\{\s*(" + _VAR_NAME + r")\s*\}\}")
# Optional clauses can't contain nested [[ ]] (matches Metabase). We
# capture the inner text lazily so consecutive clauses don't fuse.
_OPT_RE = re.compile(r"\[\[(.+?)\]\]", re.DOTALL)

# A single identifier segment: unquoted, "double", `backtick`, or [bracket].
_IDENT_SEG = re.compile(
    r'("[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*)'
)
_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_ISO_MONTH = re.compile(r"^\d{4}-\d{2}$")
_ISO_DT = re.compile(
    r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$"
)
# Names that almost always hold a date. Used as a safety net so a
# ``{{start_date}}`` auto-detected as text still binds a real date
# object — asyncpg rejects ISO strings for timestamp parameters.
_DATE_NAME_RE = re.compile(
    r"(?:^|_)(?:date|time|timestamp|month|year)(?:$|_)"
    r"|(?:_at|_on|_ts)$"
    r"|^(?:since|until)$",
    re.I,
)

_DATE_WIDGETS = frozenset({"date", "daterange", "month"})
_RANGE_TOKENS = frozenset(
    {
        "today",
        "yesterday",
        "this_week",
        "last_week",
        "this_month",
        "last_month",
        "this_quarter",
        "last_quarter",
        "this_year",
        "last_year",
        "last_7_days",
        "last_30_days",
        "last_90_days",
        "last_365_days",
        "7d",
        "30d",
        "90d",
        "365d",
    }
)


class TemplateError(ValueError):
    """A parameter is referenced by the template but not supplied or
    has the wrong type. The error message is safe to surface to users."""


@dataclass(frozen=True)
class ParameterSpec:
    """How to coerce and validate a parameter value.

    Mirrors the per-query ``parameters_json`` rows. ``type`` controls
    coercion: text values stay strings, number → float/int, date → a
    real ``datetime.date`` / ``datetime.datetime`` (asyncpg and other
    drivers reject ISO strings for date columns), boolean → 0/1 ints.

    Field filters (``type="field"`` or a non-empty ``target``) replace
    ``{{name}}`` with a SQL predicate on ``target`` instead of a
    scalar bind.
    """

    name: str
    type: str = "text"  # "text" | "number" | "date" | "boolean" | "field"
    default: Any = None
    required: bool = False
    widget: str | None = None  # input | dropdown | date | daterange | month | toggle
    target: str | None = None  # mapped column, e.g. hex.stakes.created_at


def _is_field_filter(spec: ParameterSpec) -> bool:
    if spec.type == "field":
        return True
    return bool(spec.target)


def _is_date_name(name: str) -> bool:
    return bool(_DATE_NAME_RE.search(name))


def _as_date(value: date | datetime) -> date:
    return value.date() if isinstance(value, datetime) else value


def _add_months(d: date, months: int) -> date:
    """Shift a date by ``months``, snapping to the 1st. Used for
    month/quarter exclusive-end bounds."""
    month0 = d.month - 1 + months
    year = d.year + month0 // 12
    month = month0 % 12 + 1
    return date(year, month, 1)


def _quarter_start(d: date) -> date:
    return date(d.year, ((d.month - 1) // 3) * 3 + 1, 1)


def _week_start(d: date) -> date:
    return d - timedelta(days=d.weekday())  # Monday, ISO


def _strip_relative_prefix(raw: str) -> str:
    key = raw.strip()
    if key.lower().startswith("relative:"):
        key = key[9:]
    return key.strip()


def _relative_date(raw: str) -> date | None:
    """Resolve UI relative-date tokens to a single date (start of the
    period for month/year; 'Nd' → today minus N days)."""
    key = _strip_relative_prefix(raw).lower()
    today = date.today()
    if key in ("today", "now"):
        return today
    if key == "yesterday":
        return today - timedelta(days=1)
    if key in ("this_month", "month"):
        return today.replace(day=1)
    if key in ("this_year", "year"):
        return today.replace(month=1, day=1)
    if key == "this_week":
        return _week_start(today)
    if key == "this_quarter":
        return _quarter_start(today)
    m = re.fullmatch(r"(\d+)d", key)
    if m:
        return today - timedelta(days=int(m.group(1)))
    m = re.fullmatch(r"last_(\d+)_days", key)
    if m:
        return today - timedelta(days=int(m.group(1)))
    return None


def _relative_range(raw: str) -> tuple[date, date] | None:
    """Resolve a relative token to ``(start_inclusive, end_exclusive)``."""
    key = _strip_relative_prefix(raw).lower()
    today = date.today()
    tomorrow = today + timedelta(days=1)
    if key in ("today", "now"):
        return today, tomorrow
    if key == "yesterday":
        return today - timedelta(days=1), today
    if key == "this_week":
        start = _week_start(today)
        return start, start + timedelta(days=7)
    if key == "last_week":
        start = _week_start(today) - timedelta(days=7)
        return start, start + timedelta(days=7)
    if key in ("this_month", "month"):
        start = today.replace(day=1)
        return start, _add_months(start, 1)
    if key == "last_month":
        start = _add_months(today.replace(day=1), -1)
        return start, today.replace(day=1)
    if key == "this_quarter":
        start = _quarter_start(today)
        return start, _add_months(start, 3)
    if key == "last_quarter":
        this_q = _quarter_start(today)
        start = _add_months(this_q, -3)
        return start, this_q
    if key in ("this_year", "year"):
        start = date(today.year, 1, 1)
        return start, date(today.year + 1, 1, 1)
    if key == "last_year":
        return date(today.year - 1, 1, 1), date(today.year, 1, 1)
    m = re.fullmatch(r"(\d+)d", key) or re.fullmatch(r"last_(\d+)_days", key)
    if m:
        n = int(m.group(1))
        # Inclusive of today: last 7 days = today-6 .. tomorrow.
        return today - timedelta(days=n - 1), tomorrow
    return None


def _parse_temporal(raw: Any) -> date | datetime | None:
    """Parse a date/datetime value. Returns None if it isn't one."""
    if isinstance(raw, datetime):
        return raw
    if isinstance(raw, date):
        return raw
    if not isinstance(raw, str):
        return None
    s = raw.strip()
    if not s:
        return None
    rel = _relative_date(s)
    if rel is not None:
        return rel
    if _ISO_MONTH.fullmatch(s):
        y, m = int(s[:4]), int(s[5:7])
        try:
            return date(y, m, 1)
        except ValueError:
            return None
    if _ISO_DATE.fullmatch(s):
        try:
            return date.fromisoformat(s)
        except ValueError:
            return None
    if _ISO_DT.match(s):
        try:
            iso = s.replace("Z", "+00:00").replace(" ", "T", 1)
            return datetime.fromisoformat(iso)
        except ValueError:
            return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def _is_iso_temporal_string(raw: Any) -> bool:
    if not isinstance(raw, str):
        return False
    s = raw.strip()
    return bool(_ISO_DATE.fullmatch(s) or _ISO_MONTH.fullmatch(s) or _ISO_DT.match(s))


def parse_variable_names(sql: str) -> list[str]:
    """Return the unique variable names referenced in ``sql`` in
    document order. Used by the editor's auto-detect feature."""
    seen: list[str] = []
    for m in _VAR_RE.finditer(sql):
        name = m.group(1)
        if name not in seen:
            seen.append(name)
    return seen


def _blank(raw: Any) -> bool:
    if raw is None:
        return True
    if isinstance(raw, str) and raw.strip() == "":
        return True
    if isinstance(raw, (list, tuple)):
        return not any(not _blank(v) for v in raw)
    if isinstance(raw, dict):
        return _blank(raw.get("start")) and _blank(raw.get("end"))
    return False


def _sql_ident(target: str) -> str:
    """Validate a dotted column reference and return it unchanged.

    Each segment must be a plain identifier or an already-quoted
    ``"..."`` / `` `...` `` / ``[...]`` form. Rejecting anything else
    is what keeps field-filter targets from becoming SQL injection.
    """
    s = target.strip()
    if not s:
        raise TemplateError("Field filter is missing a mapped column")
    parts: list[str] = []
    rest = s
    while rest:
        m = _IDENT_SEG.match(rest)
        if not m:
            raise TemplateError(
                f"Invalid field filter column '{target}'. "
                "Use schema.table.column (letters, digits, underscore)."
            )
        parts.append(m.group(1))
        rest = rest[m.end() :]
        if not rest:
            break
        if rest[0] == ".":
            rest = rest[1:]
            if not rest:
                raise TemplateError(f"Invalid field filter column '{target}'")
            continue
        raise TemplateError(
            f"Invalid field filter column '{target}'. "
            "Use schema.table.column (letters, digits, underscore)."
        )
    return ".".join(parts)


def _next_day(value: date | datetime) -> date | datetime:
    return value + timedelta(days=1)


def _month_bounds(value: date | datetime) -> tuple[date, date]:
    start = _as_date(value).replace(day=1)
    return start, _add_months(start, 1)


def _range_from_value(
    raw: Any, widget: str | None = None
) -> tuple[date | datetime | None, date | datetime | None] | None:
    """Return ``(start_inclusive, end_exclusive)``. Either side may be
    None for an open-ended range. Returns None if the whole value is
    unset. ``end`` from the UI is treated as inclusive (the last day
    to include) except for relative tokens and YYYY-MM months, which
    already describe a period."""
    if _blank(raw):
        return None

    widget = (widget or "").lower()

    if isinstance(raw, dict):
        start_raw = raw.get("start")
        end_raw = raw.get("end")
        start = None if _blank(start_raw) else _parse_temporal(start_raw)
        end_in = None if _blank(end_raw) else _parse_temporal(end_raw)
        if start is None and end_in is None:
            return None
        end_excl: date | datetime | None = None
        if end_in is not None:
            if isinstance(end_raw, str) and _ISO_MONTH.fullmatch(end_raw.strip()):
                end_excl = _add_months(_as_date(end_in), 1)
            else:
                end_excl = _next_day(end_in)
        return start, end_excl

    if isinstance(raw, (date, datetime)):
        if widget == "month":
            return _month_bounds(raw)
        d = raw if isinstance(raw, datetime) else raw
        return d, _next_day(d)

    if isinstance(raw, str):
        s = _strip_relative_prefix(raw)
        if "~" in s:
            left, right = s.split("~", 1)
            return _range_from_value(
                {
                    "start": left.strip() or None,
                    "end": right.strip() or None,
                },
                widget,
            )
        rel = _relative_range(s)
        if rel is not None:
            return rel
        parsed = _parse_temporal(s)
        if parsed is None:
            raise TemplateError(f"not a valid date range: {raw!r}")
        if widget == "month" or _ISO_MONTH.fullmatch(s.strip()):
            return _month_bounds(parsed)
        return parsed, _next_day(parsed)

    return None


def _coerce(spec: ParameterSpec, raw: Any) -> Any:
    """Coerce ``raw`` to the SQL-bind value for ``spec.type``. Returns
    None if the value is blank — the caller treats that as 'unset'."""
    if _blank(raw):
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
        if t == "date" or t == "date_range":
            # A date *variable* is a single bind. Range-shaped values
            # (a {start,end} object or "from~to" string) contribute
            # their start; relative tokens like `7d` stay a point-in-
            # time via `_parse_temporal`.
            if isinstance(raw, dict) or (isinstance(raw, str) and "~" in raw):
                rng = _range_from_value(raw, spec.widget)
                if rng is None:
                    return None
                start, _end = rng
                return start
            parsed = _parse_temporal(raw)
            if parsed is None:
                raise ValueError(f"not a date: {raw!r}")
            return parsed
        if t == "field":
            # Field filters don't bind the raw value at this name; the
            # clause renderer consumes it. Returning the raw value lets
            # optional-clause detection treat "set" as truthy.
            return raw
        # text — but ISO dates on date-named params still need to be
        # real date objects. asyncpg type-checks binds *before* any
        # CAST() in the SQL, so a 'YYYY-MM-DD' string in
        # CAST(:start_date AS timestamp) raises DataError.
        if _is_date_name(spec.name) and _is_iso_temporal_string(raw):
            parsed = _parse_temporal(raw)
            if parsed is not None:
                return parsed
        return str(raw)
    except (TypeError, ValueError) as exc:
        raise TemplateError(
            f"Parameter '{spec.name}' is not a valid {t}: {exc}"
        ) from exc


def _lookup_raw(
    name: str,
    specs: dict[str, ParameterSpec],
    values: dict[str, Any],
) -> tuple[ParameterSpec, Any]:
    spec = specs.get(name)
    if spec is None:
        spec = ParameterSpec(name=name)
    raw = values.get(name, spec.default if spec.default not in ("", None) else None)
    return spec, raw


def _resolve(
    name: str,
    specs: dict[str, ParameterSpec],
    values: dict[str, Any],
) -> Any:
    """Look up a single variable. Falls back to spec.default if no
    explicit value was provided. Returns None for "unset"."""
    spec, raw = _lookup_raw(name, specs, values)
    if _is_field_filter(spec):
        return None if _blank(raw) else raw
    return _coerce(spec, raw)


def _render_field_filter(
    spec: ParameterSpec,
    raw: Any,
    binds: dict[str, Any],
) -> str | None:
    """Build a SQL clause for a field filter. Returns None if unset.

    Values always go through named binds; only the column identifier
    (already validated) is interpolated.
    """
    if _blank(raw):
        return None
    if not spec.target:
        raise TemplateError(
            f"Field filter '{spec.name}' has no mapped column. "
            "Set the column in filter settings (e.g. schema.table.column)."
        )
    col = _sql_ident(spec.target)
    widget = (spec.widget or "").lower()
    if widget in ("input", "dropdown", "toggle"):
        datey = False
    elif widget in _DATE_WIDGETS:
        datey = True
    else:
        datey = (
            _is_date_name(spec.target.split(".")[-1])
            or isinstance(raw, dict)
            or isinstance(raw, (date, datetime))
            or (
                isinstance(raw, str)
                and (
                    "~" in raw
                    or _strip_relative_prefix(raw).lower() in _RANGE_TOKENS
                    or _is_iso_temporal_string(raw)
                    or _relative_date(raw) is not None
                )
            )
        )

    if datey:
        rng = _range_from_value(raw, widget or "daterange")
        if rng is None:
            return None
        start, end = rng
        parts: list[str] = []
        if start is not None:
            k = f"{spec.name}__start"
            binds[k] = start
            parts.append(f"{col} >= :{k}")
        if end is not None:
            k = f"{spec.name}__end"
            binds[k] = end
            parts.append(f"{col} < :{k}")
        if not parts:
            return None
        clause = " AND ".join(parts)
        return f"({clause})" if len(parts) > 1 else clause

    if isinstance(raw, (list, tuple)):
        vals = [v for v in raw if not _blank(v)]
        if not vals:
            return None
        if len(vals) == 1:
            binds[spec.name] = vals[0]
            return f"{col} = :{spec.name}"
        keys: list[str] = []
        for i, v in enumerate(vals):
            k = f"{spec.name}__{i}"
            binds[k] = v
            keys.append(f":{k}")
        return f"{col} IN ({', '.join(keys)})"

    binds[spec.name] = raw if not isinstance(raw, str) else raw
    return f"{col} = :{spec.name}"


def render(
    sql: str,
    parameters: list[ParameterSpec] | None = None,
    values: dict[str, Any] | None = None,
) -> tuple[str, dict[str, Any]]:
    """Apply Metabase-style templating.

    Returns ``(rendered_sql, bind_params)``. ``rendered_sql`` has
    ``:name`` placeholders that map to entries in ``bind_params``;
    drivers like SQLAlchemy + psycopg/pymysql turn those into
    parametrised queries. Field filters inline a SQL clause that
    still uses those named binds for the compared values.

    * Optional clauses are dropped if any referenced variable is unset.
    * Unmatched required parameters raise :class:`TemplateError`.
    * Unset field filters become ``1=1``.
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
        # {{v}} for :v (or a field-filter clause) and seed the binds.
        return body

    after_opt = _OPT_RE.sub(_opt_sub, sql)

    def _var_sub(match: re.Match[str]) -> str:
        name = match.group(1)
        spec, raw = _lookup_raw(name, specs, values)
        if _is_field_filter(spec):
            clause = _render_field_filter(spec, raw, binds)
            if clause is None:
                if spec.required:
                    raise TemplateError(
                        f"Required parameter '{name}' is not set"
                    )
                return "1=1"
            return clause
        val = _coerce(spec, raw)
        if val is None:
            if spec.required:
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
        raw = values.get(spec.name, spec.default)
        if _is_field_filter(spec):
            if _blank(raw):
                if spec.required:
                    raise TemplateError(
                        f"Required parameter '{spec.name}' is not set"
                    )
                continue
            widget = (spec.widget or "").lower()
            datey = widget in _DATE_WIDGETS or isinstance(raw, dict)
            if datey:
                rng = _range_from_value(raw, widget or "daterange")
                if rng is None:
                    continue
                start, end = rng
                out[spec.name] = {"start": start, "end": end}
            else:
                out[spec.name] = raw
            continue
        val = _coerce(spec, raw)
        if val is None:
            if spec.required:
                raise TemplateError(
                    f"Required parameter '{spec.name}' is not set"
                )
            continue
        out[spec.name] = val
    return out
