"""
Dashboard page for NiceMeta - Full featured dashboard builder.
"""

import pandas as pd
from nicegui import ui

from nicemeta.ui.components.sidebar import (
    MetabaseHeader,
    MetabaseSidebar,
    get_saved_queries,
    get_saved_dashboards,
    get_dashboard_by_id,
    create_dashboard,
    delete_dashboard,
    get_connections,
    refresh_cache,
)
from nicemeta.services.dashboard_service import (
    DashboardService,
    add_widget_to_dashboard,
    update_widget_position,
    remove_widget,
)
from nicemeta.services.visualization_service import get_visualization_by_query_id
from nicemeta.ui.components.sql_editor_widget import serialize_value


class DashboardPage:
    """Dashboard page controller."""

    def __init__(self, dashboard_id: str | None = None):
        self.dashboard_id = dashboard_id
        self.dashboard: dict | None = None
        self.is_editing = False
        self.widgets: list[dict] = []
        self._sidebar = None
        self._grid_container = None
        self._widgets_container = None
        self._header = None

    async def render(self) -> None:
        """Render the dashboard page."""
        await refresh_cache()
        
        self._sidebar = MetabaseSidebar()
        self._sidebar.create()
        
        if self.dashboard_id:
            # Load dashboard from database
            self.dashboard = await get_dashboard_by_id(self.dashboard_id)
            if self.dashboard:
                self.widgets = self.dashboard.get("widgets", [])
                await self._render_dashboard_view()
            else:
                ui.notify("Dashboard not found", type="negative")
                ui.navigate.to("/dashboards")
        else:
            await self._render_dashboard_list()

    async def _render_dashboard_list(self) -> None:
        """Render the dashboard list view."""
        self._header = MetabaseHeader(sidebar=self._sidebar, title="Dashboards")
        self._header.create()
        
        with ui.column().classes("w-full p-6 gap-6 bg-gray-50 min-h-screen"):
            # Header with actions
            with ui.row().classes("items-center justify-between w-full"):
                ui.label("All Dashboards").classes("text-xl font-semibold text-gray-800")
                
                ui.button(
                    "New Dashboard",
                    icon="add",
                    on_click=self._create_dashboard_dialog,
                ).props("color=primary")
            
            # Dashboard grid
            dashboards = get_saved_dashboards()
            
            with ui.row().classes("gap-4 flex-wrap"):
                if dashboards:
                    for dashboard in dashboards:
                        self._dashboard_card(dashboard)
                
                # Empty state card
                with ui.card().classes(
                    "w-72 h-48 flex items-center justify-center cursor-pointer "
                    "border-2 border-dashed border-gray-300 hover:border-blue-400"
                ) as card:
                    card.on("click", self._create_dashboard_dialog)
                    with ui.column().classes("items-center gap-2 text-gray-400"):
                        ui.icon("add_circle_outline", size="xl")
                        ui.label("Create Dashboard")

    def _dashboard_card(self, dashboard: dict) -> None:
        """Create a dashboard preview card."""
        with ui.card().classes("w-72 cursor-pointer hover:shadow-lg transition-shadow") as card:
            card.on("click", lambda d=dashboard: ui.navigate.to(f"/dashboards/{d['id']}"))
            
            # Preview area
            with ui.element("div").classes(
                "h-32 bg-gradient-to-br from-purple-50 to-indigo-100 "
                "flex items-center justify-center relative"
            ):
                ui.icon("dashboard", size="xl").classes("text-purple-300")
                widget_count = dashboard.get("widget_count", 0)
                if widget_count > 0:
                    ui.badge(str(widget_count)).classes(
                        "absolute top-2 right-2"
                    ).props("color=purple")
            
            # Info
            with ui.column().classes("p-3 gap-1"):
                ui.label(dashboard["name"]).classes("font-semibold text-gray-800")
                if dashboard.get("description"):
                    ui.label(dashboard["description"]).classes("text-sm text-gray-500 truncate")
                updated = dashboard.get("updated_at", "")
                if updated:
                    ui.label(f"Updated {updated[:10]}").classes("text-xs text-gray-400")

    async def _render_dashboard_view(self) -> None:
        """Render a specific dashboard with editable grid."""
        self._header = MetabaseHeader(
            sidebar=self._sidebar, 
            title=self.dashboard["name"], 
            show_back=True
        )
        self._header.create()
        
        with ui.column().classes("w-full bg-gray-50 min-h-screen"):
            # Dashboard toolbar
            with ui.row().classes("items-center justify-between w-full px-4 py-3 bg-white border-b"):
                with ui.row().classes("items-center gap-2"):
                    ui.button(
                        icon="arrow_back",
                        on_click=lambda: ui.navigate.to("/dashboards"),
                    ).props("flat round")
                    ui.label(self.dashboard["name"]).classes("text-xl font-semibold text-gray-800")
                    if self.dashboard.get("description"):
                        ui.label(f"· {self.dashboard['description']}").classes(
                            "text-gray-400 ml-2"
                        )
                
                with ui.row().classes("gap-2"):
                    ui.button(
                        "Add Widget",
                        icon="add",
                        on_click=self._add_widget_dialog,
                    ).props("outlined")
                    
                    ui.button(
                        "Refresh",
                        icon="refresh",
                        on_click=self._refresh_dashboard,
                    ).props("flat")
                    
                    with ui.button(icon="more_vert").props("flat round"):
                        with ui.menu():
                            ui.menu_item("Rename", self._rename_dashboard)
                            ui.menu_item("Duplicate", self._duplicate_dashboard)
                            ui.separator()
                            ui.menu_item("Delete", self._delete_dashboard_dialog)
            
            # Dashboard grid container
            with ui.element("div").classes("p-4 w-full"):
                self._widgets_container = ui.element("div").classes(
                    "grid grid-cols-12 gap-4 min-h-[600px] auto-rows-[100px]"
                )
                
                with self._widgets_container:
                    if self.widgets:
                        for widget in self.widgets:
                            await self._render_widget(widget)
                    else:
                        # Empty state
                        with ui.element("div").classes(
                            "col-span-12 flex items-center justify-center h-[400px] "
                            "border-2 border-dashed border-gray-300 rounded-lg"
                        ):
                            with ui.column().classes("items-center gap-4"):
                                ui.icon("widgets", size="xl").classes("text-gray-300")
                                ui.label("No widgets yet").classes("text-lg text-gray-400")
                                ui.button(
                                    "Add your first widget",
                                    icon="add",
                                    on_click=self._add_widget_dialog,
                                ).props("color=primary")

    async def _render_widget(self, widget: dict) -> None:
        """Render a single widget in the grid."""
        pos_x = widget.get("position_x", 0)
        pos_y = widget.get("position_y", 0)
        width = widget.get("width", 6)
        height = widget.get("height", 4)
        
        # Get widget title
        title = widget.get("title_override") or ""
        if not title and widget.get("query"):
            title = widget["query"].get("name", "Untitled")
        if not title and widget.get("visualization"):
            title = widget["visualization"].get("name", "Untitled")
        
        chart_type = "table"
        if widget.get("visualization"):
            chart_type = widget["visualization"].get("chart_type", "table")
        
        with ui.card().classes(f"col-span-{width}").style(
            f"grid-row: span {height}; min-height: {height * 100}px;"
        ):
            # Widget header
            with ui.row().classes("items-center justify-between w-full mb-2"):
                ui.label(title).classes("font-semibold text-gray-700")
                with ui.row().classes("gap-1"):
                    ui.button(
                        icon="refresh",
                        on_click=lambda w=widget: self._refresh_widget(w),
                    ).props("flat round dense size=sm").classes("text-gray-400")
                    with ui.button(icon="more_vert").props("flat round dense size=sm").classes("text-gray-400"):
                        with ui.menu():
                            ui.menu_item("Edit", lambda w=widget: self._edit_widget(w))
                            ui.menu_item("Resize", lambda w=widget: self._resize_widget_dialog(w))
                            ui.separator()
                            ui.menu_item("Remove", lambda w=widget: self._remove_widget_dialog(w))
            
            # Widget content
            content_container = ui.element("div").classes(
                "flex-grow w-full overflow-auto"
            ).style("height: calc(100% - 40px);")
            
            with content_container:
                # Try to render actual data
                if widget.get("query"):
                    await self._render_widget_content(widget, chart_type)
                else:
                    # Placeholder
                    with ui.element("div").classes(
                        "w-full h-full bg-gray-50 rounded flex items-center justify-center"
                    ):
                        ui.label("No data").classes("text-gray-400")

    async def _render_widget_content(self, widget: dict, chart_type: str) -> None:
        """Render the actual widget content by running the query."""
        query = widget.get("query", {})
        sql = query.get("sql", "")
        connection_id = query.get("connection_id")
        
        if not sql or not connection_id:
            ui.label("Query or connection not configured").classes("text-gray-400 p-4")
            return
        
        # Get connection and run query
        connections = get_connections()
        conn = next((c for c in connections if c["id"] == connection_id), None)
        
        if not conn:
            ui.label("Connection not found").classes("text-red-400 p-4")
            return
        
        try:
            from nicemeta.connections.manager import ConnectionManager
            from nicemeta.config.connections import ConnectionConfig
            
            config = ConnectionConfig(
                name=conn["name"],
                type=conn["db_type"],
                host=conn["host"],
                port=conn["port"],
                database=conn["database"],
                user=conn.get("user", "") or conn.get("username", ""),
                password=conn.get("password", ""),
            )
            
            manager = ConnectionManager()
            adapter = manager.create_adapter(config)
            result = await adapter.execute_query(sql, limit=100)
            
            if result.error:
                ui.label(f"Error: {result.error}").classes("text-red-400 p-4")
                return
            
            df = result.to_dataframe()
            
            if chart_type == "table":
                # Render as table
                columns = [{"name": c, "label": c, "field": c} for c in df.columns]
                rows = [
                    {col: serialize_value(val) for col, val in row.items()}
                    for row in df.to_dict("records")
                ]
                ui.table(
                    columns=columns,
                    rows=rows,
                    pagination={"rowsPerPage": 10},
                ).classes("w-full").props("dense")
            else:
                # Render chart using plotly
                await self._render_chart(df, chart_type, widget.get("visualization", {}).get("config", {}))
                
        except Exception as e:
            ui.label(f"Error loading data: {str(e)}").classes("text-red-400 p-4 text-sm")

    async def _render_chart(self, df: pd.DataFrame, chart_type: str, config: dict) -> None:
        """Render a chart visualization."""
        try:
            from nicemeta.visualization import ChartConfig, ChartFactory
            
            # Auto-detect x and y columns
            x_col = config.get("x") or (df.columns[0] if len(df.columns) > 0 else None)
            y_col = config.get("y") or (df.columns[1] if len(df.columns) > 1 else df.columns[0] if len(df.columns) > 0 else None)
            
            chart_config = ChartConfig(
                chart_type=chart_type,
                x=x_col,
                y=y_col,
                title="",
                width=None,
                height=300,
            )
            
            html = ChartFactory.render_to_html(df, chart_config)
            ui.html(html, sanitize=False).classes("w-full")
        except Exception as e:
            ui.label(f"Chart error: {str(e)}").classes("text-red-400 text-sm")

    def _create_dashboard_dialog(self) -> None:
        """Create a new dashboard dialog."""
        with ui.dialog() as dialog, ui.card().classes("w-96"):
            ui.label("New Dashboard").classes("text-lg font-semibold")
            
            name_input = ui.input(label="Name", placeholder="My Dashboard").classes("w-full")
            desc_input = ui.textarea(
                label="Description",
                placeholder="Dashboard description...",
            ).classes("w-full")
            
            async def do_create():
                await self._do_create_dashboard(name_input.value, desc_input.value, dialog)
            
            with ui.row().classes("justify-end gap-2 mt-4"):
                ui.button("Cancel", on_click=dialog.close).props("flat")
                ui.button("Create", on_click=do_create).props("color=primary")
        
        dialog.open()

    async def _do_create_dashboard(self, name: str, description: str, dialog) -> None:
        """Actually create the dashboard."""
        if not name:
            ui.notify("Please enter a name", type="warning")
            return
        
        try:
            dashboard = await create_dashboard(name=name, description=description)
            ui.notify(f"Created dashboard: {name}", type="positive")
            dialog.close()
            ui.navigate.to(f"/dashboards/{dashboard['id']}")
        except Exception as e:
            ui.notify(f"Error: {str(e)}", type="negative")

    def _add_widget_dialog(self) -> None:
        """Add a widget dialog."""
        with ui.dialog() as dialog, ui.card().classes("w-[700px] max-h-[80vh]"):
            ui.label("Add Widget").classes("text-lg font-semibold mb-4")
            
            queries = get_saved_queries()
            
            if not queries:
                with ui.column().classes("items-center p-8"):
                    ui.icon("description", size="xl").classes("text-gray-300 mb-4")
                    ui.label("No saved queries yet").classes("text-gray-500")
                    ui.label("Create a query in the SQL editor first").classes("text-sm text-gray-400")
                    ui.button(
                        "Go to SQL Editor",
                        on_click=lambda: (dialog.close(), ui.navigate.to("/sql")),
                    ).props("flat color=primary").classes("mt-4")
            else:
                # Query selection using a proper select dropdown
                ui.label("Select a question to add:").classes("text-gray-600 mb-2")
                
                query_options = {q["id"]: q["name"] for q in queries}
                query_select = ui.select(
                    label="Question",
                    options=query_options,
                    value=None,
                ).classes("w-full")
                
                ui.label("Visualization type:").classes("text-gray-600 mt-4 mb-2")
                chart_select = ui.select(
                    options={
                        "table": "Table",
                        "bar": "Bar Chart",
                        "line": "Line Chart",
                        "pie": "Pie Chart",
                        "area": "Area Chart",
                    },
                    value="bar",  # Default to bar chart instead of table
                ).classes("w-full")
                
                # When a query is selected, load its saved visualization settings
                async def on_query_change(e):
                    if e.value:
                        viz = await get_visualization_by_query_id(e.value)
                        if viz and viz.get("chart_type"):
                            # Update chart type to match saved visualization
                            chart_select.value = viz["chart_type"]
                
                query_select.on("update:model-value", on_query_change)
                
                # Size options
                ui.label("Widget size:").classes("text-gray-600 mt-4 mb-2")
                with ui.row().classes("gap-4"):
                    width_select = ui.select(
                        label="Width",
                        options={3: "Small (3)", 4: "Medium (4)", 6: "Large (6)", 12: "Full (12)"},
                        value=6,
                    )
                    height_select = ui.select(
                        label="Height",
                        options={2: "Small (2)", 3: "Medium (3)", 4: "Large (4)", 6: "Tall (6)"},
                        value=3,
                    )
                
                async def do_add():
                    if not query_select.value:
                        ui.notify("Please select a query", type="warning")
                        return
                    await self._do_add_widget(
                        query_select.value,
                        chart_select.value,
                        width_select.value,
                        height_select.value,
                        dialog,
                    )
                
                with ui.row().classes("justify-end gap-2 mt-4"):
                    ui.button("Cancel", on_click=dialog.close).props("flat")
                    ui.button("Add Widget", on_click=do_add).props("color=primary")
        
        dialog.open()

    async def _do_add_widget(
        self, 
        query_id: str, 
        chart_type: str, 
        width: int, 
        height: int,
        dialog,
    ) -> None:
        """Add a widget to the dashboard."""
        try:
            # Calculate position (add to end)
            max_y = 0
            for w in self.widgets:
                widget_end = w.get("position_y", 0) + w.get("height", 4)
                max_y = max(max_y, widget_end)
            
            widget = await add_widget_to_dashboard(
                dashboard_id=self.dashboard_id,
                query_id=query_id,
                chart_type=chart_type,
                position_x=0,
                position_y=max_y,
                width=width,
                height=height,
            )
            
            if widget:
                ui.notify("Widget added!", type="positive")
                dialog.close()
                await self._refresh_dashboard()
            else:
                ui.notify("Failed to add widget", type="negative")
        except Exception as e:
            ui.notify(f"Error: {str(e)}", type="negative")

    def _remove_widget_dialog(self, widget: dict) -> None:
        """Confirm widget removal."""
        with ui.dialog() as dialog, ui.card():
            ui.label("Remove widget?").classes("text-lg font-semibold")
            ui.label("This widget will be removed from the dashboard.").classes("text-gray-500")
            
            async def do_remove():
                await self._do_remove_widget(widget["id"], dialog)
            
            with ui.row().classes("justify-end gap-2 mt-4"):
                ui.button("Cancel", on_click=dialog.close).props("flat")
                ui.button("Remove", on_click=do_remove).props("color=negative")
        
        dialog.open()

    async def _do_remove_widget(self, widget_id: str, dialog) -> None:
        """Remove the widget."""
        try:
            await remove_widget(widget_id)
            ui.notify("Widget removed", type="info")
            dialog.close()
            await self._refresh_dashboard()
        except Exception as e:
            ui.notify(f"Error: {str(e)}", type="negative")

    def _edit_widget(self, widget: dict) -> None:
        """Edit widget settings."""
        ui.notify("Edit widget coming soon!", type="info")
    
    def _resize_widget_dialog(self, widget: dict) -> None:
        """Show resize widget dialog."""
        with ui.dialog() as dialog, ui.card().classes("w-96"):
            ui.label("Resize Widget").classes("text-lg font-semibold mb-4")
            
            current_width = widget.get("width", 6)
            current_height = widget.get("height", 3)
            
            width_select = ui.select(
                label="Width (columns)",
                options={3: "Small (3)", 4: "Medium (4)", 6: "Large (6)", 12: "Full (12)"},
                value=current_width,
            ).classes("w-full")
            
            height_select = ui.select(
                label="Height (rows)",
                options={2: "Small (2)", 3: "Medium (3)", 4: "Large (4)", 6: "Tall (6)"},
                value=current_height,
            ).classes("w-full")
            
            async def do_resize():
                try:
                    await update_widget_position(
                        widget_id=widget["id"],
                        position_x=widget.get("position_x", 0),
                        position_y=widget.get("position_y", 0),
                        width=width_select.value,
                        height=height_select.value,
                    )
                    ui.notify("Widget resized", type="positive")
                    dialog.close()
                    await self._refresh_dashboard()
                except Exception as e:
                    ui.notify(f"Error resizing widget: {e}", type="negative")
            
            with ui.row().classes("justify-end gap-2 mt-4"):
                ui.button("Cancel", on_click=dialog.close).props("flat")
                ui.button("Apply", on_click=do_resize).props("color=primary")
        
        dialog.open()

    async def _refresh_widget(self, widget: dict) -> None:
        """Refresh a single widget (re-renders all widgets in place)."""
        await self._refresh_dashboard()

    async def _refresh_dashboard(self) -> None:
        """Refresh all widgets in place without a full page reload."""
        if not self._widgets_container:
            return
        # Reload dashboard data from DB
        self.dashboard = await get_dashboard_by_id(self.dashboard_id)
        if self.dashboard:
            self.widgets = self.dashboard.get("widgets", [])
        self._widgets_container.clear()
        with self._widgets_container:
            if self.widgets:
                for widget in self.widgets:
                    await self._render_widget(widget)
            else:
                with ui.element("div").classes(
                    "col-span-12 flex items-center justify-center h-[400px] "
                    "border-2 border-dashed border-gray-300 rounded-lg"
                ):
                    with ui.column().classes("items-center gap-4"):
                        ui.icon("widgets", size="xl").classes("text-gray-300")
                        ui.label("No widgets yet").classes("text-lg text-gray-400")
                        ui.button(
                            "Add your first widget",
                            icon="add",
                            on_click=self._add_widget_dialog,
                        ).props("color=primary")
        ui.notify("Dashboard refreshed", type="positive")

    def _rename_dashboard(self) -> None:
        """Rename the dashboard."""
        with ui.dialog() as dialog, ui.card().classes("w-96"):
            ui.label("Rename Dashboard").classes("text-lg font-semibold")
            
            name_input = ui.input(
                label="Name", 
                value=self.dashboard["name"],
            ).classes("w-full")
            
            async def do_rename():
                await DashboardService.update(self.dashboard_id, name=name_input.value)
                ui.notify("Dashboard renamed", type="positive")
                dialog.close()
                ui.navigate.to(f"/dashboards/{self.dashboard_id}")
            
            with ui.row().classes("justify-end gap-2 mt-4"):
                ui.button("Cancel", on_click=dialog.close).props("flat")
                ui.button("Save", on_click=do_rename).props("color=primary")
        
        dialog.open()

    def _duplicate_dashboard(self) -> None:
        """Duplicate the current dashboard."""
        with ui.dialog() as dialog, ui.card().classes("w-96"):
            ui.label("Duplicate Dashboard").classes("text-lg font-semibold")
            
            name_input = ui.input(
                label="Name", 
                value=f"{self.dashboard['name']} (Copy)",
            ).classes("w-full")
            
            async def do_duplicate():
                try:
                    # Create a new dashboard with the same name
                    new_dashboard = await create_dashboard(
                        name=name_input.value,
                        description=self.dashboard.get("description", ""),
                    )
                    
                    # Copy widgets to the new dashboard
                    for widget in self.widgets:
                        await add_widget_to_dashboard(
                            dashboard_id=new_dashboard["id"],
                            query_id=widget.get("query", {}).get("id") if widget.get("query") else None,
                            chart_type=widget.get("visualization", {}).get("chart_type", "table"),
                            position_x=widget.get("position_x", 0),
                            position_y=widget.get("position_y", 0),
                            width=widget.get("width", 6),
                            height=widget.get("height", 3),
                        )
                    
                    ui.notify(f"Dashboard duplicated as '{name_input.value}'", type="positive")
                    dialog.close()
                    ui.navigate.to(f"/dashboards/{new_dashboard['id']}")
                except Exception as e:
                    ui.notify(f"Error duplicating dashboard: {e}", type="negative")
            
            with ui.row().classes("justify-end gap-2 mt-4"):
                ui.button("Cancel", on_click=dialog.close).props("flat")
                ui.button("Duplicate", on_click=do_duplicate).props("color=primary")
        
        dialog.open()

    def _delete_dashboard_dialog(self) -> None:
        """Confirm dashboard deletion."""
        with ui.dialog() as dialog, ui.card():
            ui.label(f"Delete '{self.dashboard['name']}'?").classes("text-lg font-semibold")
            ui.label("This action cannot be undone.").classes("text-gray-500")
            
            async def do_delete():
                await delete_dashboard(self.dashboard_id)
                ui.notify("Dashboard deleted", type="info")
                dialog.close()
                ui.navigate.to("/dashboards")
            
            with ui.row().classes("justify-end gap-2 mt-4"):
                ui.button("Cancel", on_click=dialog.close).props("flat")
                ui.button("Delete", on_click=do_delete).props("color=negative")
        
        dialog.open()


async def dashboard_page(dashboard_id: str | None = None) -> None:
    """Entry point for dashboard page."""
    page = DashboardPage(dashboard_id)
    await page.render()
