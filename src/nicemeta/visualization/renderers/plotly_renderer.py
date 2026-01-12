"""
Plotly chart renderer.

Primary renderer for interactive web visualizations.
Supports the widest range of chart types.
"""

import json
from typing import Any

import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
from plotly.subplots import make_subplots

from nicemeta.visualization.base import ChartConfig, ChartRenderer, RenderResult


class PlotlyRenderer(ChartRenderer):
    """
    Renderer using Plotly for interactive web charts.
    
    Plotly is the primary renderer due to its excellent web integration
    and wide range of supported chart types.
    """

    @property
    def name(self) -> str:
        return "plotly"

    @property
    def supported_chart_types(self) -> list[str]:
        return [
            "line", "bar", "scatter", "area",
            "pie", "donut", "treemap", "sunburst",
            "histogram", "box", "violin",
            "heatmap", "contour",
            "funnel", "waterfall", "sankey",
            "candlestick", "ohlc",
            "choropleth", "scatter_geo",
            "scatter_3d", "surface_3d", "line_3d",
            "gauge", "indicator", "table",
            "radar", "parallel_coordinates",
            "strip", "correlation", "pairplot",
        ]

    def render(self, data: pd.DataFrame, config: ChartConfig) -> RenderResult:
        """Render a Plotly chart."""
        try:
            fig = self._create_figure(data, config)
            
            # Apply layout settings
            self._apply_layout(fig, config)
            
            # Convert to HTML
            html = fig.to_html(
                include_plotlyjs="cdn",
                full_html=False,
                config={"responsive": True},
            )
            
            # Get JSON data for potential API use
            json_data = json.loads(fig.to_json())
            
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

    def render_to_html(
        self, data: pd.DataFrame, config: ChartConfig, options: dict | None = None
    ) -> str:
        """Render directly to HTML string with optional advanced options."""
        # Merge options into config
        if options:
            for key, value in options.items():
                config.options[key] = value
        
        result = self.render(data, config)
        if result.success:
            return result.html or ""
        return f"<div class='error'>Error: {result.error}</div>"

    def render_figure(
        self, data: pd.DataFrame, config: ChartConfig, options: dict | None = None
    ) -> go.Figure | None:
        """Render and return the Plotly figure object directly.
        
        This is useful for NiceGUI's ui.plotly() component.
        
        Args:
            data: DataFrame containing chart data
            config: Chart configuration
            options: Optional additional chart options
            
        Returns:
            Plotly Figure object or None on error
        """
        # Merge options into config
        if options:
            for key, value in options.items():
                config.options[key] = value
        
        # Auto-detect columns if not specified
        if data is not None and len(data.columns) > 0:
            columns = list(data.columns)
            numeric_cols = data.select_dtypes(include=['number']).columns.tolist()
            non_numeric_cols = [c for c in columns if c not in numeric_cols]
            
            # Set defaults for x/y if not specified
            if not config.x:
                config.x = non_numeric_cols[0] if non_numeric_cols else columns[0]
            if not config.y:
                config.y = numeric_cols[0] if numeric_cols else (columns[1] if len(columns) > 1 else columns[0])
            # Set defaults for pie/donut charts
            if not config.labels:
                config.labels = non_numeric_cols[0] if non_numeric_cols else columns[0]
            if not config.values:
                config.values = numeric_cols[0] if numeric_cols else (columns[1] if len(columns) > 1 else columns[0])
        
        try:
            fig = self._create_figure(data, config)
            self._apply_layout(fig, config)
            return fig
        except Exception:
            return None

    def _create_figure(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        """Create the appropriate Plotly figure based on chart type."""
        chart_type = config.chart_type
        
        # Basic charts
        if chart_type == "line":
            return self._line_chart(data, config)
        elif chart_type == "bar":
            return self._bar_chart(data, config)
        elif chart_type == "scatter":
            return self._scatter_chart(data, config)
        elif chart_type == "area":
            return self._area_chart(data, config)
        
        # Part-to-whole
        elif chart_type == "pie":
            return self._pie_chart(data, config)
        elif chart_type == "donut":
            return self._donut_chart(data, config)
        elif chart_type == "treemap":
            return self._treemap_chart(data, config)
        elif chart_type == "sunburst":
            return self._sunburst_chart(data, config)
        
        # Distribution
        elif chart_type == "histogram":
            return self._histogram_chart(data, config)
        elif chart_type == "box":
            return self._box_chart(data, config)
        elif chart_type == "violin":
            return self._violin_chart(data, config)
        elif chart_type == "strip":
            return self._strip_chart(data, config)
        
        # Correlation
        elif chart_type == "heatmap":
            return self._heatmap_chart(data, config)
        elif chart_type == "correlation":
            return self._correlation_chart(data, config)
        elif chart_type == "contour":
            return self._contour_chart(data, config)
        
        # Flow
        elif chart_type == "funnel":
            return self._funnel_chart(data, config)
        elif chart_type == "waterfall":
            return self._waterfall_chart(data, config)
        elif chart_type == "sankey":
            return self._sankey_chart(data, config)
        
        # Financial
        elif chart_type == "candlestick":
            return self._candlestick_chart(data, config)
        elif chart_type == "ohlc":
            return self._ohlc_chart(data, config)
        
        # Geo
        elif chart_type == "choropleth":
            return self._choropleth_chart(data, config)
        elif chart_type == "scatter_geo":
            return self._scatter_geo_chart(data, config)
        
        # 3D
        elif chart_type == "scatter_3d":
            return self._scatter_3d_chart(data, config)
        elif chart_type == "surface_3d":
            return self._surface_3d_chart(data, config)
        elif chart_type == "line_3d":
            return self._line_3d_chart(data, config)
        
        # Other
        elif chart_type == "gauge":
            return self._gauge_chart(data, config)
        elif chart_type == "indicator":
            return self._indicator_chart(data, config)
        elif chart_type == "table":
            return self._table_chart(data, config)
        elif chart_type == "radar":
            return self._radar_chart(data, config)
        elif chart_type == "parallel_coordinates":
            return self._parallel_coordinates_chart(data, config)
        
        else:
            raise ValueError(f"Unsupported chart type: {chart_type}")

    def _apply_layout(self, fig: go.Figure, config: ChartConfig) -> None:
        """Apply common layout settings."""
        layout_updates = {
            "title": config.title or None,
            "template": config.template or "plotly_white",
        }
        
        # Axis labels from config or options
        x_label = config.x_label or config.options.get("x_label", "")
        y_label = config.y_label or config.options.get("y_label", "")
        
        if x_label:
            layout_updates["xaxis_title"] = x_label
        if y_label:
            layout_updates["yaxis_title"] = y_label
        if config.width:
            layout_updates["width"] = config.width
        if config.height:
            layout_updates["height"] = config.height
        
        # Legend visibility
        if not config.options.get("show_legend", True):
            layout_updates["showlegend"] = False
            
        fig.update_layout(**layout_updates)
        
        # Show values on chart if requested
        if config.options.get("show_values", False):
            fig.update_traces(textposition="outside", texttemplate="%{y}")

    def _get_color_palette(self, config: ChartConfig) -> list:
        """Get the color palette based on config options."""
        palette_name = config.options.get("color_palette", "plotly")
        palettes = {
            "plotly": px.colors.qualitative.Plotly,
            "viridis": px.colors.sequential.Viridis,
            "plasma": px.colors.sequential.Plasma,
            "inferno": px.colors.sequential.Inferno,
            "blues": px.colors.sequential.Blues,
            "reds": px.colors.sequential.Reds,
            "greens": px.colors.sequential.Greens,
            "set2": px.colors.qualitative.Set2,
            "pastel": px.colors.qualitative.Pastel,
            "dark24": px.colors.qualitative.Dark24,
        }
        return palettes.get(palette_name, px.colors.qualitative.Plotly)

    # Chart creation methods
    def _line_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        colors = self._get_color_palette(config)
        line_shape = "linear"
        
        # Line style mapping
        line_style = config.options.get("line_style", "solid")
        dash_map = {"solid": None, "dash": "dash", "dot": "dot", "dashdot": "dashdot"}
        
        fig = px.line(
            data, x=config.x, y=config.y,
            color=config.color,
            color_discrete_sequence=colors,
            markers=config.options.get("show_markers", False),
        )
        
        # Apply line dash style
        if line_style != "solid":
            fig.update_traces(line=dict(dash=dash_map.get(line_style)))
        
        return fig

    def _bar_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        orientation = config.options.get("orientation", "v")
        bar_mode = config.options.get("bar_mode", "group")
        colors = self._get_color_palette(config)
        
        # Swap x/y for horizontal
        x_col = config.x
        y_col = config.y
        if orientation == "h":
            x_col, y_col = config.y, config.x
        
        fig = px.bar(
            data, x=x_col, y=y_col,
            color=config.color,
            orientation=orientation,
            color_discrete_sequence=colors,
            barmode=bar_mode,
            text_auto=config.options.get("show_values", False),
        )
        
        return fig

    def _scatter_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        return px.scatter(
            data, x=config.x, y=config.y,
            color=config.color,
            size=config.size,
            color_discrete_sequence=px.colors.qualitative.Set2,
        )

    def _area_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        return px.area(
            data, x=config.x, y=config.y,
            color=config.color,
            color_discrete_sequence=px.colors.qualitative.Set2,
        )

    def _pie_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        colors = self._get_color_palette(config)
        show_percent = config.options.get("show_percent", True)
        
        fig = px.pie(
            data,
            values=config.values,
            names=config.labels,
            color_discrete_sequence=colors,
        )
        
        if show_percent:
            fig.update_traces(textinfo="percent+label")
        else:
            fig.update_traces(textinfo="label+value")
        
        return fig

    def _donut_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        colors = self._get_color_palette(config)
        show_percent = config.options.get("show_percent", True)
        
        fig = px.pie(
            data,
            values=config.values,
            names=config.labels,
            hole=0.4,
            color_discrete_sequence=colors,
        )
        
        if show_percent:
            fig.update_traces(textinfo="percent+label")
        else:
            fig.update_traces(textinfo="label+value")
        
        return fig

    def _treemap_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        path = [config.labels] if config.labels else []
        if config.parents:
            path = [config.parents, config.labels]
        return px.treemap(
            data,
            path=path,
            values=config.values,
            color=config.color,
        )

    def _sunburst_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        path = [config.labels] if config.labels else []
        if config.parents:
            path = [config.parents, config.labels]
        return px.sunburst(
            data,
            path=path,
            values=config.values,
        )

    def _histogram_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        nbins = config.options.get("bins")
        return px.histogram(
            data, x=config.x,
            color=config.color,
            nbins=nbins,
            color_discrete_sequence=px.colors.qualitative.Set2,
        )

    def _box_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        return px.box(
            data, x=config.x, y=config.y,
            color=config.color,
            color_discrete_sequence=px.colors.qualitative.Set2,
        )

    def _violin_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        return px.violin(
            data, x=config.x, y=config.y,
            color=config.color,
            color_discrete_sequence=px.colors.qualitative.Set2,
        )

    def _strip_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        return px.strip(
            data, x=config.x, y=config.y,
            color=config.color,
            color_discrete_sequence=px.colors.qualitative.Set2,
        )

    def _heatmap_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        if config.z:
            # Pivot data if x, y, z provided
            pivot = data.pivot(index=config.y, columns=config.x, values=config.z)
            return px.imshow(pivot, color_continuous_scale=config.color_scheme or "Viridis")
        return px.imshow(data, color_continuous_scale=config.color_scheme or "Viridis")

    def _correlation_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        numeric_data = data.select_dtypes(include=["number"])
        corr_matrix = numeric_data.corr()
        return px.imshow(
            corr_matrix,
            color_continuous_scale="RdBu_r",
            aspect="auto",
            text_auto=".2f",
        )

    def _contour_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        return px.density_contour(
            data, x=config.x, y=config.y,
            color=config.color,
        )

    def _funnel_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        return px.funnel(
            data,
            x=config.values,
            y=config.labels,
            color_discrete_sequence=px.colors.qualitative.Set2,
        )

    def _waterfall_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        measure = config.options.get("measure", ["relative"] * len(data))
        fig = go.Figure(go.Waterfall(
            x=data[config.x] if config.x else data.index,
            y=data[config.y] if config.y else data.iloc[:, 0],
            measure=measure,
        ))
        return fig

    def _sankey_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        fig = go.Figure(go.Sankey(
            node=dict(
                label=config.options.get("labels", []),
            ),
            link=dict(
                source=data[config.source].tolist() if config.source else [],
                target=data[config.target].tolist() if config.target else [],
                value=data[config.values].tolist() if config.values else [],
            ),
        ))
        return fig

    def _candlestick_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        fig = go.Figure(go.Candlestick(
            x=data[config.x] if config.x else data.index,
            open=data[config.open] if config.open else None,
            high=data[config.high] if config.high else None,
            low=data[config.low] if config.low else None,
            close=data[config.close] if config.close else None,
        ))
        return fig

    def _ohlc_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        fig = go.Figure(go.Ohlc(
            x=data[config.x] if config.x else data.index,
            open=data[config.open] if config.open else None,
            high=data[config.high] if config.high else None,
            low=data[config.low] if config.low else None,
            close=data[config.close] if config.close else None,
        ))
        return fig

    def _choropleth_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        return px.choropleth(
            data,
            locations=config.locations,
            color=config.values,
            color_continuous_scale=config.color_scheme or "Viridis",
        )

    def _scatter_geo_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        return px.scatter_geo(
            data,
            lat=config.lat,
            lon=config.lon,
            color=config.color,
            size=config.size,
        )

    def _scatter_3d_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        return px.scatter_3d(
            data, x=config.x, y=config.y, z=config.z,
            color=config.color,
            size=config.size,
        )

    def _surface_3d_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        if config.z:
            z_data = data.pivot(index=config.y, columns=config.x, values=config.z).values
        else:
            z_data = data.values
        fig = go.Figure(go.Surface(z=z_data, colorscale=config.color_scheme or "Viridis"))
        return fig

    def _line_3d_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        return px.line_3d(
            data, x=config.x, y=config.y, z=config.z,
            color=config.color,
        )

    def _gauge_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        value = data[config.values].iloc[0] if config.values else data.iloc[0, 0]
        fig = go.Figure(go.Indicator(
            mode="gauge+number",
            value=value,
            gauge={
                "axis": {
                    "range": [
                        config.options.get("min", 0),
                        config.options.get("max", 100)
                    ]
                },
            },
        ))
        return fig

    def _indicator_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        value = data[config.values].iloc[0] if config.values else data.iloc[0, 0]
        mode = "number"
        if config.options.get("delta"):
            mode += "+delta"
        fig = go.Figure(go.Indicator(
            mode=mode,
            value=value,
            delta={"reference": config.options.get("reference")},
        ))
        return fig

    def _table_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        fig = go.Figure(go.Table(
            header=dict(values=list(data.columns)),
            cells=dict(values=[data[col] for col in data.columns]),
        ))
        return fig

    def _radar_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        categories = data[config.options.get("categories", data.columns[0])].tolist()
        values = data[config.values].tolist() if config.values else data.iloc[:, 1].tolist()
        
        fig = go.Figure(go.Scatterpolar(
            r=values,
            theta=categories,
            fill="toself",
        ))
        return fig

    def _parallel_coordinates_chart(self, data: pd.DataFrame, config: ChartConfig) -> go.Figure:
        dimensions = config.options.get("dimensions", list(data.select_dtypes(include=["number"]).columns))
        return px.parallel_coordinates(
            data,
            dimensions=dimensions,
            color=config.color,
        )

