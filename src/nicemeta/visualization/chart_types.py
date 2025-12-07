"""
Chart type definitions for NiceMeta visualizations.

Defines all supported chart types across different rendering libraries.
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Literal


class ChartCategory(Enum):
    """Categories of chart types."""
    BASIC = "basic"
    DISTRIBUTION = "distribution"
    CORRELATION = "correlation"
    PART_TO_WHOLE = "part_to_whole"
    HIERARCHICAL = "hierarchical"
    FLOW = "flow"
    GEO = "geo"
    FINANCIAL = "financial"
    THREE_D = "3d"
    OTHER = "other"


@dataclass
class ChartType:
    """Definition of a chart type."""
    
    id: str
    name: str
    description: str
    category: ChartCategory
    
    # Which renderers support this chart type
    supported_renderers: list[str] = field(default_factory=list)
    
    # Required and optional data mappings
    required_fields: list[str] = field(default_factory=list)
    optional_fields: list[str] = field(default_factory=list)
    
    # Default renderer for this chart type
    default_renderer: str = "plotly"
    
    # Icon for UI (using Material Design icons)
    icon: str = "show_chart"


# Define all supported chart types
CHART_TYPES: dict[str, ChartType] = {
    # Basic Charts
    "line": ChartType(
        id="line",
        name="Line Chart",
        description="Display trends over time or continuous data",
        category=ChartCategory.BASIC,
        supported_renderers=["plotly", "matplotlib", "seaborn", "altair", "bokeh"],
        required_fields=["x", "y"],
        optional_fields=["color", "line_style"],
        icon="show_chart",
    ),
    "bar": ChartType(
        id="bar",
        name="Bar Chart",
        description="Compare values across categories",
        category=ChartCategory.BASIC,
        supported_renderers=["plotly", "matplotlib", "seaborn", "altair", "bokeh"],
        required_fields=["x", "y"],
        optional_fields=["color", "orientation"],
        icon="bar_chart",
    ),
    "scatter": ChartType(
        id="scatter",
        name="Scatter Plot",
        description="Show relationship between two numeric variables",
        category=ChartCategory.CORRELATION,
        supported_renderers=["plotly", "matplotlib", "seaborn", "altair", "bokeh"],
        required_fields=["x", "y"],
        optional_fields=["color", "size", "symbol"],
        icon="scatter_plot",
    ),
    "area": ChartType(
        id="area",
        name="Area Chart",
        description="Show cumulative totals over time",
        category=ChartCategory.BASIC,
        supported_renderers=["plotly", "matplotlib", "altair", "bokeh"],
        required_fields=["x", "y"],
        optional_fields=["color", "stacked"],
        icon="area_chart",
    ),
    
    # Part-to-Whole Charts
    "pie": ChartType(
        id="pie",
        name="Pie Chart",
        description="Show proportions of a whole",
        category=ChartCategory.PART_TO_WHOLE,
        supported_renderers=["plotly", "matplotlib", "altair", "bokeh"],
        required_fields=["values", "labels"],
        optional_fields=["hole"],
        icon="pie_chart",
    ),
    "donut": ChartType(
        id="donut",
        name="Donut Chart",
        description="Pie chart with a hole in the center",
        category=ChartCategory.PART_TO_WHOLE,
        supported_renderers=["plotly", "matplotlib", "altair", "bokeh"],
        required_fields=["values", "labels"],
        optional_fields=[],
        icon="donut_large",
    ),
    "treemap": ChartType(
        id="treemap",
        name="Treemap",
        description="Show hierarchical data as nested rectangles",
        category=ChartCategory.HIERARCHICAL,
        supported_renderers=["plotly", "altair"],
        required_fields=["values", "labels"],
        optional_fields=["parents", "color"],
        default_renderer="plotly",
        icon="grid_view",
    ),
    "sunburst": ChartType(
        id="sunburst",
        name="Sunburst",
        description="Hierarchical data as concentric rings",
        category=ChartCategory.HIERARCHICAL,
        supported_renderers=["plotly", "altair"],
        required_fields=["values", "labels"],
        optional_fields=["parents"],
        default_renderer="plotly",
        icon="brightness_7",
    ),
    
    # Distribution Charts
    "histogram": ChartType(
        id="histogram",
        name="Histogram",
        description="Show distribution of a numeric variable",
        category=ChartCategory.DISTRIBUTION,
        supported_renderers=["plotly", "matplotlib", "seaborn", "altair", "bokeh"],
        required_fields=["x"],
        optional_fields=["bins", "color"],
        icon="equalizer",
    ),
    "box": ChartType(
        id="box",
        name="Box Plot",
        description="Show distribution with quartiles and outliers",
        category=ChartCategory.DISTRIBUTION,
        supported_renderers=["plotly", "matplotlib", "seaborn", "altair", "bokeh"],
        required_fields=["y"],
        optional_fields=["x", "color"],
        icon="candlestick_chart",
    ),
    "violin": ChartType(
        id="violin",
        name="Violin Plot",
        description="Combination of box plot and kernel density",
        category=ChartCategory.DISTRIBUTION,
        supported_renderers=["plotly", "matplotlib", "seaborn", "altair"],
        required_fields=["y"],
        optional_fields=["x", "color"],
        default_renderer="seaborn",
        icon="graphic_eq",
    ),
    "kde": ChartType(
        id="kde",
        name="KDE Plot",
        description="Kernel density estimation",
        category=ChartCategory.DISTRIBUTION,
        supported_renderers=["matplotlib", "seaborn"],
        required_fields=["x"],
        optional_fields=["y", "color"],
        default_renderer="seaborn",
        icon="show_chart",
    ),
    "strip": ChartType(
        id="strip",
        name="Strip Plot",
        description="Scatter plot for categorical data",
        category=ChartCategory.DISTRIBUTION,
        supported_renderers=["seaborn", "plotly"],
        required_fields=["x", "y"],
        optional_fields=["color", "jitter"],
        default_renderer="seaborn",
        icon="more_vert",
    ),
    "swarm": ChartType(
        id="swarm",
        name="Swarm Plot",
        description="Strip plot with non-overlapping points",
        category=ChartCategory.DISTRIBUTION,
        supported_renderers=["seaborn"],
        required_fields=["x", "y"],
        optional_fields=["color"],
        default_renderer="seaborn",
        icon="blur_on",
    ),
    
    # Correlation Charts
    "heatmap": ChartType(
        id="heatmap",
        name="Heatmap",
        description="Show matrix values as colors",
        category=ChartCategory.CORRELATION,
        supported_renderers=["plotly", "matplotlib", "seaborn", "altair", "bokeh"],
        required_fields=["z"],
        optional_fields=["x", "y", "colorscale"],
        icon="grid_on",
    ),
    "correlation": ChartType(
        id="correlation",
        name="Correlation Matrix",
        description="Show correlations between numeric columns",
        category=ChartCategory.CORRELATION,
        supported_renderers=["plotly", "seaborn"],
        required_fields=["columns"],
        optional_fields=["method"],
        default_renderer="seaborn",
        icon="apps",
    ),
    "pairplot": ChartType(
        id="pairplot",
        name="Pair Plot",
        description="Grid of scatter plots for multiple variables",
        category=ChartCategory.CORRELATION,
        supported_renderers=["seaborn", "plotly"],
        required_fields=["columns"],
        optional_fields=["color", "diag_kind"],
        default_renderer="seaborn",
        icon="view_module",
    ),
    "jointplot": ChartType(
        id="jointplot",
        name="Joint Plot",
        description="Scatter plot with marginal distributions",
        category=ChartCategory.CORRELATION,
        supported_renderers=["seaborn"],
        required_fields=["x", "y"],
        optional_fields=["kind", "color"],
        default_renderer="seaborn",
        icon="add_box",
    ),
    "regression": ChartType(
        id="regression",
        name="Regression Plot",
        description="Scatter plot with regression line",
        category=ChartCategory.CORRELATION,
        supported_renderers=["seaborn", "plotly"],
        required_fields=["x", "y"],
        optional_fields=["order", "ci"],
        default_renderer="seaborn",
        icon="trending_up",
    ),
    
    # Flow Charts
    "funnel": ChartType(
        id="funnel",
        name="Funnel Chart",
        description="Show stages in a process",
        category=ChartCategory.FLOW,
        supported_renderers=["plotly"],
        required_fields=["values", "labels"],
        optional_fields=["color"],
        default_renderer="plotly",
        icon="filter_alt",
    ),
    "sankey": ChartType(
        id="sankey",
        name="Sankey Diagram",
        description="Show flow between nodes",
        category=ChartCategory.FLOW,
        supported_renderers=["plotly", "altair"],
        required_fields=["source", "target", "value"],
        optional_fields=["labels"],
        default_renderer="plotly",
        icon="account_tree",
    ),
    "waterfall": ChartType(
        id="waterfall",
        name="Waterfall Chart",
        description="Show cumulative effect of values",
        category=ChartCategory.FLOW,
        supported_renderers=["plotly"],
        required_fields=["x", "y"],
        optional_fields=["measure"],
        default_renderer="plotly",
        icon="waterfall_chart",
    ),
    
    # Financial Charts
    "candlestick": ChartType(
        id="candlestick",
        name="Candlestick Chart",
        description="Show OHLC financial data",
        category=ChartCategory.FINANCIAL,
        supported_renderers=["plotly", "bokeh"],
        required_fields=["x", "open", "high", "low", "close"],
        optional_fields=[],
        default_renderer="plotly",
        icon="candlestick_chart",
    ),
    "ohlc": ChartType(
        id="ohlc",
        name="OHLC Chart",
        description="Open-High-Low-Close chart",
        category=ChartCategory.FINANCIAL,
        supported_renderers=["plotly", "bokeh"],
        required_fields=["x", "open", "high", "low", "close"],
        optional_fields=[],
        default_renderer="plotly",
        icon="trending_up",
    ),
    
    # Geographic Charts
    "choropleth": ChartType(
        id="choropleth",
        name="Choropleth Map",
        description="Geographic map with colored regions",
        category=ChartCategory.GEO,
        supported_renderers=["plotly", "altair"],
        required_fields=["locations", "values"],
        optional_fields=["geojson", "colorscale"],
        default_renderer="plotly",
        icon="map",
    ),
    "scatter_geo": ChartType(
        id="scatter_geo",
        name="Scatter Map",
        description="Points on a geographic map",
        category=ChartCategory.GEO,
        supported_renderers=["plotly"],
        required_fields=["lat", "lon"],
        optional_fields=["color", "size", "text"],
        default_renderer="plotly",
        icon="place",
    ),
    
    # 3D Charts
    "scatter_3d": ChartType(
        id="scatter_3d",
        name="3D Scatter Plot",
        description="Scatter plot in three dimensions",
        category=ChartCategory.THREE_D,
        supported_renderers=["plotly"],
        required_fields=["x", "y", "z"],
        optional_fields=["color", "size"],
        default_renderer="plotly",
        icon="3d_rotation",
    ),
    "surface_3d": ChartType(
        id="surface_3d",
        name="3D Surface",
        description="Surface plot in three dimensions",
        category=ChartCategory.THREE_D,
        supported_renderers=["plotly"],
        required_fields=["x", "y", "z"],
        optional_fields=["colorscale"],
        default_renderer="plotly",
        icon="layers",
    ),
    "line_3d": ChartType(
        id="line_3d",
        name="3D Line",
        description="Line plot in three dimensions",
        category=ChartCategory.THREE_D,
        supported_renderers=["plotly"],
        required_fields=["x", "y", "z"],
        optional_fields=["color"],
        default_renderer="plotly",
        icon="timeline",
    ),
    
    # Other Charts
    "gauge": ChartType(
        id="gauge",
        name="Gauge",
        description="Show a single value against a scale",
        category=ChartCategory.OTHER,
        supported_renderers=["plotly", "bokeh"],
        required_fields=["value"],
        optional_fields=["min", "max", "thresholds"],
        default_renderer="plotly",
        icon="speed",
    ),
    "indicator": ChartType(
        id="indicator",
        name="Indicator",
        description="Display a key metric",
        category=ChartCategory.OTHER,
        supported_renderers=["plotly"],
        required_fields=["value"],
        optional_fields=["delta", "reference"],
        default_renderer="plotly",
        icon="analytics",
    ),
    "table": ChartType(
        id="table",
        name="Table",
        description="Display data as a table",
        category=ChartCategory.OTHER,
        supported_renderers=["plotly", "bokeh"],
        required_fields=["columns"],
        optional_fields=[],
        default_renderer="plotly",
        icon="table_chart",
    ),
    "contour": ChartType(
        id="contour",
        name="Contour Plot",
        description="Show 2D density with contour lines",
        category=ChartCategory.DISTRIBUTION,
        supported_renderers=["plotly", "matplotlib"],
        required_fields=["x", "y", "z"],
        optional_fields=["colorscale"],
        default_renderer="plotly",
        icon="layers",
    ),
    "radar": ChartType(
        id="radar",
        name="Radar Chart",
        description="Show multivariate data on radial axes",
        category=ChartCategory.OTHER,
        supported_renderers=["plotly"],
        required_fields=["categories", "values"],
        optional_fields=["fill"],
        default_renderer="plotly",
        icon="radar",
    ),
    "parallel_coordinates": ChartType(
        id="parallel_coordinates",
        name="Parallel Coordinates",
        description="Compare multiple numeric variables",
        category=ChartCategory.OTHER,
        supported_renderers=["plotly", "altair"],
        required_fields=["dimensions"],
        optional_fields=["color"],
        default_renderer="plotly",
        icon="stacked_line_chart",
    ),
}


def get_chart_type(chart_id: str) -> ChartType | None:
    """Get a chart type by ID."""
    return CHART_TYPES.get(chart_id)


def get_chart_types_by_category(category: ChartCategory) -> list[ChartType]:
    """Get all chart types in a category."""
    return [ct for ct in CHART_TYPES.values() if ct.category == category]


def get_chart_types_for_renderer(renderer: str) -> list[ChartType]:
    """Get all chart types supported by a renderer."""
    return [ct for ct in CHART_TYPES.values() if renderer in ct.supported_renderers]

