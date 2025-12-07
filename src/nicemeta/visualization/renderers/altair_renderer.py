"""
Altair chart renderer.

Declarative statistical visualization using Vega-Lite.
Best for faceted charts and interactive selections.
"""

from typing import Any

import altair as alt
import pandas as pd

from nicemeta.visualization.base import ChartConfig, ChartRenderer, RenderResult


class AltairRenderer(ChartRenderer):
    """
    Renderer using Altair for declarative visualizations.
    
    Altair provides a declarative grammar for creating
    interactive visualizations based on Vega-Lite.
    """

    def __init__(self):
        """Initialize Altair settings."""
        # Enable Altair to handle larger datasets
        alt.data_transformers.disable_max_rows()

    @property
    def name(self) -> str:
        return "altair"

    @property
    def supported_chart_types(self) -> list[str]:
        return [
            "line", "bar", "scatter", "area",
            "pie", "histogram", "box",
            "heatmap", "treemap", "sunburst",
            "sankey", "choropleth",
            "parallel_coordinates",
        ]

    def render(self, data: pd.DataFrame, config: ChartConfig) -> RenderResult:
        """Render an Altair chart."""
        try:
            chart = self._create_chart(data, config)
            
            # Apply common settings
            chart = self._apply_styling(chart, config)
            
            # Convert to HTML
            html = chart.to_html()
            
            # Get JSON spec
            json_data = chart.to_dict()
            
            return RenderResult(
                success=True,
                html=html,
                json_data=json_data,
            )
            
        except Exception as e:
            return RenderResult(
                success=False,
                error=str(e),
            )

    def render_to_html(self, data: pd.DataFrame, config: ChartConfig) -> str:
        """Render directly to HTML string."""
        result = self.render(data, config)
        if result.success:
            return result.html or ""
        return f"<div class='error'>Error: {result.error}</div>"

    def _create_chart(self, data: pd.DataFrame, config: ChartConfig) -> alt.Chart:
        """Create the appropriate Altair chart."""
        chart_type = config.chart_type
        
        # Create base chart
        base = alt.Chart(data)
        
        if chart_type == "line":
            return self._line_chart(base, config)
        elif chart_type == "bar":
            return self._bar_chart(base, config)
        elif chart_type == "scatter":
            return self._scatter_chart(base, config)
        elif chart_type == "area":
            return self._area_chart(base, config)
        elif chart_type == "pie":
            return self._pie_chart(base, config)
        elif chart_type == "histogram":
            return self._histogram_chart(base, config)
        elif chart_type == "box":
            return self._box_chart(base, config)
        elif chart_type == "heatmap":
            return self._heatmap_chart(base, config)
        else:
            raise ValueError(f"Unsupported chart type: {chart_type}")

    def _apply_styling(self, chart: alt.Chart, config: ChartConfig) -> alt.Chart:
        """Apply common styling to chart."""
        properties = {}
        
        if config.width:
            properties["width"] = config.width
        if config.height:
            properties["height"] = config.height
        if config.title:
            properties["title"] = config.title
            
        if properties:
            chart = chart.properties(**properties)
        
        return chart.interactive()

    def _line_chart(self, base: alt.Chart, config: ChartConfig) -> alt.Chart:
        encoding = {
            "x": config.x,
            "y": config.y,
        }
        if config.color:
            encoding["color"] = config.color
            
        return base.mark_line().encode(**encoding)

    def _bar_chart(self, base: alt.Chart, config: ChartConfig) -> alt.Chart:
        encoding = {
            "x": config.x,
            "y": config.y,
        }
        if config.color:
            encoding["color"] = config.color
            
        return base.mark_bar().encode(**encoding)

    def _scatter_chart(self, base: alt.Chart, config: ChartConfig) -> alt.Chart:
        encoding = {
            "x": config.x,
            "y": config.y,
        }
        if config.color:
            encoding["color"] = config.color
        if config.size:
            encoding["size"] = config.size
            
        return base.mark_circle().encode(**encoding)

    def _area_chart(self, base: alt.Chart, config: ChartConfig) -> alt.Chart:
        encoding = {
            "x": config.x,
            "y": config.y,
        }
        if config.color:
            encoding["color"] = config.color
            
        return base.mark_area(opacity=0.7).encode(**encoding)

    def _pie_chart(self, base: alt.Chart, config: ChartConfig) -> alt.Chart:
        return base.mark_arc().encode(
            theta=config.values,
            color=config.labels,
        )

    def _histogram_chart(self, base: alt.Chart, config: ChartConfig) -> alt.Chart:
        bins = config.options.get("bins", 30)
        return base.mark_bar().encode(
            x=alt.X(config.x, bin=alt.Bin(maxbins=bins)),
            y="count()",
            color=config.color if config.color else alt.value("steelblue"),
        )

    def _box_chart(self, base: alt.Chart, config: ChartConfig) -> alt.Chart:
        encoding = {"y": config.y}
        if config.x:
            encoding["x"] = config.x
        if config.color:
            encoding["color"] = config.color
            
        return base.mark_boxplot().encode(**encoding)

    def _heatmap_chart(self, base: alt.Chart, config: ChartConfig) -> alt.Chart:
        return base.mark_rect().encode(
            x=config.x,
            y=config.y,
            color=alt.Color(config.z, scale=alt.Scale(scheme=config.color_scheme or "viridis")),
        )

