"""
Visualization code generator.

Generates Python code from ChartConfig that can be edited by users.
"""

from typing import Any

import pandas as pd

from nicemeta.visualization.base import ChartConfig


class CodeGenerator:
    """
    Generates Python visualization code from ChartConfig.
    
    The generated code can be displayed in the Python editor
    and modified by users for custom visualizations.
    """

    # Template for the code header
    HEADER_TEMPLATE = '''"""
Auto-generated visualization code.
You can modify this code to customize your chart.
"""

import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
{extra_imports}
# DataFrame 'df' contains your query results
# Columns: {columns}
# Rows: {row_count}

'''

    @classmethod
    def generate(
        cls,
        config: ChartConfig,
        df: pd.DataFrame,
        options: dict[str, Any] | None = None,
    ) -> str:
        """
        Generate Python code from a chart configuration.
        
        Args:
            config: Chart configuration
            df: DataFrame with the data (for column info)
            options: Additional chart options
            
        Returns:
            Python code as a string
        """
        options = options or {}
        
        # Build header with data info
        columns = list(df.columns) if df is not None else []
        row_count = len(df) if df is not None else 0
        
        # Auto-detect x and y columns if not specified
        if df is not None and len(columns) > 0:
            # Try to find numeric and categorical columns
            numeric_cols = df.select_dtypes(include=['number']).columns.tolist()
            non_numeric_cols = [c for c in columns if c not in numeric_cols]
            
            # Set defaults if not specified
            if not config.x:
                config.x = non_numeric_cols[0] if non_numeric_cols else columns[0]
            if not config.y:
                config.y = numeric_cols[0] if numeric_cols else (columns[1] if len(columns) > 1 else columns[0])
            if not config.labels:
                config.labels = non_numeric_cols[0] if non_numeric_cols else columns[0]
            if not config.values:
                config.values = numeric_cols[0] if numeric_cols else (columns[1] if len(columns) > 1 else columns[0])
        
        extra_imports = ""
        if config.chart_type in ["heatmap", "correlation"]:
            extra_imports = "import numpy as np\n"
        
        code = cls.HEADER_TEMPLATE.format(
            extra_imports=extra_imports,
            columns=columns,
            row_count=row_count,
        )
        
        # Generate chart-specific code
        chart_type = config.chart_type
        
        if chart_type == "bar":
            code += cls._generate_bar_chart(config, options)
        elif chart_type == "line":
            code += cls._generate_line_chart(config, options)
        elif chart_type == "scatter":
            code += cls._generate_scatter_chart(config, options)
        elif chart_type == "area":
            code += cls._generate_area_chart(config, options)
        elif chart_type == "pie":
            code += cls._generate_pie_chart(config, options)
        elif chart_type == "donut":
            code += cls._generate_donut_chart(config, options)
        elif chart_type == "histogram":
            code += cls._generate_histogram_chart(config, options)
        elif chart_type == "box":
            code += cls._generate_box_chart(config, options)
        elif chart_type == "heatmap":
            code += cls._generate_heatmap_chart(config, options)
        elif chart_type == "table":
            code += cls._generate_table_chart(config, options)
        else:
            # Default to bar chart
            code += cls._generate_bar_chart(config, options)
        
        # Add layout customization
        code += cls._generate_layout_code(config, options)
        
        # Add the display line
        code += "\n# The figure will be rendered automatically\nfig\n"
        
        return code

    @classmethod
    def _generate_bar_chart(cls, config: ChartConfig, options: dict) -> str:
        """Generate bar chart code."""
        orientation = options.get("orientation", "v")
        bar_mode = options.get("bar_mode", "group")
        show_values = options.get("show_values", False)
        color_palette = options.get("color_palette", "plotly")
        
        # Get column names with fallbacks
        x_col = config.x or "df.columns[0]"
        y_col = config.y or "df.columns[1] if len(df.columns) > 1 else df.columns[0]"
        
        # Handle orientation swap
        if orientation == "h":
            x_col, y_col = y_col, x_col
        
        # Check if we need to use dynamic column selection
        if x_col.startswith("df.columns"):
            code = f'''# Create bar chart
x_col = {x_col}
y_col = {y_col}
fig = px.bar(
    df,
    x=x_col,
    y=y_col,'''
        else:
            code = f'''# Create bar chart
fig = px.bar(
    df,
    x="{x_col}",
    y="{y_col}",'''
        
        if config.color:
            code += f'\n    color="{config.color}",'
        
        code += f'''
    orientation="{orientation}",
    barmode="{bar_mode}",
    text_auto={show_values},
    color_discrete_sequence=px.colors.qualitative.{color_palette.capitalize() if color_palette != "plotly" else "Plotly"},
)
'''
        return code

    @classmethod
    def _generate_line_chart(cls, config: ChartConfig, options: dict) -> str:
        """Generate line chart code."""
        line_style = options.get("line_style", "solid")
        show_markers = options.get("show_markers", False)
        color_palette = options.get("color_palette", "plotly")
        
        code = f'''# Create line chart
fig = px.line(
    df,
    x="{config.x}",
    y="{config.y}",'''
        
        if config.color:
            code += f'\n    color="{config.color}",'
        
        code += f'''
    markers={show_markers},
    color_discrete_sequence=px.colors.qualitative.{color_palette.capitalize() if color_palette != "plotly" else "Plotly"},
)
'''
        
        # Add line style if not solid
        if line_style != "solid":
            dash_map = {"dash": "dash", "dot": "dot", "dashdot": "dashdot"}
            code += f'''
# Apply line style
fig.update_traces(line=dict(dash="{dash_map.get(line_style, "solid")}"))
'''
        
        return code

    @classmethod
    def _generate_scatter_chart(cls, config: ChartConfig, options: dict) -> str:
        """Generate scatter chart code."""
        color_palette = options.get("color_palette", "plotly")
        
        code = f'''# Create scatter chart
fig = px.scatter(
    df,
    x="{config.x}",
    y="{config.y}",'''
        
        if config.color:
            code += f'\n    color="{config.color}",'
        if config.size:
            code += f'\n    size="{config.size}",'
        
        code += f'''
    color_discrete_sequence=px.colors.qualitative.{color_palette.capitalize() if color_palette != "plotly" else "Plotly"},
)
'''
        return code

    @classmethod
    def _generate_area_chart(cls, config: ChartConfig, options: dict) -> str:
        """Generate area chart code."""
        color_palette = options.get("color_palette", "plotly")
        
        code = f'''# Create area chart
fig = px.area(
    df,
    x="{config.x}",
    y="{config.y}",'''
        
        if config.color:
            code += f'\n    color="{config.color}",'
        
        code += f'''
    color_discrete_sequence=px.colors.qualitative.{color_palette.capitalize() if color_palette != "plotly" else "Plotly"},
)
'''
        return code

    @classmethod
    def _generate_pie_chart(cls, config: ChartConfig, options: dict) -> str:
        """Generate pie chart code."""
        show_percent = options.get("show_percent", True)
        color_palette = options.get("color_palette", "plotly")
        
        code = f'''# Create pie chart
fig = px.pie(
    df,
    values="{config.values}",
    names="{config.labels}",
    color_discrete_sequence=px.colors.qualitative.{color_palette.capitalize() if color_palette != "plotly" else "Plotly"},
)

# Configure text display
fig.update_traces(textinfo="{"percent+label" if show_percent else "label+value"}")
'''
        return code

    @classmethod
    def _generate_donut_chart(cls, config: ChartConfig, options: dict) -> str:
        """Generate donut chart code."""
        show_percent = options.get("show_percent", True)
        color_palette = options.get("color_palette", "plotly")
        
        code = f'''# Create donut chart
fig = px.pie(
    df,
    values="{config.values}",
    names="{config.labels}",
    hole=0.4,  # Creates the donut hole
    color_discrete_sequence=px.colors.qualitative.{color_palette.capitalize() if color_palette != "plotly" else "Plotly"},
)

# Configure text display
fig.update_traces(textinfo="{"percent+label" if show_percent else "label+value"}")
'''
        return code

    @classmethod
    def _generate_histogram_chart(cls, config: ChartConfig, options: dict) -> str:
        """Generate histogram chart code."""
        bins = options.get("bins")
        color_palette = options.get("color_palette", "plotly")
        
        code = f'''# Create histogram
fig = px.histogram(
    df,
    x="{config.x}",'''
        
        if config.color:
            code += f'\n    color="{config.color}",'
        if bins:
            code += f'\n    nbins={bins},'
        
        code += f'''
    color_discrete_sequence=px.colors.qualitative.{color_palette.capitalize() if color_palette != "plotly" else "Plotly"},
)
'''
        return code

    @classmethod
    def _generate_box_chart(cls, config: ChartConfig, options: dict) -> str:
        """Generate box chart code."""
        color_palette = options.get("color_palette", "plotly")
        
        code = f'''# Create box plot
fig = px.box(
    df,
    x="{config.x}",
    y="{config.y}",'''
        
        if config.color:
            code += f'\n    color="{config.color}",'
        
        code += f'''
    color_discrete_sequence=px.colors.qualitative.{color_palette.capitalize() if color_palette != "plotly" else "Plotly"},
)
'''
        return code

    @classmethod
    def _generate_heatmap_chart(cls, config: ChartConfig, options: dict) -> str:
        """Generate heatmap chart code."""
        color_scheme = config.color_scheme or "Viridis"
        
        code = f'''# Create heatmap
# Pivot data if needed for heatmap format
'''
        
        if config.z:
            code += f'''pivot_df = df.pivot(index="{config.y}", columns="{config.x}", values="{config.z}")
fig = px.imshow(
    pivot_df,
    color_continuous_scale="{color_scheme}",
)
'''
        else:
            code += f'''fig = px.imshow(
    df,
    color_continuous_scale="{color_scheme}",
)
'''
        return code

    @classmethod
    def _generate_table_chart(cls, config: ChartConfig, options: dict) -> str:
        """Generate table chart code."""
        code = '''# Create table visualization
fig = go.Figure(go.Table(
    header=dict(
        values=list(df.columns),
        fill_color='paleturquoise',
        align='left',
    ),
    cells=dict(
        values=[df[col] for col in df.columns],
        fill_color='lavender',
        align='left',
    ),
))
'''
        return code

    @classmethod
    def _generate_layout_code(cls, config: ChartConfig, options: dict) -> str:
        """Generate layout customization code."""
        code = "\n# Customize layout\nfig.update_layout(\n"
        
        layout_items = []
        
        if config.title:
            layout_items.append(f'    title="{config.title}"')
        
        layout_items.append('    template="plotly_white"')
        
        x_label = config.x_label or options.get("x_label", "")
        y_label = config.y_label or options.get("y_label", "")
        
        if x_label:
            layout_items.append(f'    xaxis_title="{x_label}"')
        if y_label:
            layout_items.append(f'    yaxis_title="{y_label}"')
        
        if config.width:
            layout_items.append(f'    width={config.width}')
        if config.height:
            layout_items.append(f'    height={config.height}')
        
        if not options.get("show_legend", True):
            layout_items.append('    showlegend=False')
        
        code += ",\n".join(layout_items)
        code += "\n)\n"
        
        # Add value display if requested
        if options.get("show_values", False) and config.chart_type not in ["bar", "pie", "donut"]:
            code += '\n# Show values on chart\nfig.update_traces(textposition="outside", texttemplate="%{y}")\n'
        
        return code


def generate_visualization_code(
    config: ChartConfig,
    df: pd.DataFrame,
    options: dict[str, Any] | None = None,
) -> str:
    """
    Convenience function to generate visualization code.
    
    Args:
        config: Chart configuration
        df: DataFrame with the data
        options: Additional chart options
        
    Returns:
        Python code as a string
    """
    return CodeGenerator.generate(config, df, options)

