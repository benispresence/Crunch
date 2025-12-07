"""
Query Builder page for NiceMeta.
"""

from nicegui import ui

from nicemeta.ui.components.sidebar import MetabaseHeader, MetabaseSidebar
from nicemeta.ui.components.query_builder_widget import QueryBuilderWidget
from nicemeta.ui.components.chart_widget import ChartWidget


class QueryBuilderPage:
    """Query Builder page controller."""

    def __init__(self):
        self.current_connection: str | None = None
        self.builder: QueryBuilderWidget | None = None
        self.generated_sql: str = ""

    async def render(self) -> None:
        """Render the query builder page."""
        sidebar = MetabaseSidebar()
        sidebar.create()
        
        header = MetabaseHeader(sidebar=sidebar, title="New Question", show_back=True)
        header.create()
        
        with ui.splitter(value=50).classes("w-full h-full") as splitter:
            # Left panel - Builder
            with splitter.before:
                with ui.column().classes("w-full h-full p-4 gap-4"):
                    # Connection selector
                    with ui.row().classes("items-center gap-4 w-full"):
                        ui.select(
                            label="Connection",
                            options=["No connections available"],
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
                    
                    # Query Builder Widget
                    # Placeholder tables - in production, load from connection
                    sample_tables = [
                        {
                            "name": "users",
                            "schema": "public",
                            "columns": [
                                {"name": "id", "type": "integer"},
                                {"name": "email", "type": "varchar"},
                                {"name": "name", "type": "varchar"},
                                {"name": "created_at", "type": "timestamp"},
                            ],
                        },
                        {
                            "name": "orders",
                            "schema": "public",
                            "columns": [
                                {"name": "id", "type": "integer"},
                                {"name": "user_id", "type": "integer"},
                                {"name": "total", "type": "decimal"},
                                {"name": "status", "type": "varchar"},
                                {"name": "created_at", "type": "timestamp"},
                            ],
                        },
                    ]
                    
                    self.builder = QueryBuilderWidget(
                        tables=sample_tables,
                        on_query_change=self._on_query_change,
                    )
                    
                    with ui.scroll_area().classes("w-full flex-grow"):
                        self.builder.create()
            
            # Right panel - Results & Visualization
            with splitter.after:
                with ui.column().classes("w-full h-full p-4 gap-4"):
                    # Tabs for Results / Visualization
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

    def _on_connection_change(self, e) -> None:
        """Handle connection selection change."""
        self.current_connection = e.value
        # In production, load tables from the connection

    def _on_query_change(self, sql: str, visual_query) -> None:
        """Handle query builder changes."""
        self.generated_sql = sql

    async def _run_query(self) -> None:
        """Execute the generated query."""
        if not self.builder:
            return
        
        sql = self.builder.get_sql()
        if not sql:
            ui.notify("Build a query first", type="warning")
            return
        
        if not self.current_connection:
            ui.notify("Please select a connection first", type="warning")
            return
        
        ui.notify("Executing query...", type="info")
        
        # In production, execute via QueryExecutor
        self._results_container.clear()
        with self._results_container:
            with ui.card().classes("w-full"):
                ui.label("Query executed").classes("font-semibold")
                ui.code(sql, language="sql").classes("w-full")

    def _open_in_sql_editor(self) -> None:
        """Open the generated SQL in the SQL editor."""
        if not self.builder:
            return
        
        sql = self.builder.get_sql()
        # In production, pass the SQL to the SQL editor page
        ui.navigate.to("/sql")
        ui.notify("SQL copied to editor")


async def query_builder_page() -> None:
    """Entry point for query builder page."""
    page = QueryBuilderPage()
    await page.render()

