"""
Tests for the Metabase-style SQL template engine.
"""

import importlib.util
import sys
from datetime import date
from pathlib import Path

import pytest


def _load_template_module():
    """Load template.py without dragging in the rest of nicemeta.query,
    which pulls pandas/sqlalchemy (heavy + not needed for these tests)."""
    path = Path(__file__).resolve().parent.parent / "src" / "crunch" / "query" / "template.py"
    spec = importlib.util.spec_from_file_location("nicemeta_template", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["nicemeta_template"] = mod
    spec.loader.exec_module(mod)
    return mod


template = _load_template_module()


def test_parse_variable_names_in_order_dedup():
    out = template.parse_variable_names(
        "SELECT * FROM t WHERE a = {{x}} AND b = {{y}} OR a = {{x}}"
    )
    assert out == ["x", "y"]


def test_render_substitutes_to_bind_params():
    sql, binds = template.render(
        "SELECT * FROM t WHERE a = {{x}}",
        [template.ParameterSpec(name="x", type="number")],
        {"x": "5"},
    )
    assert sql == "SELECT * FROM t WHERE a = :x"
    assert binds == {"x": 5}


def test_optional_clause_dropped_when_unset():
    sql, binds = template.render(
        "SELECT * FROM t [[ WHERE created_at > {{since}} ]]",
        [template.ParameterSpec(name="since", type="date")],
        {},
    )
    assert sql.strip() == "SELECT * FROM t"
    assert binds == {}


def test_optional_clause_kept_when_set():
    sql, binds = template.render(
        "SELECT * FROM t [[ WHERE created_at > {{since}} ]]",
        [template.ParameterSpec(name="since", type="date")],
        {"since": "2024-01-01"},
    )
    assert ":since" in sql
    assert "WHERE created_at >" in sql
    assert binds == {"since": date(2024, 1, 1)}


def test_multiple_optional_clauses_independent():
    sql, _ = template.render(
        "SELECT * FROM t WHERE 1=1 [[ AND a = {{a}} ]] [[ AND b = {{b}} ]]",
        [
            template.ParameterSpec(name="a", type="number"),
            template.ParameterSpec(name="b", type="text"),
        ],
        {"b": "hi"},
    )
    # a-clause dropped, b-clause kept.
    assert "AND a =" not in sql
    assert "AND b = :b" in sql


def test_optional_clause_with_multiple_vars_needs_all_set():
    # Mirrors Metabase: if any var inside the optional clause is unset,
    # the clause vanishes entirely.
    spec = [
        template.ParameterSpec(name="a", type="number"),
        template.ParameterSpec(name="b", type="number"),
    ]
    sql, _ = template.render(
        "SELECT * FROM t [[ WHERE a BETWEEN {{a}} AND {{b}} ]]",
        spec,
        {"a": "1"},
    )
    assert "WHERE" not in sql

    sql, binds = template.render(
        "SELECT * FROM t [[ WHERE a BETWEEN {{a}} AND {{b}} ]]",
        spec,
        {"a": "1", "b": "10"},
    )
    assert ":a" in sql and ":b" in sql
    assert binds == {"a": 1, "b": 10}


def test_required_parameter_raises_when_missing():
    with pytest.raises(template.TemplateError):
        template.render(
            "SELECT {{x}}",
            [template.ParameterSpec(name="x", required=True)],
            {},
        )


def test_required_inside_optional_clause_does_not_error():
    # The optional wrapper makes "required" vacuous — if you didn't
    # supply the value, the whole clause is dropped before validation.
    sql, _ = template.render(
        "SELECT * FROM t [[ WHERE x = {{x}} ]]",
        [template.ParameterSpec(name="x", required=True)],
        {},
    )
    assert sql.strip() == "SELECT * FROM t"


def test_boolean_coercion_to_int():
    _, binds = template.render(
        "SELECT * FROM t WHERE f = {{f}}",
        [template.ParameterSpec(name="f", type="boolean")],
        {"f": "true"},
    )
    assert binds == {"f": 1}

    _, binds = template.render(
        "SELECT * FROM t WHERE f = {{f}}",
        [template.ParameterSpec(name="f", type="boolean")],
        {"f": False},
    )
    assert binds == {"f": 0}


def test_default_used_when_value_missing():
    _, binds = template.render(
        "SELECT * FROM t WHERE x = {{x}}",
        [template.ParameterSpec(name="x", type="number", default=42)],
        {},
    )
    assert binds == {"x": 42}


def test_blank_string_treated_as_unset():
    # Matches the Metabase UX: leaving the input empty drops the clause.
    sql, _ = template.render(
        "SELECT * FROM t [[ WHERE x = {{x}} ]]",
        [template.ParameterSpec(name="x", type="text")],
        {"x": "   "},
    )
    assert "WHERE" not in sql


def test_invalid_type_raises_user_friendly_error():
    with pytest.raises(template.TemplateError) as exc:
        template.render(
            "SELECT {{x}}",
            [template.ParameterSpec(name="x", type="number")],
            {"x": "not-a-number"},
        )
    assert "x" in str(exc.value)
    assert "number" in str(exc.value)


def test_undeclared_variable_treated_as_text():
    sql, binds = template.render(
        "SELECT * FROM t WHERE name = {{undeclared}}",
        [],
        {"undeclared": "hello"},
    )
    assert ":undeclared" in sql
    assert binds == {"undeclared": "hello"}


def test_relative_date_tokens():
    from datetime import date, timedelta

    _, binds = template.render(
        "SELECT {{d}}",
        [template.ParameterSpec(name="d", type="date")],
        {"d": "today"},
    )
    assert binds == {"d": date.today()}

    _, binds = template.render(
        "SELECT {{d}}",
        [template.ParameterSpec(name="d", type="date")],
        {"d": "7d"},
    )
    assert binds == {"d": date.today() - timedelta(days=7)}

    _, binds = template.render(
        "SELECT {{d}}",
        [template.ParameterSpec(name="d", type="date")],
        {"d": "relative:this_month"},
    )
    assert binds == {"d": date.today().replace(day=1)}


def test_date_bind_is_a_date_object_not_a_string():
    """asyncpg rejects ISO strings for timestamp binds; we must pass
    datetime.date (or datetime) so CAST(:start_date AS timestamp) works."""
    from datetime import date

    _, binds = template.render(
        "SELECT CAST({{start_date}} AS timestamp)",
        [template.ParameterSpec(name="start_date", type="date")],
        {"start_date": "2026-01-01"},
    )
    assert binds == {"start_date": date(2026, 1, 1)}
    assert not isinstance(binds["start_date"], str)


def test_date_named_text_param_still_binds_a_date():
    """Auto-detected {{start_date}} defaults to type=text. ISO values
    still have to be date objects or Postgres/asyncpg raises DataError."""
    from datetime import date

    _, binds = template.render(
        "SELECT {{start_date}}, {{end_date}}",
        [
            template.ParameterSpec(name="start_date", type="text"),
            template.ParameterSpec(name="end_date", type="text"),
        ],
        {"start_date": "2026-01-01", "end_date": None},
    )
    assert binds["start_date"] == date(2026, 1, 1)
    assert binds["end_date"] is None


def test_unset_date_binds_null():
    sql, binds = template.render(
        "SELECT COALESCE({{end_date}}, 1)",
        [template.ParameterSpec(name="end_date", type="date")],
        {},
    )
    assert ":end_date" in sql
    assert binds == {"end_date": None}


def test_invalid_date_raises():
    with pytest.raises(template.TemplateError) as exc:
        template.render(
            "SELECT {{d}}",
            [template.ParameterSpec(name="d", type="date")],
            {"d": "not-a-date"},
        )
    assert "date" in str(exc.value)


def test_field_filter_equals():
    sql, binds = template.render(
        "SELECT * FROM t WHERE {{cat}}",
        [template.ParameterSpec(name="cat", type="field", target="category")],
        {"cat": "Doohickey"},
    )
    assert sql == "SELECT * FROM t WHERE category = :cat"
    assert binds == {"cat": "Doohickey"}


def test_field_filter_unset_becomes_true():
    sql, binds = template.render(
        "SELECT * FROM t WHERE {{cat}}",
        [template.ParameterSpec(name="cat", type="field", target="products.category")],
        {},
    )
    assert sql == "SELECT * FROM t WHERE 1=1"
    assert binds == {}


def test_field_filter_in_list():
    sql, binds = template.render(
        "SELECT * FROM t WHERE {{cat}}",
        [template.ParameterSpec(name="cat", type="field", target="category")],
        {"cat": ["A", "B"]},
    )
    assert "category IN (:cat__0, :cat__1)" in sql
    assert binds == {"cat__0": "A", "cat__1": "B"}


def test_field_filter_date_range():
    from datetime import date

    sql, binds = template.render(
        "SELECT * FROM t WHERE {{created}}",
        [
            template.ParameterSpec(
                name="created",
                type="field",
                target="hex.stakes.created_at",
                widget="daterange",
            )
        ],
        {"created": {"start": "2026-01-01", "end": "2026-01-31"}},
    )
    assert sql == (
        "SELECT * FROM t WHERE "
        "(hex.stakes.created_at >= :created__start AND hex.stakes.created_at < :created__end)"
    )
    assert binds == {
        "created__start": date(2026, 1, 1),
        "created__end": date(2026, 2, 1),  # exclusive
    }


def test_field_filter_date_range_tilde_and_open_end():
    from datetime import date

    sql, binds = template.render(
        "SELECT * FROM t WHERE {{created}}",
        [
            template.ParameterSpec(
                name="created", type="field", target="created_at", widget="daterange"
            )
        ],
        {"created": "2026-01-01~"},
    )
    assert sql == "SELECT * FROM t WHERE created_at >= :created__start"
    assert binds == {"created__start": date(2026, 1, 1)}


def test_field_filter_relative_this_month():
    from datetime import date

    sql, binds = template.render(
        "SELECT * FROM t WHERE {{created}}",
        [
            template.ParameterSpec(
                name="created", type="field", target="created_at", widget="daterange"
            )
        ],
        {"created": "this_month"},
    )
    start = date.today().replace(day=1)
    month = start.month + 1
    year = start.year + (1 if month == 13 else 0)
    month = 1 if month == 13 else month
    end = date(year, month, 1)
    assert "created_at >= :created__start" in sql
    assert "created_at < :created__end" in sql
    assert binds == {"created__start": start, "created__end": end}


def test_field_filter_quoted_and_dotted_target():
    sql, binds = template.render(
        "SELECT * FROM t WHERE {{x}}",
        [
            template.ParameterSpec(
                name="x",
                type="field",
                target='"hex"."stakes"."created_at"',
                widget="date",
            )
        ],
        {"x": "2026-01-15"},
    )
    assert '"hex"."stakes"."created_at" >= :x__start' in sql
    assert binds["x__start"].isoformat() == "2026-01-15"
    assert binds["x__end"].isoformat() == "2026-01-16"


def test_field_filter_rejects_injection_in_target():
    with pytest.raises(template.TemplateError) as exc:
        template.render(
            "SELECT * FROM t WHERE {{x}}",
            [
                template.ParameterSpec(
                    name="x",
                    type="field",
                    target="created_at; DROP TABLE stakes",
                )
            ],
            {"x": "1"},
        )
    assert "Invalid field filter column" in str(exc.value)


def test_field_filter_required_missing_raises():
    with pytest.raises(template.TemplateError):
        template.render(
            "SELECT * FROM t WHERE {{x}}",
            [template.ParameterSpec(name="x", type="field", target="c", required=True)],
            {},
        )


def test_field_filter_missing_target_raises_when_set():
    with pytest.raises(template.TemplateError) as exc:
        template.render(
            "SELECT * FROM t WHERE {{x}}",
            [template.ParameterSpec(name="x", type="field")],
            {"x": "hi"},
        )
    assert "mapped column" in str(exc.value)


def test_optional_field_filter_dropped_when_unset():
    sql, binds = template.render(
        "SELECT * FROM t WHERE 1=1 [[ AND {{cat}} ]]",
        [template.ParameterSpec(name="cat", type="field", target="category")],
        {},
    )
    assert "AND" not in sql
    assert binds == {}


def test_target_on_date_spec_is_a_field_filter():
    from datetime import date

    sql, binds = template.render(
        "SELECT * FROM t WHERE {{created}}",
        [
            template.ParameterSpec(
                name="created",
                type="date",
                target="orders.created_at",
                widget="daterange",
            )
        ],
        {"created": {"start": "2024-06-01", "end": "2024-06-30"}},
    )
    assert "orders.created_at >= :created__start" in sql
    assert binds["created__start"] == date(2024, 6, 1)
    assert binds["created__end"] == date(2024, 7, 1)


def test_coerce_values_field_filter_range():
    from datetime import date

    out = template.coerce_values(
        [
            template.ParameterSpec(
                name="created", type="field", widget="daterange", target="c"
            )
        ],
        {"created": "this_year"},
    )
    assert out["created"]["start"] == date.today().replace(month=1, day=1)


def test_coerce_values_drops_blanks_and_keeps_typed():
    out = template.coerce_values(
        [
            template.ParameterSpec(name="n", type="number"),
            template.ParameterSpec(name="s", type="text"),
        ],
        {"n": "3", "s": ""},
    )
    assert out == {"n": 3}
