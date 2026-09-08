"""
Theme tokens for chart authors.

Crunch has a light and a dark theme and the user flips between them at will.
Anything a figure leaves unset is themed automatically by the client. These
helpers cover the other case — a colour the author *does* want to pin, but
which still has to change with the theme.

A token is just a string in a colour slot; the client resolves it at paint
time, so one saved figure serves both themes with no re-render:

    fig.update_traces(marker_color="$accent")          # app accent, per theme
    fig.add_annotation(font_color=theme_color("#b4552f", "#e08a63"))
    fig.update_layout(**theme_palette(
        light={"ehex": "#b4552f", "phex": "#6b4fa0"},
        dark={"ehex": "#e08a63", "phex": "#c8a2d4"},
    ))
    fig.add_trace(go.Scatter(..., line=dict(color="$ehex")))

Built-in names: fg, fg-muted, fg-subtle, bg, bg-elev, bg-elev-2, border,
border-strong, grid, accent, success, warn, error, info, positive, negative,
and series0 … series7 (the categorical palette, in order). Underscores work
too, so ``$fg_muted`` is the same as ``$fg-muted``.
"""

from __future__ import annotations

from typing import Any

#: Names the client resolves without any figure-level declaration.
BUILTIN_TOKENS = (
    "fg",
    "fg-muted",
    "fg-subtle",
    "bg",
    "bg-elev",
    "bg-elev-2",
    "border",
    "border-strong",
    "grid",
    "accent",
    "success",
    "warn",
    "error",
    "info",
    "positive",
    "negative",
    *(f"series{i}" for i in range(8)),
)


def theme_color(light: str, dark: str) -> str:
    """Pin a colour that differs per theme.

    Returns a token string usable in any Plotly colour slot::

        line=dict(color=theme_color("#b4552f", "#e08a63"))

    Pick a value that reads on *that* theme's background — the point is that
    they differ. A single shade that survives both is usually the washed-out
    compromise you were trying to avoid.
    """
    return f"$(light: {light}, dark: {dark})"


def theme_palette(
    light: dict[str, str] | None = None,
    dark: dict[str, str] | None = None,
    both: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Declare named two-theme colours on the figure itself.

    Returns kwargs for ``fig.update_layout``; the names are then usable as
    ``$name`` tokens anywhere in the figure::

        fig.update_layout(**theme_palette(
            light={"ehex": "#b4552f"},
            dark={"ehex": "#e08a63"},
            both={"muted": "#9aa0a6"},
        ))
        fig.add_trace(go.Bar(..., marker_color="$ehex"))

    Names declared here shadow the built-ins, so a chart can rebind
    ``$accent`` to its own brand colour without touching the app theme.
    ``both`` holds names that don't vary; the active theme's block wins.
    """
    palette: dict[str, dict[str, str]] = {}
    if both:
        palette["both"] = dict(both)
    if light:
        palette["light"] = dict(light)
    if dark:
        palette["dark"] = dict(dark)
    return {"meta": {"crunch_theme": palette}}


def is_token(value: Any) -> bool:
    """True for a theme token string — ``$name`` or ``$(light: …, dark: …)``."""
    return isinstance(value, str) and value.startswith("$")


_validator_patched = False


def install_token_validator() -> None:
    """Teach plotly.py that a ``$token`` is a valid colour.

    plotly.py type-checks colours the moment they're assigned, so
    ``marker_color="$accent"`` raises before the figure ever reaches the
    client that would resolve it. Every colour slot in the library — scalar,
    array, and colorlist alike — funnels through
    ``ColorValidator.perform_validate_coerce``, so one wrapper there makes
    tokens first-class everywhere without touching the call sites.

    Non-token values fall through to the original validator untouched, so a
    genuine typo like ``color="#gggggg"`` still fails loudly.
    """
    global _validator_patched
    if _validator_patched:
        return

    from _plotly_utils.basevalidators import ColorValidator

    original = ColorValidator.__dict__["perform_validate_coerce"].__func__

    def perform_validate_coerce(v, allow_number=None):
        if is_token(v):
            return v
        return original(v, allow_number=allow_number)

    ColorValidator.perform_validate_coerce = staticmethod(perform_validate_coerce)
    _validator_patched = True


def sandbox_namespace() -> dict[str, Any]:
    """The helpers exposed to sandboxed user/agent code, import-free."""
    install_token_validator()
    return {
        "theme_color": theme_color,
        "theme_palette": theme_palette,
        "THEME_TOKENS": list(BUILTIN_TOKENS),
    }
