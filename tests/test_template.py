"""
Tests for the Metabase-style SQL template engine.
"""

import importlib.util
import sys
from pathlib import Path

import pytest


def _load_template_module():
    """Load template.py without dragging in the rest of nicemeta.query,
    which pulls pandas/sqlalchemy (heavy + not needed for these tests)."""
    path = Path(__file__).resolve().parent.parent / "src" / "nicemeta" / "query" / "template.py"
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
    assert binds == {"since": "2024-01-01"}


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


def test_coerce_values_drops_blanks_and_keeps_typed():
    out = template.coerce_values(
        [
            template.ParameterSpec(name="n", type="number"),
            template.ParameterSpec(name="s", type="text"),
        ],
        {"n": "3", "s": ""},
    )
    assert out == {"n": 3}
