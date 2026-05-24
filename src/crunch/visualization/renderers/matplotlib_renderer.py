"""
Matplotlib chart renderer.

Provides static chart rendering using Matplotlib.
Best for generating publication-quality static images.
"""

import base64
import io
from typing import Any

import matplotlib
matplotlib.use("Agg")  # Use non-interactive backend
import matplotlib.pyplot as plt
import pandas as pd

from crunch.visualization.base import ChartConfig, ChartRenderer, RenderResult


class MatplotlibRenderer(ChartRenderer):
    """
    Renderer using Matplotlib for static charts.
    
    Generates PNG images that can be embedded in HTML.
    Good for print-quality visualizations.
    """

    @property
    def name(self) -> str:
        return "matplotlib"

    @property
    def supported_chart_types(self) -> list[str]:
        return [
            "line", "bar", "scatter", "area",
            "pie", "histogram", "box",
            "heatmap", "contour",
        ]

    def render(self, data: pd.DataFrame, config: ChartConfig) -> RenderResult:
        """Render a Matplotlib chart."""
        try:
            fig, ax = self._create_figure(data, config)
            
            # Apply common settings
            self._apply_styling(fig, ax, config)
            
            # Convert to PNG
            buf = io.BytesIO()
            fig.savefig(buf, format="png", dpi=100, bbox_inches="tight")
            buf.seek(0)
            image_bytes = buf.getvalue()
            
            # Convert to base64 for HTML embedding
            b64 = base64.b64encode(image_bytes).decode("utf-8")
            html = f'<img src="data:image/png;base64,{b64}" alt="{config.title}">'
            
            plt.close(fig)
            
            return RenderResult(
                success=True,
                html=html,
                image_bytes=image_bytes,
            )
            
        except Exception as e:
            plt.close("all")
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
        result = self.render(data, config)
        if result.success:
            return result.html or ""
        return f"<div class='error'>Error: {result.error}</div>"

    def _create_figure(
        self, data: pd.DataFrame, config: ChartConfig
    ) -> tuple[plt.Figure, plt.Axes]:
        """Create the appropriate Matplotlib figure."""
        chart_type = config.chart_type
        
        # Set figure size
        width = (config.width or 800) / 100
        height = (config.height or 500) / 100
        fig, ax = plt.subplots(figsize=(width, height))
        
        if chart_type == "line":
            self._line_chart(ax, data, config)
        elif chart_type == "bar":
            self._bar_chart(ax, data, config)
        elif chart_type == "scatter":
            self._scatter_chart(ax, data, config)
        elif chart_type == "area":
            self._area_chart(ax, data, config)
        elif chart_type == "pie":
            self._pie_chart(ax, data, config)
        elif chart_type == "histogram":
            self._histogram_chart(ax, data, config)
        elif chart_type == "box":
            self._box_chart(ax, data, config)
        elif chart_type == "heatmap":
            self._heatmap_chart(fig, ax, data, config)
        elif chart_type == "contour":
            self._contour_chart(ax, data, config)
        else:
            raise ValueError(f"Unsupported chart type: {chart_type}")
        
        return fig, ax

    def _apply_styling(
        self, fig: plt.Figure, ax: plt.Axes, config: ChartConfig
    ) -> None:
        """Apply common styling."""
        if config.title:
            ax.set_title(config.title, fontsize=14, fontweight="bold")
        if config.x_label:
            ax.set_xlabel(config.x_label)
        if config.y_label:
            ax.set_ylabel(config.y_label)
        
        fig.tight_layout()

    def _line_chart(
        self, ax: plt.Axes, data: pd.DataFrame, config: ChartConfig
    ) -> None:
        if config.color and config.color in data.columns:
            for name, group in data.groupby(config.color):
                ax.plot(group[config.x], group[config.y], label=name)
            ax.legend()
        else:
            y_cols = config.y if isinstance(config.y, list) else [config.y]
            for col in y_cols:
                ax.plot(data[config.x], data[col], label=col)
            if len(y_cols) > 1:
                ax.legend()

    def _bar_chart(
        self, ax: plt.Axes, data: pd.DataFrame, config: ChartConfig
    ) -> None:
        if config.color and config.color in data.columns:
            data.pivot(index=config.x, columns=config.color, values=config.y).plot(
                kind="bar", ax=ax
            )
        else:
            ax.bar(data[config.x], data[config.y])

    def _scatter_chart(
        self, ax: plt.Axes, data: pd.DataFrame, config: ChartConfig
    ) -> None:
        size = data[config.size] * 10 if config.size else 50
        if config.color and config.color in data.columns:
            for name, group in data.groupby(config.color):
                ax.scatter(group[config.x], group[config.y], label=name, s=size)
            ax.legend()
        else:
            ax.scatter(data[config.x], data[config.y], s=size)

    def _area_chart(
        self, ax: plt.Axes, data: pd.DataFrame, config: ChartConfig
    ) -> None:
        ax.fill_between(data[config.x], data[config.y], alpha=0.5)
        ax.plot(data[config.x], data[config.y])

    def _pie_chart(
        self, ax: plt.Axes, data: pd.DataFrame, config: ChartConfig
    ) -> None:
        ax.pie(
            data[config.values],
            labels=data[config.labels],
            autopct="%1.1f%%",
        )

    def _histogram_chart(
        self, ax: plt.Axes, data: pd.DataFrame, config: ChartConfig
    ) -> None:
        bins = config.options.get("bins", 30)
        ax.hist(data[config.x], bins=bins, edgecolor="black")

    def _box_chart(
        self, ax: plt.Axes, data: pd.DataFrame, config: ChartConfig
    ) -> None:
        if config.x:
            data.boxplot(column=config.y, by=config.x, ax=ax)
            ax.set_title("")
            plt.suptitle("")
        else:
            ax.boxplot(data[config.y])

    def _heatmap_chart(
        self, fig: plt.Figure, ax: plt.Axes, data: pd.DataFrame, config: ChartConfig
    ) -> None:
        if config.z:
            pivot = data.pivot(index=config.y, columns=config.x, values=config.z)
            im = ax.imshow(pivot, cmap=config.color_scheme or "viridis")
        else:
            im = ax.imshow(data, cmap=config.color_scheme or "viridis")
        fig.colorbar(im, ax=ax)

    def _contour_chart(
        self, ax: plt.Axes, data: pd.DataFrame, config: ChartConfig
    ) -> None:
        # Requires pivot or pre-processed data
        if config.z:
            pivot = data.pivot(index=config.y, columns=config.x, values=config.z)
            ax.contour(pivot)
        else:
            ax.contour(data)

