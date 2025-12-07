"""
SQL Editor page for NiceMeta - Metabase-style layout.
"""

import pandas as pd
from nicegui import ui

from nicemeta.ui.components.sidebar import (
    MetabaseHeader,
    MetabaseSidebar,
    get_saved_queries,
    get_query_by_id,
    save_query,
    delete_query,
    get_connections,
    get_connections_async,
    refresh_cache,
)
from nicemeta.ui.components.sql_editor_widget import (
    SQLEditorWidget,
    create_results_table,
    serialize_value,
)


class SQLEditorPage:
    """SQL Editor page controller with Metabase-style layout."""

    def __init__(self):
        self.query_id: str | None = None
        self.query_name: str = "New Question"
        self.current_connection: str | None = None
        self.query_result = None
        self.result_df: pd.DataFrame | None = None
        self.editor: SQLEditorWidget | None = None
        self._selected_view = "table"  # "table" or "visualization"
        self._selected_chart_type = "bar"
        self._chart_config = {}
        self._initial_sql: str = "-- Write your SQL query here\nSELECT * FROM your_table LIMIT 100;"
        self._is_saved_query: bool = False  # True if loading a saved query
        self._editor_expansion = None
        self._loading_container = None
        
        # UI references
        self._connection_select = None
        self._results_container = None
        self._viz_container = None
        self._viz_options_container = None
        self._bottom_bar = None
        self._query_name_input = None
        self._header = None
        self._sidebar = None
        self._row_count_label = None
        self._timing_label = None

    async def render(self) -> None:
        """Render the SQL editor page with Metabase layout."""
        # Check for query_id in URL params
        query_id = ui.context.client.request.query_params.get("query_id")
        if query_id:
            # Load query data (async)
            await self._load_query(query_id)
            self._is_saved_query = True
        
        # Create Metabase-style sidebar (top-level)
        self._sidebar = MetabaseSidebar(on_query_select=self._on_query_selected)
        self._sidebar.create()
        
        # Create custom header for SQL editor (top-level)
        self._create_editor_header()
        
        # Create bottom bar (top-level - must be before content for NiceGUI)
        self._create_bottom_bar()
        
        # Main content area
        with ui.column().classes("w-full bg-gray-50").style("min-height: calc(100vh - 120px); padding-bottom: 60px;"):
            # Editor section (collapsible) - collapsed if loading saved query
            self._editor_expansion = ui.expansion(
                "SQL Editor", 
                icon="code", 
                value=not self._is_saved_query  # Collapsed if saved query
            ).classes("w-full bg-white").props("dense")
            
            with self._editor_expansion:
                self._create_editor_section()
            
            # Loading indicator (shown when running query)
            self._loading_container = ui.column().classes("w-full items-center justify-center p-8")
            with self._loading_container:
                self._loading_container.set_visibility(False)
                ui.spinner("dots", size="xl").classes("text-blue-500")
                ui.label("Running query...").classes("text-gray-500 mt-2")
            
            # Results/Visualization area (main content)
            with ui.column().classes("flex-grow w-full overflow-hidden"):
                self._results_container = ui.column().classes("w-full h-full p-4")
                with self._results_container:
                    if self._is_saved_query:
                        # Show loading state initially
                        with ui.column().classes("w-full h-full items-center justify-center"):
                            ui.spinner("dots", size="xl").classes("text-blue-500")
                            ui.label("Loading query results...").classes("text-gray-500 mt-2")
                    else:
                        self._show_empty_state()
        
        # Auto-run query if loading a saved query
        if self._is_saved_query and self.current_connection:
            # Schedule the query to run after UI is ready
            async def run_saved_query():
                await self._auto_run_query()
            ui.timer(0.5, run_saved_query, once=True)

    def _create_editor_header(self) -> None:
        """Create the custom header for the SQL editor."""
        with ui.header().classes("bg-white border-b border-gray-200 shadow-sm"):
            with ui.row().classes("w-full items-center px-4 py-2 gap-3"):
                # Hamburger menu
                ui.button(
                    icon="menu",
                    on_click=lambda: self._sidebar.toggle() if self._sidebar else None,
                ).props("flat round dense").classes("text-gray-600")
                
                # Logo
                with ui.link(target="/").classes("no-underline"):
                    ui.icon("analytics", size="md").classes("text-blue-500")
                
                # Back button
                ui.button(
                    icon="arrow_back",
                    on_click=lambda: ui.navigate.to("/"),
                ).props("flat round dense").classes("text-gray-600")
                
                # Query name (editable)
                self._query_name_input = ui.input(
                    value=self.query_name,
                    on_change=lambda e: self._update_query_name(e.value),
                ).props("dense borderless").classes(
                    "text-lg font-semibold"
                ).style("min-width: 200px; font-size: 18px;")
                
                # Connection selector as chip
                conn_options = self._get_connection_options()
                if conn_options:
                    first_conn = list(conn_options.keys())[0] if conn_options else None
                    # Set current connection if not already set
                    if not self.current_connection:
                        self.current_connection = first_conn
                    with ui.row().classes("items-center gap-2 ml-4 px-3 py-1 bg-blue-50 rounded-full"):
                        ui.icon("storage", size="xs").classes("text-blue-500")
                        self._connection_select = ui.select(
                            options=conn_options,
                            value=self.current_connection,
                            on_change=self._on_connection_change,
                        ).props("dense borderless").classes("text-sm").style(
                            "min-width: 120px"
                        )
                else:
                    with ui.link(target="/connections").classes("no-underline"):
                        with ui.row().classes(
                            "items-center gap-2 ml-4 px-3 py-1 bg-orange-50 rounded-full cursor-pointer"
                        ):
                            ui.icon("warning", size="xs").classes("text-orange-500")
                            ui.label("Add a connection").classes("text-sm text-orange-600")
                
                ui.space()
                
                # Search
                ui.input(placeholder="Search...").props("dense outlined").classes(
                    "w-64"
                ).style("font-size: 13px")
                
                ui.space()
                
                # Action buttons
                with ui.row().classes("items-center gap-2"):
                    # Save button
                    ui.button(
                        "Save",
                        icon="save",
                        on_click=self._save_query_dialog,
                    ).props("flat").classes("text-gray-600")
                    
                    # Bookmark
                    ui.button(
                        icon="bookmark_border",
                    ).props("flat round").classes("text-gray-600")
                    
                    # Share
                    ui.button(
                        icon="share",
                    ).props("flat round").classes("text-gray-600")
                    
                    # More options
                    with ui.button(icon="more_vert").props("flat round").classes("text-gray-600"):
                        with ui.menu():
                            ui.menu_item("Duplicate", lambda: ui.notify("Duplicate coming soon"))
                            ui.menu_item("Move to collection", lambda: ui.notify("Move coming soon"))
                            ui.separator()
                            ui.menu_item(
                                "Delete",
                                lambda: self._delete_query() if self.query_id else ui.notify("Query not saved yet"),
                            )
                    
                    # + New button
                    with ui.button("New", icon="add").props("color=primary"):
                        with ui.menu():
                            ui.menu_item("Question", lambda: ui.navigate.to("/query-builder"))
                            ui.menu_item("SQL Query", lambda: ui.navigate.to("/sql"))
                            ui.menu_item("Dashboard", lambda: ui.navigate.to("/dashboards"))
                    
                    # Settings
                    ui.button(
                        icon="settings",
                        on_click=lambda: ui.navigate.to("/admin"),
                    ).props("flat round").classes("text-gray-600")

    def _create_editor_section(self) -> None:
        """Create the SQL editor section."""
        with ui.column().classes("w-full p-4 gap-2"):
            # SQL Editor - use _initial_sql which may have been set by _load_query
            self.editor = SQLEditorWidget(
                value=self._initial_sql,
                on_run=self._run_query,
            )
            self.editor.create()

    def _create_bottom_bar(self) -> None:
        """Create the Metabase-style bottom bar."""
        with ui.footer().classes("bg-white border-t border-gray-200 px-4 py-2"):
            with ui.row().classes("w-full items-center justify-between"):
                # Left - Visualization button
                with ui.row().classes("items-center gap-2"):
                    ui.button(
                        "Visualization",
                        icon="settings",
                        on_click=self._toggle_viz_options,
                    ).props("flat").classes(
                        "text-blue-500 border border-blue-200 rounded-full px-4"
                    )
                
                # Center - View toggle (table/chart)
                with ui.row().classes("items-center gap-1 bg-gray-100 rounded-lg p-1"):
                    ui.button(
                        icon="table_chart",
                        on_click=lambda: self._set_view("table"),
                    ).props(
                        f"{'color=primary' if self._selected_view == 'table' else 'flat'} round dense"
                    ).classes("" if self._selected_view == "table" else "text-gray-500")
                    
                    ui.button(
                        icon="bar_chart",
                        on_click=lambda: self._set_view("visualization"),
                    ).props(
                        f"{'color=primary' if self._selected_view == 'visualization' else 'flat'} round dense"
                    ).classes("" if self._selected_view == "visualization" else "text-gray-500")
                
                # Right - Row count and timing
                with ui.row().classes("items-center gap-4 text-sm text-gray-500"):
                    self._row_count_label = ui.label("No results")
                    self._timing_label = ui.label("")
                    
                    # Export buttons
                    ui.button(icon="download").props("flat round dense").classes(
                        "text-gray-400"
                    ).tooltip("Download results")
                    ui.button(icon="fullscreen").props("flat round dense").classes(
                        "text-gray-400"
                    ).tooltip("Fullscreen")

    def _show_empty_state(self) -> None:
        """Show empty state when no query has been run."""
        with ui.column().classes("w-full h-full items-center justify-center"):
            ui.icon("query_stats", size="xl").classes("text-gray-300 mb-4")
            ui.label("Run a query to see results").classes("text-gray-400 text-lg")
            ui.label("Write SQL and click Run or press Ctrl+Enter").classes(
                "text-gray-300 text-sm"
            )

    async def _auto_run_query(self) -> None:
        """Auto-run the query when loading a saved query."""
        if self._initial_sql and self.current_connection:
            await self._run_query(self._initial_sql)

    def _get_connection_options(self) -> dict:
        """Get connection options for the selector."""
        connections = get_connections()
        if not connections:
            return {}
        return {conn["id"]: conn["name"] for conn in connections}

    def _on_connection_change(self, e) -> None:
        """Handle connection selection change."""
        self.current_connection = e.value

    def _update_query_name(self, name: str) -> None:
        """Update the query name."""
        self.query_name = name

    async def _load_query(self, query_id: str) -> None:
        """Load a saved query from database."""
        query = await get_query_by_id(query_id)
        if query:
            self.query_id = query["id"]
            self.query_name = query["name"]
            self.current_connection = query.get("connection_id")
            self._initial_sql = query.get("sql", self._initial_sql)
            # Update UI elements if they exist (for live updates)
            if self.editor:
                self.editor.set_value(self._initial_sql)
            if self._query_name_input:
                self._query_name_input.value = query["name"]
            if self._connection_select and self.current_connection:
                self._connection_select.value = self.current_connection

    def _on_query_selected(self, query: dict) -> None:
        """Handle query selection from sidebar."""
        # Navigate to SQL editor with query ID - it will load async
        ui.navigate.to(f"/sql?query_id={query['id']}")

    def _save_query_dialog(self) -> None:
        """Show save query dialog."""
        with ui.dialog() as dialog, ui.card().classes("w-96"):
            ui.label("Save Question").classes("text-lg font-semibold mb-4")
            
            name_input = ui.input(
                label="Name",
                value=self.query_name,
            ).classes("w-full")
            
            # Folder selection (simplified)
            folder_select = ui.select(
                label="Save to",
                options={"1": "My Queries"},
                value="1",
            ).classes("w-full")
            
            async def do_save():
                await self._do_save_query(name_input.value, folder_select.value, dialog)
            
            with ui.row().classes("justify-end gap-2 mt-4"):
                ui.button("Cancel", on_click=dialog.close).props("flat")
                ui.button("Save", on_click=do_save).props("color=primary")
        
        dialog.open()

    async def _do_save_query(self, name: str, folder_id: str, dialog) -> None:
        """Actually save the query to database."""
        if not name:
            ui.notify("Please enter a name", type="warning")
            return
        
        sql = self.editor.get_value() if self.editor else ""
        if not sql.strip():
            ui.notify("Please enter a SQL query", type="warning")
            return
        
        saved = await save_query(
            name=name,
            sql=sql,
            connection_id=self.current_connection or "",
            folder_id=folder_id,
            query_id=self.query_id,
        )
        
        self.query_id = saved["id"]
        self.query_name = name
        if self._query_name_input:
            self._query_name_input.value = name
        
        ui.notify(f"Saved '{name}'", type="positive")
        dialog.close()

    def _delete_query(self) -> None:
        """Delete the current query."""
        if not self.query_id:
            return
        
        with ui.dialog() as dialog, ui.card():
            ui.label(f"Delete '{self.query_name}'?").classes("text-lg font-semibold")
            ui.label("This action cannot be undone.").classes("text-gray-500")
            
            async def do_delete():
                await self._do_delete_query(dialog)
            
            with ui.row().classes("justify-end gap-2 mt-4"):
                ui.button("Cancel", on_click=dialog.close).props("flat")
                ui.button("Delete", on_click=do_delete).props("color=negative")
        
        dialog.open()

    async def _do_delete_query(self, dialog) -> None:
        """Actually delete the query from database."""
        await delete_query(self.query_id)
        ui.notify(f"Deleted '{self.query_name}'", type="info")
        dialog.close()
        ui.navigate.to("/sql")
        ui.navigate.to("/sql")

    def _set_view(self, view: str) -> None:
        """Set the current view mode."""
        self._selected_view = view
        self._render_results()

    def _toggle_viz_options(self) -> None:
        """Toggle visualization options panel."""
        if self.result_df is None or self.result_df.empty:
            ui.notify("Run a query first to configure visualization", type="info")
            return
        self._show_viz_options_dialog()

    def _show_viz_options_dialog(self) -> None:
        """Show visualization options dialog."""
        if self.result_df is None:
            return
        
        analysis = self._analyze_columns(self.result_df)
        suitable_charts = self._get_suitable_chart_types(analysis)
        
        with ui.dialog() as dialog, ui.card().classes("w-[600px]"):
            ui.label("Visualization Settings").classes("text-lg font-semibold mb-4")
            
            with ui.row().classes("w-full gap-4"):
                # Left - Chart type selection
                with ui.column().classes("w-1/2"):
                    ui.label("Chart Type").classes("font-medium text-sm text-gray-600 mb-2")
                    
                    # Group by category
                    categories = {}
                    for chart in suitable_charts:
                        cat = chart.get("category", "Other")
                        if cat not in categories:
                            categories[cat] = []
                        categories[cat].append(chart)
                    
                    with ui.scroll_area().style("max-height: 300px"):
                        for category, charts in categories.items():
                            ui.label(category).classes("text-xs text-gray-400 mt-2 mb-1")
                            with ui.column().classes("gap-1"):
                                for chart in charts:
                                    is_selected = chart["id"] == self._selected_chart_type
                                    with ui.row().classes(
                                        f"items-center gap-2 px-2 py-1 rounded cursor-pointer "
                                        f"{'bg-blue-50 border border-blue-200' if is_selected else 'hover:bg-gray-100'}"
                                    ).on("click", lambda c=chart["id"]: self._select_chart_type(c, dialog)):
                                        ui.icon(chart["icon"], size="sm").classes(
                                            "text-blue-500" if is_selected else "text-gray-400"
                                        )
                                        ui.label(chart["name"]).classes(
                                            "text-sm " + ("text-blue-700" if is_selected else "text-gray-700")
                                        )
                
                # Right - Column mapping
                with ui.column().classes("w-1/2"):
                    ui.label("Data Mapping").classes("font-medium text-sm text-gray-600 mb-2")
                    self._render_column_mapping_dialog(analysis)
            
            with ui.row().classes("justify-end gap-2 mt-4"):
                ui.button("Cancel", on_click=dialog.close).props("flat")
                ui.button(
                    "Done",
                    on_click=lambda: self._apply_viz_settings(dialog),
                ).props("color=primary")
        
        dialog.open()

    def _select_chart_type(self, chart_type: str, dialog=None) -> None:
        """Select a chart type."""
        self._selected_chart_type = chart_type
        self._chart_config = {}  # Reset config
        if dialog:
            dialog.close()
            self._show_viz_options_dialog()  # Reopen with new selection

    def _render_column_mapping_dialog(self, analysis: dict) -> None:
        """Render column mapping options in dialog."""
        all_cols = analysis["all_cols"]
        numeric_cols = analysis["numeric_cols"]
        categorical_cols = analysis["categorical_cols"]
        chart_type = self._selected_chart_type
        
        with ui.column().classes("w-full gap-3"):
            if chart_type in ["bar", "line", "area", "scatter", "histogram"]:
                x_options = {c: c for c in all_cols}
                ui.select(
                    label="X-Axis",
                    options=x_options,
                    value=self._chart_config.get("x", all_cols[0] if all_cols else None),
                    on_change=lambda e: self._update_chart_config("x", e.value),
                ).classes("w-full").props("dense")
            
            if chart_type in ["bar", "line", "area", "scatter"]:
                y_options = {c: c for c in numeric_cols} if numeric_cols else {c: c for c in all_cols}
                ui.select(
                    label="Y-Axis",
                    options=y_options,
                    value=self._chart_config.get("y", numeric_cols[0] if numeric_cols else None),
                    on_change=lambda e: self._update_chart_config("y", e.value),
                ).classes("w-full").props("dense")
            
            if chart_type in ["pie", "donut", "funnel", "treemap"]:
                label_options = {c: c for c in categorical_cols} if categorical_cols else {c: c for c in all_cols}
                value_options = {c: c for c in numeric_cols} if numeric_cols else {c: c for c in all_cols}
                
                ui.select(
                    label="Labels",
                    options=label_options,
                    value=self._chart_config.get("labels"),
                    on_change=lambda e: self._update_chart_config("labels", e.value),
                ).classes("w-full").props("dense")
                
                ui.select(
                    label="Values",
                    options=value_options,
                    value=self._chart_config.get("values"),
                    on_change=lambda e: self._update_chart_config("values", e.value),
                ).classes("w-full").props("dense")
            
            if chart_type in ["bar", "line", "scatter"]:
                color_options = {"": "(none)"} | {c: c for c in categorical_cols}
                ui.select(
                    label="Color/Group By",
                    options=color_options,
                    value=self._chart_config.get("color", ""),
                    on_change=lambda e: self._update_chart_config("color", e.value),
                ).classes("w-full").props("dense")
            
            ui.input(
                label="Chart Title",
                value=self._chart_config.get("title", ""),
                on_change=lambda e: self._update_chart_config("title", e.value),
            ).classes("w-full").props("dense")

    def _update_chart_config(self, key: str, value) -> None:
        """Update chart configuration."""
        self._chart_config[key] = value

    def _apply_viz_settings(self, dialog) -> None:
        """Apply visualization settings and render."""
        self._selected_view = "visualization"
        self._render_results()
        dialog.close()

    def _analyze_columns(self, df: pd.DataFrame) -> dict:
        """Analyze DataFrame columns to determine suitable chart types."""
        analysis = {
            "numeric_cols": [],
            "categorical_cols": [],
            "datetime_cols": [],
            "all_cols": list(df.columns),
        }
        
        for col in df.columns:
            dtype = df[col].dtype
            if pd.api.types.is_numeric_dtype(dtype):
                analysis["numeric_cols"].append(col)
            elif pd.api.types.is_datetime64_any_dtype(dtype):
                analysis["datetime_cols"].append(col)
            else:
                try:
                    if df[col].dtype == object and len(df) > 0:
                        pd.to_datetime(df[col].iloc[0])
                        analysis["datetime_cols"].append(col)
                        continue
                except:
                    pass
                analysis["categorical_cols"].append(col)
        
        return analysis

    def _get_suitable_chart_types(self, analysis: dict) -> list[dict]:
        """Get chart types suitable for the data."""
        charts = []
        
        has_numeric = len(analysis["numeric_cols"]) > 0
        has_categorical = len(analysis["categorical_cols"]) > 0
        has_datetime = len(analysis["datetime_cols"]) > 0
        has_multiple_numeric = len(analysis["numeric_cols"]) >= 2
        
        charts.append({"id": "table", "name": "Table", "icon": "table_chart", "category": "Basic"})
        
        if has_numeric:
            charts.append({"id": "bar", "name": "Bar Chart", "icon": "bar_chart", "category": "Basic"})
            charts.append({"id": "line", "name": "Line Chart", "icon": "show_chart", "category": "Basic"})
            charts.append({"id": "area", "name": "Area Chart", "icon": "area_chart", "category": "Basic"})
        
        if has_categorical and has_numeric:
            charts.append({"id": "pie", "name": "Pie Chart", "icon": "pie_chart", "category": "Part-to-Whole"})
            charts.append({"id": "donut", "name": "Donut Chart", "icon": "donut_large", "category": "Part-to-Whole"})
            charts.append({"id": "funnel", "name": "Funnel", "icon": "filter_alt", "category": "Part-to-Whole"})
            charts.append({"id": "treemap", "name": "Treemap", "icon": "grid_view", "category": "Part-to-Whole"})
        
        if has_multiple_numeric:
            charts.append({"id": "scatter", "name": "Scatter Plot", "icon": "scatter_plot", "category": "Correlation"})
            charts.append({"id": "bubble", "name": "Bubble Chart", "icon": "bubble_chart", "category": "Correlation"})
        
        if has_numeric:
            charts.append({"id": "histogram", "name": "Histogram", "icon": "equalizer", "category": "Distribution"})
            charts.append({"id": "box", "name": "Box Plot", "icon": "candlestick_chart", "category": "Distribution"})
        
        if has_datetime and has_numeric:
            charts.append({"id": "timeseries", "name": "Time Series", "icon": "timeline", "category": "Trend"})
        
        if has_multiple_numeric:
            charts.append({"id": "heatmap", "name": "Heatmap", "icon": "grid_on", "category": "Correlation"})
        
        if has_numeric:
            charts.append({"id": "gauge", "name": "Gauge", "icon": "speed", "category": "KPI"})
            charts.append({"id": "indicator", "name": "Number/KPI", "icon": "analytics", "category": "KPI"})
        
        return charts

    def _render_results(self) -> None:
        """Render the results area based on current view."""
        self._results_container.clear()
        
        if self.result_df is None or self.result_df.empty:
            with self._results_container:
                self._show_empty_state()
            return
        
        with self._results_container:
            if self._selected_view == "table":
                self._render_table()
            else:
                self._render_chart()

    def _render_table(self) -> None:
        """Render results as a table."""
        columns = [{"name": c, "label": c, "field": c, "sortable": True} for c in self.result_df.columns]
        rows = [
            {col: serialize_value(val) for col, val in row.items()}
            for row in self.result_df.to_dict("records")
        ]
        
        ui.table(
            columns=columns,
            rows=rows,
            pagination={"rowsPerPage": 50},
        ).classes("w-full")

    def _render_chart(self) -> None:
        """Render the selected visualization."""
        if self._selected_chart_type == "table":
            self._render_table()
            return
        
        try:
            from nicemeta.visualization import ChartConfig, ChartFactory
            
            config = ChartConfig(
                chart_type=self._selected_chart_type,
                title=self._chart_config.get("title", ""),
                x=self._chart_config.get("x"),
                y=self._chart_config.get("y"),
                labels=self._chart_config.get("labels"),
                values=self._chart_config.get("values"),
                color=self._chart_config.get("color") or None,
                width=800,
                height=500,
            )
            
            html = ChartFactory.render_to_html(self.result_df, config)
            ui.html(html).classes("w-full")
            
        except Exception as e:
            with ui.card().classes("w-full bg-yellow-50 p-4"):
                ui.label("Chart Error").classes("font-semibold text-yellow-700")
                ui.label(str(e)).classes("text-yellow-600 text-sm mt-1")

    async def _run_query(self, sql: str) -> None:
        """Execute the SQL query."""
        if not self.current_connection:
            ui.notify("Please select a connection first", type="warning")
            return
        
        if not sql.strip():
            ui.notify("Please enter a SQL query", type="warning")
            return
        
        connections = get_connections()
        conn = next((c for c in connections if c["id"] == self.current_connection), None)
        if not conn:
            ui.notify("Connection not found", type="negative")
            return
        
        # Show loading state
        if self._loading_container:
            self._loading_container.set_visibility(True)
        self._results_container.clear()
        
        ui.notify(f"Executing query...", type="info")
        
        try:
            from nicemeta.connections.manager import ConnectionManager
            from nicemeta.config.connections import ConnectionConfig
            
            config = ConnectionConfig(
                name=conn["name"],
                type=conn["db_type"],
                host=conn["host"],
                port=conn["port"],
                database=conn["database"],
                user=conn.get("user", ""),
                password=conn.get("password", ""),
            )
            
            manager = ConnectionManager()
            adapter = manager.create_adapter(config)
            result = await adapter.execute_query(sql, limit=1000)
            
            # Hide loading state
            if self._loading_container:
                self._loading_container.set_visibility(False)
            
            if result.error:
                ui.notify(f"Query error: {result.error}", type="negative")
                self.result_df = None
            else:
                self.result_df = result.to_dataframe()
                
                # Update bottom bar stats
                if self._row_count_label:
                    self._row_count_label.text = f"Showing {result.row_count} rows"
                if self._timing_label:
                    self._timing_label.text = f"⚡ {result.execution_time_ms:.0f}ms"
                
                ui.notify(f"✓ {result.row_count} rows returned", type="positive")
            
            self._render_results()
            
        except Exception as e:
            # Hide loading state on error
            if self._loading_container:
                self._loading_container.set_visibility(False)
            ui.notify(f"Error: {str(e)}", type="negative")
            self.result_df = None
            self._render_results()


async def sql_editor_page() -> None:
    """Entry point for SQL editor page."""
    page = SQLEditorPage()
    await page.render()
