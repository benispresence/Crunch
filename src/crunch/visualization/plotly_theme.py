"""
Theme-neutral Plotly template.

The SPA re-themes every figure on the client (see
``frontend/src/composables/chartTheme.ts``): it layers a template built from
the live CSS custom properties over whatever the engine produced, so charts
follow the light/dark toggle instantly without a re-render round-trip.

That only works if the engine stays out of the way. A figure carrying
``plotly_white`` ships an opaque white canvas and dark tick labels baked into
its template; ``plotly_dark`` ships the mirror image. Either one fights the
client theme in one of the two modes.

So the engine defaults to this template instead: transparent backgrounds, no
hardcoded text colours, and the Crunch categorical palette. Rendered
standalone (HTML export, NiceGUI) it still looks correct on any background;
rendered in the SPA the client supplies the rest.
"""

from __future__ import annotations

import plotly.graph_objects as go
import plotly.io as pio

TEMPLATE_NAME = "crunch"

# Mid-tone hues only, so the same eight series read on both the near-black
# and near-white canvas. Kept in sync with COLORWAY in chartTheme.ts.
COLORWAY = [
    "#d97757",  # accent (clay)
    "#7aa2c8",  # info
    "#7fb069",  # success
    "#e8b04c",  # warn
    "#c8a2d4",
    "#6fb3ab",
    "#cf7d94",
    "#8f9bb3",
]


def build_template() -> go.layout.Template:
    """Build the neutral template. Deliberately sets no font/grid colours."""
    return go.layout.Template(
        layout=go.Layout(
            paper_bgcolor="rgba(0,0,0,0)",
            plot_bgcolor="rgba(0,0,0,0)",
            colorway=COLORWAY,
            font=dict(family="Inter, sans-serif", size=11),
            margin=dict(t=32, r=16, b=36, l=48),
            xaxis=dict(automargin=True, showline=False, zeroline=False),
            yaxis=dict(automargin=True, showline=False, zeroline=False),
            legend=dict(bgcolor="rgba(0,0,0,0)"),
            polar=dict(bgcolor="rgba(0,0,0,0)"),
            ternary=dict(bgcolor="rgba(0,0,0,0)"),
            geo=dict(bgcolor="rgba(0,0,0,0)"),
        ),
    )


def install(set_default: bool = True) -> None:
    """Register the template, and make it the process-wide default.

    Setting the default matters for sandboxed user/agent code: a bare
    ``px.bar(df, ...)`` then produces a theme-neutral figure with no effort
    from whoever wrote the snippet.
    """
    pio.templates[TEMPLATE_NAME] = build_template()
    if set_default:
        pio.templates.default = TEMPLATE_NAME
