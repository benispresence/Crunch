"""
Base chart renderer interface.

Defines the abstract interface for all visualization renderers.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

import pandas as pd


@dataclass
class ChartConfig:
    """
    Configuration for rendering a chart.
    
    Contains all settings needed to create a visualization.
    """
    
    # Chart type (line, bar, scatter, etc.)
    chart_type: str
    
    # Title and labels
    title: str = ""
    x_label: str = ""
    y_label: str = ""
    
    # Data column mappings
    x: str | None = None
    y: str | list[str] | None = None
    z: str | None = None
    color: str | None = None
    size: str | None = None
    labels: str | None = None
    values: str | None = None
    
    # For hierarchical charts
    parents: str | None = None
    
    # For flow charts
    source: str | None = None
    target: str | None = None
    
    # For financial charts
    open: str | None = None
    high: str | None = None
    low: str | None = None
    close: str | None = None
    
    # For geo charts
    lat: str | None = None
    lon: str | None = None
    locations: str | None = None
    
    # Styling
    color_scheme: str | None = None
    template: str | None = None
    
    # Dimensions
    width: int | None = None
    height: int | None = None
    
    # Additional options
    options: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        """Convert config to dictionary."""
        return {
            "chart_type": self.chart_type,
            "title": self.title,
            "x_label": self.x_label,
            "y_label": self.y_label,
            "x": self.x,
            "y": self.y,
            "z": self.z,
            "color": self.color,
            "size": self.size,
            "labels": self.labels,
            "values": self.values,
            "parents": self.parents,
            "source": self.source,
            "target": self.target,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "lat": self.lat,
            "lon": self.lon,
            "locations": self.locations,
            "color_scheme": self.color_scheme,
            "template": self.template,
            "width": self.width,
            "height": self.height,
            "options": self.options,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "ChartConfig":
        """Create config from dictionary."""
        return cls(**data)


@dataclass
class RenderResult:
    """Result of rendering a chart."""
    
    success: bool
    html: str | None = None  # HTML representation
    json_data: dict | None = None  # JSON serializable data
    image_bytes: bytes | None = None  # PNG/SVG image bytes
    error: str | None = None
    
    # For interactive charts (Plotly, Bokeh)
    script: str | None = None


class ChartRenderer(ABC):
    """
    Abstract base class for chart renderers.
    
    Implements the Strategy pattern - each renderer provides
    a different implementation for creating visualizations.
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """Return the renderer name (e.g., 'plotly', 'matplotlib')."""
        pass

    @property
    @abstractmethod
    def supported_chart_types(self) -> list[str]:
        """Return list of supported chart type IDs."""
        pass

    def supports(self, chart_type: str) -> bool:
        """Check if renderer supports a chart type."""
        return chart_type in self.supported_chart_types

    @abstractmethod
    def render(self, data: pd.DataFrame, config: ChartConfig) -> RenderResult:
        """
        Render a chart from data and configuration.
        
        Args:
            data: DataFrame containing the chart data
            config: Chart configuration
            
        Returns:
            RenderResult with HTML/image representation
        """
        pass

    @abstractmethod
    def render_to_html(
        self, data: pd.DataFrame, config: ChartConfig, options: dict | None = None
    ) -> str:
        """
        Render chart directly to HTML string.
        
        Args:
            data: DataFrame containing the chart data
            config: Chart configuration
            options: Optional additional rendering options
            
        Returns:
            HTML string that can be embedded in a page
        """
        pass

    def validate_config(self, config: ChartConfig) -> list[str]:
        """
        Validate chart configuration.
        
        Args:
            config: Chart configuration to validate
            
        Returns:
            List of error messages (empty if valid)
        """
        errors = []
        
        if not self.supports(config.chart_type):
            errors.append(
                f"Chart type '{config.chart_type}' is not supported by {self.name} renderer"
            )
        
        return errors

    def get_default_options(self, chart_type: str) -> dict:
        """
        Get default rendering options for a chart type.
        
        Args:
            chart_type: Chart type ID
            
        Returns:
            Dictionary of default options
        """
        return {}

