"""
Chart widget component for displaying visualizations.
"""

from typing import Any, Callable

import pandas as pd
from nicegui import ui

from crunch.visualization import ChartConfig, ChartFactory


class ChartWidget:
    """
    Widget for displaying chart visualizations.
    
    Wraps the visualization factory for NiceGUI integration.
    """

    def __init__(
        self,
        data: pd.DataFrame | None = None,
        config: ChartConfig | None = None,
        renderer: str | None = None,
    ):
        """
        Initialize the chart widget.
        
        Args:
            data: DataFrame to visualize
            config: Chart configuration
            renderer: Optional specific renderer to use
        """
        self.data = data
        self.config = config
        self.renderer = renderer
        self._container = None

    def create(self) -> ui.element:
        """Create the chart widget UI element."""
        with ui.card().classes("w-full") as self._container:
            if self.config and self.config.title:
                ui.label(self.config.title).classes("text-lg font-semibold mb-2")
            
            self._chart_container = ui.html("", sanitize=False).classes("w-full")
            
            if self.data is not None and self.config is not None:
                self.render()
        
        return self._container

    def render(self) -> None:
        """Render or re-render the chart."""
        if self.data is None or self.config is None:
            self._chart_container.content = "<p class='text-grey-6'>No data to display</p>"
            return
        
        try:
            html = ChartFactory.render_to_html(self.data, self.config, self.renderer)
            self._chart_container.content = html
        except Exception as e:
            self._chart_container.content = f"<p class='text-negative'>Error: {e}</p>"

    def update_data(self, data: pd.DataFrame) -> None:
        """Update the chart data and re-render."""
        self.data = data
        self.render()

    def update_config(self, config: ChartConfig) -> None:
        """Update the chart configuration and re-render."""
        self.config = config
        self.render()


def create_chart_type_selector(
    on_select: Callable,
    selected: str = "line",
) -> ui.element:
    """
    Create a chart type selector grid.
    
    Args:
        on_select: Callback when chart type is selected
        selected: Currently selected chart type
        
    Returns:
        UI element containing the selector
    """
    chart_types = ChartFactory.get_chart_types()
    
    # Group by category
    categories: dict[str, list] = {}
    for ct in chart_types:
        cat = ct["category"]
        if cat not in categories:
            categories[cat] = []
        categories[cat].append(ct)
    
    with ui.card().classes("w-full") as container:
        ui.label("Chart Type").classes("text-lg font-semibold mb-4")
        
        for category, types in categories.items():
            ui.label(category.replace("_", " ").title()).classes(
                "text-sm font-medium text-grey-6 mt-4 mb-2"
            )
            
            with ui.row().classes("flex-wrap gap-2"):
                for ct in types:
                    is_selected = ct["id"] == selected
                    
                    with ui.button(
                        on_click=lambda c=ct["id"]: on_select(c)
                    ).props(f"{'color=primary' if is_selected else 'flat'}").classes(
                        "min-w-0"
                    ):
                        ui.icon(ct["icon"])
                        ui.tooltip(ct["name"])
    
    return container


def create_chart_config_panel(
    columns: list[str],
    chart_type: str,
    config: dict,
    on_change: Callable,
) -> ui.element:
    """
    Create a configuration panel for chart settings.
    
    Args:
        columns: Available data columns
        chart_type: Selected chart type
        config: Current configuration
        on_change: Callback when config changes
        
    Returns:
        UI element containing the config panel
    """
    from crunch.visualization.chart_types import get_chart_type
    
    chart_def = get_chart_type(chart_type)
    
    with ui.card().classes("w-full") as container:
        ui.label("Configuration").classes("text-lg font-semibold mb-4")
        
        if not chart_def:
            ui.label("Unknown chart type").classes("text-grey-6")
            return container
        
        # Required fields
        if chart_def.required_fields:
            ui.label("Required").classes("text-sm font-medium text-grey-6 mb-2")
            
            for field in chart_def.required_fields:
                with ui.row().classes("items-center gap-2 w-full"):
                    ui.label(field.replace("_", " ").title()).classes("w-24")
                    ui.select(
                        options=columns,
                        value=config.get(field),
                        on_change=lambda e, f=field: on_change(f, e.value),
                    ).classes("flex-grow")
        
        # Optional fields
        if chart_def.optional_fields:
            ui.label("Optional").classes("text-sm font-medium text-grey-6 mt-4 mb-2")
            
            for field in chart_def.optional_fields:
                with ui.row().classes("items-center gap-2 w-full"):
                    ui.label(field.replace("_", " ").title()).classes("w-24")
                    ui.select(
                        options=[""] + columns,
                        value=config.get(field, ""),
                        on_change=lambda e, f=field: on_change(f, e.value),
                    ).classes("flex-grow")
        
        # Title
        ui.label("Appearance").classes("text-sm font-medium text-grey-6 mt-4 mb-2")
        
        ui.input(
            label="Title",
            value=config.get("title", ""),
            on_change=lambda e: on_change("title", e.value),
        ).classes("w-full")
    
    return container

