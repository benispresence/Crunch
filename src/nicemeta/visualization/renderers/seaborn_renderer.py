"""
Seaborn chart renderer.

Statistical visualization using Seaborn.
Best for statistical plots and distributions.
"""

import base64
import io
from typing import Any

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns

from nicemeta.visualization.base import ChartConfig, ChartRenderer, RenderResult


class SeabornRenderer(ChartRenderer):
    """
    Renderer using Seaborn for statistical visualizations.
    
    Seaborn provides beautiful statistical graphics built on Matplotlib.
    Best for distribution plots, regression, and correlation analysis.
    """

    def __init__(self):
        """Initialize with Seaborn styling."""
        sns.set_theme(style="whitegrid")

    @property
    def name(self) -> str:
        return "seaborn"

    @property
    def supported_chart_types(self) -> list[str]:
        return [
            "line", "bar", "scatter",
            "histogram", "box", "violin",
            "kde", "strip", "swarm",
            "heatmap", "correlation",
            "pairplot", "jointplot", "regression",
        ]

    def render(self, data: pd.DataFrame, config: ChartConfig) -> RenderResult:
        """Render a Seaborn chart."""
        try:
            fig = self._create_figure(data, config)
            
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

    def render_to_html(self, data: pd.DataFrame, config: ChartConfig) -> str:
        """Render directly to HTML string."""
        result = self.render(data, config)
        if result.success:
            return result.html or ""
        return f"<div class='error'>Error: {result.error}</div>"

    def _create_figure(self, data: pd.DataFrame, config: ChartConfig) -> plt.Figure:
        """Create the appropriate Seaborn figure."""
        chart_type = config.chart_type
        
        # Set figure size
        width = (config.width or 800) / 100
        height = (config.height or 500) / 100
        
        # Some chart types create their own figure
        if chart_type in ["pairplot", "jointplot"]:
            return self._create_grid_figure(data, config, chart_type)
        
        fig, ax = plt.subplots(figsize=(width, height))
        
        if chart_type == "line":
            self._line_chart(ax, data, config)
        elif chart_type == "bar":
            self._bar_chart(ax, data, config)
        elif chart_type == "scatter":
            self._scatter_chart(ax, data, config)
        elif chart_type == "histogram":
            self._histogram_chart(ax, data, config)
        elif chart_type == "kde":
            self._kde_chart(ax, data, config)
        elif chart_type == "box":
            self._box_chart(ax, data, config)
        elif chart_type == "violin":
            self._violin_chart(ax, data, config)
        elif chart_type == "strip":
            self._strip_chart(ax, data, config)
        elif chart_type == "swarm":
            self._swarm_chart(ax, data, config)
        elif chart_type == "heatmap":
            self._heatmap_chart(ax, data, config)
        elif chart_type == "correlation":
            self._correlation_chart(ax, data, config)
        elif chart_type == "regression":
            self._regression_chart(ax, data, config)
        else:
            raise ValueError(f"Unsupported chart type: {chart_type}")
        
        # Apply title
        if config.title:
            ax.set_title(config.title, fontsize=14, fontweight="bold")
        if config.x_label:
            ax.set_xlabel(config.x_label)
        if config.y_label:
            ax.set_ylabel(config.y_label)
        
        fig.tight_layout()
        return fig

    def _create_grid_figure(
        self, data: pd.DataFrame, config: ChartConfig, chart_type: str
    ) -> plt.Figure:
        """Create figure-level plots (pairplot, jointplot)."""
        if chart_type == "pairplot":
            g = sns.pairplot(
                data,
                hue=config.color,
                diag_kind=config.options.get("diag_kind", "auto"),
            )
            if config.title:
                g.figure.suptitle(config.title, y=1.02)
            return g.figure
        
        elif chart_type == "jointplot":
            g = sns.jointplot(
                data=data,
                x=config.x,
                y=config.y,
                hue=config.color,
                kind=config.options.get("kind", "scatter"),
            )
            if config.title:
                g.figure.suptitle(config.title, y=1.02)
            return g.figure
        
        raise ValueError(f"Unknown grid chart type: {chart_type}")

    def _line_chart(
        self, ax: plt.Axes, data: pd.DataFrame, config: ChartConfig
    ) -> None:
        sns.lineplot(
            data=data,
            x=config.x,
            y=config.y,
            hue=config.color,
            ax=ax,
        )

    def _bar_chart(
        self, ax: plt.Axes, data: pd.DataFrame, config: ChartConfig
    ) -> None:
        sns.barplot(
            data=data,
            x=config.x,
            y=config.y,
            hue=config.color,
            ax=ax,
        )

    def _scatter_chart(
        self, ax: plt.Axes, data: pd.DataFrame, config: ChartConfig
    ) -> None:
        sns.scatterplot(
            data=data,
            x=config.x,
            y=config.y,
            hue=config.color,
            size=config.size,
            ax=ax,
        )

    def _histogram_chart(
        self, ax: plt.Axes, data: pd.DataFrame, config: ChartConfig
    ) -> None:
        bins = config.options.get("bins", "auto")
        sns.histplot(
            data=data,
            x=config.x,
            hue=config.color,
            bins=bins,
            ax=ax,
        )

    def _kde_chart(
        self, ax: plt.Axes, data: pd.DataFrame, config: ChartConfig
    ) -> None:
        sns.kdeplot(
            data=data,
            x=config.x,
            y=config.y if config.y else None,
            hue=config.color,
            ax=ax,
            fill=True,
        )

    def _box_chart(
        self, ax: plt.Axes, data: pd.DataFrame, config: ChartConfig
    ) -> None:
        sns.boxplot(
            data=data,
            x=config.x,
            y=config.y,
            hue=config.color,
            ax=ax,
        )

    def _violin_chart(
        self, ax: plt.Axes, data: pd.DataFrame, config: ChartConfig
    ) -> None:
        sns.violinplot(
            data=data,
            x=config.x,
            y=config.y,
            hue=config.color,
            ax=ax,
        )

    def _strip_chart(
        self, ax: plt.Axes, data: pd.DataFrame, config: ChartConfig
    ) -> None:
        jitter = config.options.get("jitter", True)
        sns.stripplot(
            data=data,
            x=config.x,
            y=config.y,
            hue=config.color,
            jitter=jitter,
            ax=ax,
        )

    def _swarm_chart(
        self, ax: plt.Axes, data: pd.DataFrame, config: ChartConfig
    ) -> None:
        sns.swarmplot(
            data=data,
            x=config.x,
            y=config.y,
            hue=config.color,
            ax=ax,
        )

    def _heatmap_chart(
        self, ax: plt.Axes, data: pd.DataFrame, config: ChartConfig
    ) -> None:
        if config.z:
            pivot = data.pivot(index=config.y, columns=config.x, values=config.z)
            sns.heatmap(pivot, ax=ax, cmap=config.color_scheme or "viridis", annot=True)
        else:
            sns.heatmap(data, ax=ax, cmap=config.color_scheme or "viridis", annot=True)

    def _correlation_chart(
        self, ax: plt.Axes, data: pd.DataFrame, config: ChartConfig
    ) -> None:
        numeric_data = data.select_dtypes(include=["number"])
        method = config.options.get("method", "pearson")
        corr_matrix = numeric_data.corr(method=method)
        sns.heatmap(
            corr_matrix,
            ax=ax,
            cmap="RdBu_r",
            annot=True,
            fmt=".2f",
            vmin=-1,
            vmax=1,
            center=0,
        )

    def _regression_chart(
        self, ax: plt.Axes, data: pd.DataFrame, config: ChartConfig
    ) -> None:
        order = config.options.get("order", 1)
        ci = config.options.get("ci", 95)
        sns.regplot(
            data=data,
            x=config.x,
            y=config.y,
            order=order,
            ci=ci,
            ax=ax,
        )

