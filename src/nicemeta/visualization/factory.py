"""
Chart factory for creating visualizations.

Uses Factory pattern to create appropriate renderers.
"""

from typing import Type

import pandas as pd

from nicemeta.visualization.base import ChartConfig, ChartRenderer, RenderResult
from nicemeta.visualization.chart_types import CHART_TYPES, get_chart_type
from nicemeta.visualization.renderers.altair_renderer import AltairRenderer
from nicemeta.visualization.renderers.bokeh_renderer import BokehRenderer
from nicemeta.visualization.renderers.matplotlib_renderer import MatplotlibRenderer
from nicemeta.visualization.renderers.plotly_renderer import PlotlyRenderer
from nicemeta.visualization.renderers.seaborn_renderer import SeabornRenderer


class ChartFactory:
    """
    Factory for creating chart visualizations.
    
    Manages renderer registration and selection based on
    chart type and user preference.
    """

    # Registry of available renderers
    _renderers: dict[str, Type[ChartRenderer]] = {
        "plotly": PlotlyRenderer,
        "matplotlib": MatplotlibRenderer,
        "seaborn": SeabornRenderer,
        "altair": AltairRenderer,
        "bokeh": BokehRenderer,
    }

    # Cached renderer instances
    _instances: dict[str, ChartRenderer] = {}

    @classmethod
    def get_available_renderers(cls) -> list[str]:
        """Get list of available renderer names."""
        return list(cls._renderers.keys())

    @classmethod
    def register_renderer(
        cls, name: str, renderer_class: Type[ChartRenderer]
    ) -> None:
        """
        Register a new renderer.
        
        Args:
            name: Renderer name
            renderer_class: Renderer class
        """
        cls._renderers[name] = renderer_class
        # Clear cached instance if exists
        if name in cls._instances:
            del cls._instances[name]

    @classmethod
    def get_renderer(cls, name: str) -> ChartRenderer:
        """
        Get a renderer instance by name.
        
        Uses cached instances for performance.
        
        Args:
            name: Renderer name
            
        Returns:
            ChartRenderer instance
            
        Raises:
            ValueError: If renderer not found
        """
        if name not in cls._renderers:
            raise ValueError(
                f"Unknown renderer: {name}. "
                f"Available: {', '.join(cls.get_available_renderers())}"
            )
        
        # Create instance if not cached
        if name not in cls._instances:
            cls._instances[name] = cls._renderers[name]()
        
        return cls._instances[name]

    @classmethod
    def get_best_renderer(cls, chart_type: str) -> ChartRenderer:
        """
        Get the best renderer for a chart type.
        
        Returns the default renderer specified in CHART_TYPES.
        
        Args:
            chart_type: Chart type ID
            
        Returns:
            ChartRenderer instance
        """
        chart_def = get_chart_type(chart_type)
        if chart_def:
            return cls.get_renderer(chart_def.default_renderer)
        
        # Default to Plotly if chart type not found
        return cls.get_renderer("plotly")

    @classmethod
    def get_renderers_for_chart(cls, chart_type: str) -> list[ChartRenderer]:
        """
        Get all renderers that support a chart type.
        
        Args:
            chart_type: Chart type ID
            
        Returns:
            List of supporting renderers
        """
        chart_def = get_chart_type(chart_type)
        if not chart_def:
            return [cls.get_renderer("plotly")]
        
        return [
            cls.get_renderer(name)
            for name in chart_def.supported_renderers
            if name in cls._renderers
        ]

    @classmethod
    def render(
        cls,
        data: pd.DataFrame,
        config: ChartConfig,
        renderer: str | None = None,
    ) -> RenderResult:
        """
        Render a chart with the specified or best renderer.
        
        Args:
            data: DataFrame containing chart data
            config: Chart configuration
            renderer: Optional renderer name. If None, uses best renderer.
            
        Returns:
            RenderResult with rendered chart
        """
        if renderer:
            r = cls.get_renderer(renderer)
        else:
            r = cls.get_best_renderer(config.chart_type)
        
        return r.render(data, config)

    @classmethod
    def render_to_html(
        cls,
        data: pd.DataFrame,
        config: ChartConfig,
        options: dict | None = None,
        renderer: str | None = None,
    ) -> str:
        """
        Render a chart directly to HTML.
        
        Args:
            data: DataFrame containing chart data
            config: Chart configuration
            options: Optional additional chart options
            renderer: Optional renderer name
            
        Returns:
            HTML string
        """
        if renderer:
            r = cls.get_renderer(renderer)
        else:
            r = cls.get_best_renderer(config.chart_type)
        
        return r.render_to_html(data, config, options)

    @classmethod
    def render_figure(
        cls,
        data: pd.DataFrame,
        config: ChartConfig,
        options: dict | None = None,
        renderer: str | None = None,
    ):
        """
        Render and return a Plotly figure object.
        
        This is useful for NiceGUI's ui.plotly() component.
        
        Args:
            data: DataFrame containing chart data
            config: Chart configuration
            options: Optional additional chart options
            renderer: Optional renderer name
            
        Returns:
            Plotly Figure object or None
        """
        if renderer:
            r = cls.get_renderer(renderer)
        else:
            r = cls.get_best_renderer(config.chart_type)
        
        # Check if renderer has render_figure method
        if hasattr(r, 'render_figure'):
            return r.render_figure(data, config, options)
        return None

    @classmethod
    def get_chart_types(cls, category: str | None = None) -> list[dict]:
        """
        Get all available chart types.
        
        Args:
            category: Optional category filter
            
        Returns:
            List of chart type info dictionaries
        """
        result = []
        for chart_id, chart_def in CHART_TYPES.items():
            if category and chart_def.category.value != category:
                continue
            
            result.append({
                "id": chart_def.id,
                "name": chart_def.name,
                "description": chart_def.description,
                "category": chart_def.category.value,
                "icon": chart_def.icon,
                "default_renderer": chart_def.default_renderer,
                "supported_renderers": chart_def.supported_renderers,
                "required_fields": chart_def.required_fields,
                "optional_fields": chart_def.optional_fields,
            })
        
        return result

    @classmethod
    def validate_config(
        cls, config: ChartConfig, renderer: str | None = None
    ) -> list[str]:
        """
        Validate a chart configuration.
        
        Args:
            config: Chart configuration to validate
            renderer: Optional specific renderer to validate against
            
        Returns:
            List of error messages (empty if valid)
        """
        errors = []
        
        # Check if chart type exists
        chart_def = get_chart_type(config.chart_type)
        if not chart_def:
            errors.append(f"Unknown chart type: {config.chart_type}")
            return errors
        
        # Get renderer
        if renderer:
            r = cls.get_renderer(renderer)
        else:
            r = cls.get_best_renderer(config.chart_type)
        
        # Validate with renderer
        errors.extend(r.validate_config(config))
        
        return errors

