"""
Query Builder page for NiceMeta.
"""

import pandas as pd
from nicegui import ui

from nicemeta.ui.components.sidebar import (
    MetabaseHeader,
    MetabaseSidebar,
    get_connections,
    get_connection_by_id,
    refresh_cache,
)
from nicemeta.ui.components.query_builder_widget import QueryBuilderWidget
from nicemeta.ui.components.chart_widget import ChartWidget
from nicemeta.ui.components.sql_editor_widget import serialize_value


class QueryBuilderPage:
    """Query Builder page controller."""

    def __init__(self):
        self.current_connection: str | None = None
        self.builder: QueryBuilderWidget | None = None
        self.generated_sql: str = ""
        self._connection_select = None
        self._builder_container = None
        self._results_container = None
        self._viz_container = None
        self.result_df: pd.DataFrame | None = None

    async def render(self) -> None:
        """Render the query builder page."""
        await refresh_cache()

        sidebar = MetabaseSidebar()
        sidebar.create()

        header = MetabaseHeader(sidebar=sidebar, title="New Question", show_back=True)
        header.create()

        # Build connection options
        connections = get_connections()
        conn_options = {c["id"]: c["name"] for c in connections} if connections else {}

        with ui.splitter(value=50).classes("w-full h-full") as splitter:
            # Left panel - Builder
            with splitter.before:
                with ui.column().classes("w-full h-full p-4 gap-4"):
                    # Connection selector
                    with ui.row().classes("items-center gap-4 w-full"):
                        self._connection_select = ui.select(
                            label="Connection",
                            options=conn_options if conn_options else {"": "No connections"},
                            value=self.current_connection,
                            on_change=self._on_connection_change,
                        ).classes("w-64")

                        ui.button(
                            "Run Query",
                            icon="play_arrow",
                            on_click=self._run_query,
                        ).props("color=primary")

                        ui.button(
                            "Open in SQL Editor",
                            icon="code",
                            on_click=self._open_in_sql_editor,
                        ).props("flat")

                    # Builder container (refreshed when connection changes)
                    self._builder_container = ui.column().classes("w-full flex-grow")
                    with self._builder_container:
                        ui.label("Select a connection to load tables").classes(
                            "text-gray-400 p-4"
                        )

            # Right panel - Results & Visualization
            with splitter.after:
                with ui.column().classes("w-full h-full p-4 gap-4"):
                    with ui.tabs().classes("w-full") as tabs:
                        results_tab = ui.tab("Results", icon="table_chart")
                        viz_tab = ui.tab("Visualization", icon="bar_chart")

                    with ui.tab_panels(tabs, value=results_tab).classes("w-full flex-grow"):
                        with ui.tab_panel(results_tab):
                            self._results_container = ui.column().classes("w-full")
                            with self._results_container:
                                ui.label("Build a query and click Run").classes(
                                    "text-gray-400 p-4"
                                )

                        with ui.tab_panel(viz_tab):
                            self._viz_container = ui.column().classes("w-full")
                            with self._viz_container:
                                ui.label("Run a query to create visualizations").classes(
                                    "text-gray-400 p-4"
                                )

    async def _on_connection_change(self, e) -> None:
        """Handle connection change: load real tables from the selected connection."""
        self.current_connection = e.value
        if not self.current_connection:
            return

        conn = await get_connection_by_id(self.current_connection)
        if not conn:
            ui.notify("Connection not found", type="negative")
            return

        try:
            from nicemeta.connections.manager import ConnectionManager
            from nicemeta.ui.helpers import connection_config_from_dict

            config = connection_config_from_dict(conn)

            manager = ConnectionManager()
            adapter = manager.create_adapter(config)
            table_infos = await adapter.get_tables()

            # Load columns for each table
            tables = []
            for ti in table_infos:
                cols = await adapter.get_columns(ti.name, ti.schema)
                tables.append({
                    "name": ti.name,
                    "schema": ti.schema or "",
                    "columns": [
                        {"name": c.name, "type": c.data_type}
                        for c in cols
                    ],
                })

            # Rebuild builder widget with real tables
            self._builder_container.clear()
            with self._builder_container:
                self.builder = QueryBuilderWidget(
                    tables=tables,
                    on_query_change=self._on_query_change,
                )
                with ui.scroll_area().classes("w-full flex-grow"):
                    self.builder.create()

            ui.notify(f"Loaded {len(tables)} tables", type="positive")

        except Exception as ex:
            ui.notify(f"Error loading tables: {ex}", type="negative")

    def _on_query_change(self, sql: str, visual_query) -> None:
        """Handle query builder changes."""
        self.generated_sql = sql

    async def _run_query(self) -> None:
        """Execute the generated query against the selected connection."""
        if not self.builder:
            ui.notify("Load tables by selecting a connection first", type="warning")
            return

        sql = self.builder.get_sql()
        if not sql:
            ui.notify("Build a query first", type="warning")
            return

        if not self.current_connection:
            ui.notify("Please select a connection first", type="warning")
            return

        conn = await get_connection_by_id(self.current_connection)
        if not conn:
            ui.notify("Connection not found", type="negative")
            return

        ui.notify("Executing query...", type="info")

        try:
            from nicemeta.connections.manager import ConnectionManager
            from nicemeta.ui.helpers import connection_config_from_dict

            config = connection_config_from_dict(conn)

            manager = ConnectionManager()
            adapter = manager.create_adapter(config)
            result = await adapter.execute_query(sql, limit=1000)

            self._results_container.clear()
            with self._results_container:
                if result.error:
                    ui.label(f"Error: {result.error}").classes("text-red-500 p-4")
                else:
                    self.result_df = result.to_dataframe()
                    columns = [
                        {"name": c, "label": c, "field": c, "sortable": True}
                        for c in self.result_df.columns
                    ]
                    rows = [
                        {col: serialize_value(val) for col, val in row.items()}
                        for row in self.result_df.to_dict("records")
                    ]
                    ui.table(
                        columns=columns,
                        rows=rows,
                        pagination={"rowsPerPage": 50},
                    ).classes("w-full")
                    ui.label(f"{result.row_count} rows returned").classes(
                        "text-sm text-gray-500 mt-2"
                    )

        except Exception as ex:
            self._results_container.clear()
            with self._results_container:
                ui.label(f"Error: {ex}").classes("text-red-500 p-4")

    def _open_in_sql_editor(self) -> None:
        """Open the generated SQL in the SQL editor."""
        if not self.builder:
            return
        sql = self.builder.get_sql()
        if sql:
            # Store in user storage so SQL editor can pick it up
            from nicegui import app
            app.storage.user["_nm_sql_transfer"] = sql
        ui.navigate.to("/sql")


async def query_builder_page() -> None:
    """Entry point for query builder page."""
    page = QueryBuilderPage()
    await page.render()

