"""
Bokeh chart renderer.

Interactive visualization using Bokeh.
Best for dashboards with linked brushing.
"""

from typing import Any

import pandas as pd
from bokeh.embed import components, file_html
from bokeh.models import ColumnDataSource, HoverTool
from bokeh.plotting import figure
from bokeh.resources import CDN
from bokeh.palettes import Category10

from crunch.visualization.base import ChartConfig, ChartRenderer, RenderResult


class BokehRenderer(ChartRenderer):
    """
    Renderer using Bokeh for interactive visualizations.
    
    Bokeh provides interactive plots with linked brushing,
    ideal for dashboard applications.
    """

    @property
    def name(self) -> str:
        return "bokeh"

    @property
    def supported_chart_types(self) -> list[str]:
        return [
            "line", "bar", "scatter", "area",
            "histogram", "box",
            "heatmap",
            "candlestick", "ohlc",
            "gauge", "table",
        ]

    def render(self, data: pd.DataFrame, config: ChartConfig) -> RenderResult:
        """Render a Bokeh chart."""
        try:
            p = self._create_figure(data, config)
            
            # Apply common settings
            self._apply_styling(p, config)
            
            # Convert to HTML
            html = file_html(p, CDN, config.title or "Chart")
            
            # Get components for embedding
            script, div = components(p)
            
            return RenderResult(
                success=True,
                html=div,
                script=script,
            )
            
        except Exception as e:
            return RenderResult(
                success=False,
                error=str(e),
            )

    def render_to_html(
        self, data: pd.DataFrame, config: ChartConfig, options: dict | None = None
    ) -> str:
        """Render directly to HTML string."""
        if options:
            for key, value in options.items():
                config.options[key] = value
        try:
            p = self._create_figure(data, config)
            self._apply_styling(p, config)
            return file_html(p, CDN, config.title or "Chart")
        except Exception as e:
            return f"<div class='error'>Error: {e}</div>"

    def _create_figure(self, data: pd.DataFrame, config: ChartConfig) -> figure:
        """Create the appropriate Bokeh figure."""
        chart_type = config.chart_type
        
        # Set figure size
        width = config.width or 800
        height = config.height or 500
        
        p = figure(
            width=width,
            height=height,
            title=config.title or "",
            tools="pan,box_zoom,wheel_zoom,reset,save",
        )
        
        source = ColumnDataSource(data)
        
        if chart_type == "line":
            self._line_chart(p, source, config)
        elif chart_type == "bar":
            self._bar_chart(p, data, config)
        elif chart_type == "scatter":
            self._scatter_chart(p, source, config)
        elif chart_type == "area":
            self._area_chart(p, source, config)
        elif chart_type == "histogram":
            self._histogram_chart(p, data, config)
        elif chart_type == "box":
            self._box_chart(p, data, config)
        elif chart_type == "candlestick":
            self._candlestick_chart(p, source, config)
        else:
            raise ValueError(f"Unsupported chart type: {chart_type}")
        
        return p

    def _apply_styling(self, p: figure, config: ChartConfig) -> None:
        """Apply common styling."""
        if config.x_label:
            p.xaxis.axis_label = config.x_label
        if config.y_label:
            p.yaxis.axis_label = config.y_label
        
        # Add hover tool
        hover = HoverTool(tooltips=[("Value", "@y")])
        p.add_tools(hover)

    def _line_chart(
        self, p: figure, source: ColumnDataSource, config: ChartConfig
    ) -> None:
        p.line(x=config.x, y=config.y, source=source, line_width=2)
        p.circle(x=config.x, y=config.y, source=source, size=5)

    def _bar_chart(
        self, p: figure, data: pd.DataFrame, config: ChartConfig
    ) -> None:
        x_values = data[config.x].astype(str).tolist()
        y_values = data[config.y].tolist()
        
        p.vbar(x=x_values, top=y_values, width=0.7)
        p.xgrid.grid_line_color = None
        p.x_range.range_padding = 0.1

    def _scatter_chart(
        self, p: figure, source: ColumnDataSource, config: ChartConfig
    ) -> None:
        size = config.size or 10
        p.circle(x=config.x, y=config.y, source=source, size=size)

    def _area_chart(
        self, p: figure, source: ColumnDataSource, config: ChartConfig
    ) -> None:
        p.varea(x=config.x, y1=0, y2=config.y, source=source, alpha=0.5)
        p.line(x=config.x, y=config.y, source=source, line_width=2)

    def _histogram_chart(
        self, p: figure, data: pd.DataFrame, config: ChartConfig
    ) -> None:
        import numpy as np
        
        bins = config.options.get("bins", 30)
        hist, edges = np.histogram(data[config.x], bins=bins)
        
        p.quad(
            top=hist,
            bottom=0,
            left=edges[:-1],
            right=edges[1:],
            fill_alpha=0.7,
            line_color="white",
        )

    def _box_chart(
        self, p: figure, data: pd.DataFrame, config: ChartConfig
    ) -> None:
        # Calculate box plot statistics
        q1 = data[config.y].quantile(0.25)
        q2 = data[config.y].quantile(0.5)
        q3 = data[config.y].quantile(0.75)
        iqr = q3 - q1
        lower = max(data[config.y].min(), q1 - 1.5 * iqr)
        upper = min(data[config.y].max(), q3 + 1.5 * iqr)
        
        # Draw box
        p.vbar(x=[0], width=0.7, bottom=[q1], top=[q3], fill_alpha=0.5)
        
        # Draw median line
        p.segment(x0=[-0.35], y0=[q2], x1=[0.35], y1=[q2], line_width=2)
        
        # Draw whiskers
        p.segment(x0=[0], y0=[lower], x1=[0], y1=[q1], line_width=2)
        p.segment(x0=[0], y0=[q3], x1=[0], y1=[upper], line_width=2)

    def _candlestick_chart(
        self, p: figure, source: ColumnDataSource, config: ChartConfig
    ) -> None:
        # Get OHLC data
        data = source.data
        
        inc = [c >= o for o, c in zip(data[config.open], data[config.close])]
        dec = [c < o for o, c in zip(data[config.open], data[config.close])]
        
        w = 0.5  # Width of candles
        
        # Draw candle bodies
        p.segment(
            x0=config.x, y0=config.high,
            x1=config.x, y1=config.low,
            source=source, color="black"
        )
        
        p.vbar(
            x=config.x, width=w,
            top=config.open, bottom=config.close,
            source=source,
            fill_color="green", line_color="black"
        )

