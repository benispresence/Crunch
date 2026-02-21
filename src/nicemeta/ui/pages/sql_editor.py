"""
SQL Editor page for NiceMeta - Metabase-style layout.
"""

import pandas as pd
from nicegui import ui

from nicemeta.ui.components.agent_panel import AgentPanel
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
from nicemeta.services.visualization_service import (
    get_visualization_by_query_id,
    save_visualization,
)
from nicemeta.ui.components.sql_editor_widget import (
    SQLEditorWidget,
    create_results_table,
    serialize_value,
)
from nicemeta.ui.components.python_editor_widget import PythonEditorWidget
from nicemeta.visualization import (
    ChartConfig,
    ChartFactory,
    generate_visualization_code,
    execute_visualization_code,
    validate_visualization_code,
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
        
        # Python code editor state
        self._python_code: str = ""
        self._python_code_modified: bool = False  # True if user manually edited code
        self._python_editor: PythonEditorWidget | None = None
        self._code_preview_container = None
        
        # Editor panel state
        self._editors_visible: bool = True  # Toggle for showing/hiding editors
        self._editor_panel_container = None
        self._main_python_editor = None  # Python editor in main view
        self._editor_toggle_btn = None  # Toggle button reference
        
        # Individual editor expansion state
        self._sql_editor_expanded: bool = True
        self._python_editor_expanded: bool = True
        self._sql_editor_container = None
        self._python_editor_container = None
        
        # UI references
        self._connection_select = None
        self._results_container = None
        self._viz_container = None
        self._viz_options_container = None
        self._bottom_bar = None
        self._view_toggle_container = None  # re-rendered on every _set_view call
        self._query_name_input = None
        self._header = None
        self._sidebar = None
        self._row_count_label = None
        self._timing_label = None
        self._viz_settings_refresh = None
        self._agent_panel: AgentPanel | None = None

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

        # Create AI agent panel (right drawer, top-level)
        self._agent_panel = AgentPanel(
            on_apply_sql=self._apply_agent_sql,
            on_apply_python=self._apply_agent_python,
            get_context=self._get_agent_context,
        )
        self._agent_panel.create()

        # Create custom header for SQL editor (top-level)
        self._create_editor_header()
        
        # Create bottom bar (top-level - must be before content for NiceGUI)
        self._create_bottom_bar()
        
        # Main content area
        with ui.column().classes("w-full bg-gray-50").style("min-height: calc(100vh - 120px); padding-bottom: 60px;"):
            # Editor panel with "OPEN EDITOR" toggle
            self._editors_visible = not self._is_saved_query
            self._create_editor_panel()
            
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

                    # Delete (only if saved)
                    if self.query_id:
                        ui.button(
                            icon="delete",
                            on_click=self._delete_query,
                        ).props("flat round").classes("text-gray-600").tooltip("Delete query")

                    # + New button
                    with ui.button("New", icon="add").props("color=primary"):
                        with ui.menu():
                            ui.menu_item("SQL Query", lambda: ui.navigate.to("/sql"))
                            ui.menu_item("Question", lambda: ui.navigate.to("/query-builder"))
                            ui.menu_item("Dashboard", lambda: ui.navigate.to("/dashboards"))

                    # AI Agent toggle
                    _ap = self._agent_panel
                    ui.button(
                        icon="smart_toy",
                        on_click=lambda: _ap.toggle() if _ap else None,
                    ).props("flat round").classes("text-gray-600").tooltip("AI Agent")

                    # Settings
                    ui.button(
                        icon="settings",
                        on_click=lambda: ui.navigate.to("/admin"),
                    ).props("flat round").classes("text-gray-600")

    def _create_editor_panel(self) -> None:
        """Create the editor panel with OPEN EDITOR toggle and dual SQL/Python editors."""
        # Header row with "OPEN EDITOR" toggle
        with ui.row().classes(
            "w-full items-center justify-between px-4 py-2 bg-white border-b border-gray-200"
        ):
            # Left side - Query info
            with ui.row().classes("items-center gap-3"):
                ui.label("This question is written in SQL.").classes(
                    "text-sm text-gray-500"
                )
            
            # Right side - OPEN EDITOR toggle
            self._editor_toggle_btn = ui.button(
                "OPEN EDITOR" if not self._editors_visible else "CLOSE EDITOR",
                icon="keyboard_arrow_down" if self._editors_visible else "keyboard_arrow_right",
                on_click=self._toggle_editors,
            ).props("flat no-caps").classes(
                "text-blue-600 font-medium"
            ).style("font-size: 13px;")
        
        # Collapsible editor panel container
        self._editor_panel_container = ui.column().classes("w-full")
        with self._editor_panel_container:
            if self._editors_visible:
                self._render_editor_panels()
    
    def _toggle_editors(self) -> None:
        """Toggle the visibility of the editor panels."""
        # Save current editor values before toggling to prevent state loss
        if self.editor:
            self._initial_sql = self.editor.value
        if self._main_python_editor:
            self._python_code = self._main_python_editor.value
        
        self._editors_visible = not self._editors_visible
        
        # Update button text and icon
        if self._editor_toggle_btn:
            if self._editors_visible:
                self._editor_toggle_btn.text = "CLOSE EDITOR"
                self._editor_toggle_btn.props(remove="icon=keyboard_arrow_right")
                self._editor_toggle_btn.props(add="icon=keyboard_arrow_down")
            else:
                self._editor_toggle_btn.text = "OPEN EDITOR"
                self._editor_toggle_btn.props(remove="icon=keyboard_arrow_down")
                self._editor_toggle_btn.props(add="icon=keyboard_arrow_right")
        
        # Re-render editor panels
        if self._editor_panel_container:
            self._editor_panel_container.clear()
            with self._editor_panel_container:
                if self._editors_visible:
                    self._render_editor_panels()
    
    def _render_editor_panels(self) -> None:
        """Render both SQL and Python editor panels."""
        with ui.column().classes("w-full gap-0"):
            # SQL Editor Card
            with ui.card().classes(
                "w-full rounded-none border-b border-gray-200"
            ).style("box-shadow: none;"):
                # SQL Editor header - clickable to expand/collapse
                with ui.row().classes(
                    "w-full items-center gap-2 px-4 py-2 bg-gray-50 border-b border-gray-200 cursor-pointer hover:bg-gray-100"
                ).on("click", self._toggle_sql_editor):
                    ui.icon(
                        "expand_more" if self._sql_editor_expanded else "chevron_right",
                        size="sm"
                    ).classes("text-gray-400")
                    ui.icon("code", size="sm").classes("text-blue-500")
                    ui.label("SQL Query").classes(
                        "text-sm font-medium text-gray-700"
                    )
                
                # SQL Editor content - collapsible
                self._sql_editor_container = ui.column().classes("w-full")
                with self._sql_editor_container:
                    if self._sql_editor_expanded:
                        self._create_sql_editor_content()
            
            # Python Visualization Editor Card
            with ui.card().classes(
                "w-full rounded-none"
            ).style("box-shadow: none;"):
                # Python Editor header - clickable to expand/collapse
                with ui.row().classes(
                    "w-full items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-200 cursor-pointer hover:bg-gray-100"
                ).on("click", self._toggle_python_editor):
                    with ui.row().classes("items-center gap-2"):
                        ui.icon(
                            "expand_more" if self._python_editor_expanded else "chevron_right",
                            size="sm"
                        ).classes("text-gray-400")
                        ui.icon("functions", size="sm").classes("text-emerald-600")
                        ui.label("Python Visualization Code").classes(
                            "text-sm font-medium text-gray-700"
                        )
                    
                    # Auto-generated badge if not modified
                    if not self._python_code_modified:
                        ui.badge("Auto-generated").props("color=grey-6 outline").classes(
                            "text-xs"
                        )
                
                # Python Editor content - collapsible
                self._python_editor_container = ui.column().classes("w-full")
                with self._python_editor_container:
                    if self._python_editor_expanded:
                        self._create_python_editor_content()
    
    def _toggle_sql_editor(self) -> None:
        """Toggle SQL editor visibility."""
        # Save current SQL value before toggling to prevent state loss
        if self.editor:
            self._initial_sql = self.editor.value
        
        self._sql_editor_expanded = not self._sql_editor_expanded
        if self._sql_editor_container:
            self._sql_editor_container.clear()
            with self._sql_editor_container:
                if self._sql_editor_expanded:
                    self._create_sql_editor_content()
        # Re-render the whole panel to update the icon
        if self._editor_panel_container:
            self._editor_panel_container.clear()
            with self._editor_panel_container:
                if self._editors_visible:
                    self._render_editor_panels()
    
    def _toggle_python_editor(self) -> None:
        """Toggle Python editor visibility."""
        # Save current Python code before toggling to prevent state loss
        if self._main_python_editor:
            self._python_code = self._main_python_editor.value
        
        self._python_editor_expanded = not self._python_editor_expanded
        if self._python_editor_container:
            self._python_editor_container.clear()
            with self._python_editor_container:
                if self._python_editor_expanded:
                    self._create_python_editor_content()
        # Re-render the whole panel to update the icon
        if self._editor_panel_container:
            self._editor_panel_container.clear()
            with self._editor_panel_container:
                if self._editors_visible:
                    self._render_editor_panels()
    
    def _create_sql_editor_content(self) -> None:
        """Create the SQL editor content within the panel."""
        # SQL Editor - use _initial_sql which may have been set by _load_query
        self.editor = SQLEditorWidget(
            value=self._initial_sql,
            on_change=self._on_sql_change,
            on_run=self._run_query,
        )
        self.editor.create()
    
    def _on_sql_change(self, value: str) -> None:
        """Handle SQL code changes - keeps _initial_sql in sync."""
        self._initial_sql = value
    
    def _create_python_editor_content(self) -> None:
        """Create the Python visualization editor content within the panel."""
        # Generate code if not already set
        if not self._python_code:
            self._python_code = self._generate_viz_code()
        
        with ui.column().classes("w-full p-3 bg-white border border-gray-200"):
            # Action buttons row
            with ui.row().classes("w-full items-center gap-2 mb-2"):
                ui.button(
                    "Run Code",
                    icon="play_arrow",
                    on_click=lambda: self._execute_main_python_code(),
                ).props("color=primary dense").classes("text-xs")
                
                ui.button(
                    "Validate",
                    icon="check_circle",
                    on_click=self._validate_python_code,
                ).props("flat dense").classes("text-xs text-gray-600")
                
                ui.button(
                    "Reset",
                    icon="refresh",
                    on_click=self._reset_main_python_code,
                ).props("flat dense").classes("text-xs text-gray-600")
                
                ui.space()
                
                ui.label("Ctrl+Enter to run").classes("text-xs text-gray-400")
            
            # Python code editor with syntax highlighting
            self._main_python_editor = ui.codemirror(
                value=self._python_code,
                language="python",
                on_change=lambda e: self._on_main_python_code_change(e.value),
            ).classes("w-full border border-gray-200 rounded").style(
                "min-height: 180px;"
            )
    
    def _on_main_python_code_change(self, value: str) -> None:
        """Handle Python code changes in main editor."""
        if value != self._python_code:
            self._python_code = value
            self._python_code_modified = True
    
    def _reset_main_python_code(self) -> None:
        """Reset Python code to auto-generated version."""
        self._python_code_modified = False
        self._python_code = self._generate_viz_code()
        if self._main_python_editor:
            self._main_python_editor.set_value(self._python_code)
        ui.notify("Code reset to auto-generated version", type="info")
    
    def _execute_main_python_code(self) -> None:
        """Execute the Python code from main editor."""
        if self.result_df is None:
            ui.notify("No data available. Run the SQL query first.", type="warning")
            return
        
        # Execute the code
        result = execute_visualization_code(self._python_code, self.result_df)
        
        if result.success:
            ui.notify("Code executed successfully", type="positive")
            
            # Store the figure for rendering
            self._chart_config["_custom_figure"] = result.figure
            self._chart_config["_use_custom_code"] = True
            
            # Switch to visualization view and refresh
            self._selected_view = "visualization"
            self._render_results()
        else:
            ui.notify(f"Execution error: {result.error}", type="negative")

    def _create_editor_section(self) -> None:
        """Create the SQL editor section (legacy method for compatibility)."""
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
                
                # Center - View toggle (table/chart) — re-rendered on every view change
                with ui.row().classes("items-center gap-1 bg-gray-100 rounded-lg p-1"):
                    self._view_toggle_container = ui.row()
                    self._render_view_toggle()
                
                # Right - Row count and timing
                with ui.row().classes("items-center gap-4 text-sm text-gray-500"):
                    self._row_count_label = ui.label("No results")
                    self._timing_label = ui.label("")
                    
                    # Export buttons
                    ui.button(
                        icon="download",
                        on_click=self._download_results,
                    ).props("flat round dense").classes(
                        "text-gray-400"
                    ).tooltip("Download results as CSV")

    def _render_view_toggle(self) -> None:
        """Re-render the table/chart toggle buttons so their state is always accurate."""
        if not self._view_toggle_container:
            return
        self._view_toggle_container.clear()
        with self._view_toggle_container:
            ui.button(
                icon="table_chart",
                on_click=lambda: self._set_view("table"),
            ).props(
                f"{'color=primary' if self._selected_view == 'table' else 'flat'} round dense"
            ).tooltip("Table")
            ui.button(
                icon="bar_chart",
                on_click=lambda: self._set_view("visualization"),
            ).props(
                f"{'color=primary' if self._selected_view == 'visualization' else 'flat'} round dense"
            ).tooltip("Visualization")

    def _download_results(self) -> None:
        """Download query results as CSV."""
        if self.result_df is None or self.result_df.empty:
            ui.notify("No results to download. Run a query first.", type="warning")
            return
        
        try:
            import io
            csv_buffer = io.StringIO()
            self.result_df.to_csv(csv_buffer, index=False)
            csv_data = csv_buffer.getvalue()
            
            # Generate filename
            filename = f"{self.query_name.replace(' ', '_')}_results.csv"
            
            # Trigger download using NiceGUI's download functionality
            ui.download(csv_data.encode('utf-8'), filename)
            ui.notify(f"Downloading {filename}", type="positive")
        except Exception as e:
            ui.notify(f"Error downloading results: {e}", type="negative")
    
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
        """Load a saved query and visualization settings from database."""
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
            
            # Load visualization settings if they exist
            viz = await get_visualization_by_query_id(query_id)
            if viz:
                self._selected_chart_type = viz.get("chart_type", "bar")
                self._chart_config = viz.get("config", {})
                if viz.get("python_code"):
                    self._python_code = viz["python_code"]
                    self._python_code_modified = True
                # Set view to visualization if we have saved viz settings
                self._selected_view = "visualization"

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
        """Actually save the query and visualization settings to database."""
        if not name:
            ui.notify("Please enter a name", type="warning")
            return
        
        sql = self.editor.get_value() if self.editor else ""
        if not sql.strip():
            ui.notify("Please enter a SQL query", type="warning")
            return
        
        # Save the query
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
        
        # Save visualization settings if configured
        if self._selected_chart_type:
            await save_visualization(
                query_id=self.query_id,
                chart_type=self._selected_chart_type,
                config=self._chart_config,
                python_code=self._python_code if self._python_code_modified else None,
            )
        
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

    def _set_view(self, view: str) -> None:
        """Set the current view mode and update toggle button visuals."""
        self._selected_view = view
        self._render_view_toggle()
        self._render_results()

    def _toggle_viz_options(self) -> None:
        """Toggle visualization options panel."""
        if self.result_df is None or self.result_df.empty:
            ui.notify("Run a query first to configure visualization", type="info")
            return
        self._show_viz_options_dialog()

    def _show_viz_options_dialog(self) -> None:
        """Show Metabase-style visualization settings dialog."""
        if self.result_df is None:
            return
        
        analysis = self._analyze_columns(self.result_df)
        suitable_charts = self._get_suitable_chart_types(analysis)
        
        # Chart library info
        CHART_LIBRARIES = {
            "bar": {"lib": "Plotly", "type": "plotly.express.bar"},
            "line": {"lib": "Plotly", "type": "plotly.express.line"},
            "area": {"lib": "Plotly", "type": "plotly.express.area"},
            "pie": {"lib": "Plotly", "type": "plotly.express.pie"},
            "donut": {"lib": "Plotly", "type": "plotly.express.pie (hole=0.4)"},
            "scatter": {"lib": "Plotly", "type": "plotly.express.scatter"},
            "histogram": {"lib": "Plotly", "type": "plotly.express.histogram"},
            "heatmap": {"lib": "Plotly", "type": "plotly.express.imshow"},
            "box": {"lib": "Plotly", "type": "plotly.express.box"},
            "table": {"lib": "NiceGUI", "type": "ui.table"},
        }
        
        # Container refs for in-place refresh
        self._viz_chart_list_container = None
        self._viz_right_panel_container = None

        with ui.dialog().props("persistent").classes("viz-settings-dialog") as dialog:
            with ui.card().classes("w-full").style("width: 950px; height: 700px;"):
                # Header
                with ui.row().classes("w-full items-center justify-between p-4 border-b bg-white"):
                    ui.label("Visualization Settings").classes("text-xl font-bold text-gray-800")
                    ui.button(icon="close", on_click=dialog.close).props("flat round")

                # Main content container (refreshable on chart type change)
                viz_body = ui.column().classes("w-full").style("height: 550px;")

                def _render_viz_body():
                    viz_body.clear()
                    with viz_body:
                        with ui.splitter(value=30).classes("w-full").style("height: 550px;") as splitter:
                            # LEFT SIDEBAR - Chart Types
                            with splitter.before:
                                with ui.column().classes("w-full h-full bg-gray-50 p-0"):
                                    ui.label("Chart Type").classes("text-sm font-semibold text-gray-600 p-3 border-b bg-white")

                                    with ui.scroll_area().classes("w-full").style("height: 500px;"):
                                        with ui.column().classes("p-2 gap-1 w-full"):
                                            categories = {}
                                            for chart in suitable_charts:
                                                cat = chart.get("category", "Other")
                                                if cat not in categories:
                                                    categories[cat] = []
                                                categories[cat].append(chart)

                                            for category, charts in categories.items():
                                                ui.label(category.upper()).classes(
                                                    "text-xs font-bold text-gray-400 px-2 pt-4 pb-1"
                                                )
                                                for chart in charts:
                                                    is_selected = chart["id"] == self._selected_chart_type
                                                    lib_info = CHART_LIBRARIES.get(chart["id"], {})

                                                    btn_classes = (
                                                        "w-full justify-start text-left " +
                                                        ("bg-blue-500 text-white" if is_selected else "")
                                                    )

                                                    with ui.button(on_click=lambda c=chart["id"]: self._select_chart_type(c, dialog)).props(
                                                        "flat align=left no-caps"
                                                    ).classes(btn_classes):
                                                        with ui.row().classes("items-center gap-3 w-full"):
                                                            ui.icon(chart["icon"]).classes(
                                                                "text-white" if is_selected else "text-gray-500"
                                                            )
                                                            with ui.column().classes("gap-0"):
                                                                ui.label(chart["name"]).classes(
                                                                    "text-sm font-medium " +
                                                                    ("text-white" if is_selected else "text-gray-700")
                                                                )
                                                                ui.label(lib_info.get("lib", "")).classes(
                                                                    "text-xs " +
                                                                    ("text-blue-100" if is_selected else "text-gray-400")
                                                                )

                            # RIGHT PANEL - Settings & Code Tabs
                            with splitter.after:
                                with ui.column().classes("w-full h-full bg-white"):
                                    with ui.tabs().classes("w-full border-b-2 border-blue-200").props(
                                        "dense inline-label indicator-color=primary active-color=primary"
                                    ).style("background: #e3f2fd;") as tabs:
                                        settings_tab = ui.tab("Settings", icon="tune").props("no-caps").style(
                                            "color: #1565c0; font-weight: 600; font-size: 14px;"
                                        )
                                        code_tab = ui.tab("Python Code", icon="code").props("no-caps").style(
                                            "color: #1565c0; font-weight: 600; font-size: 14px;"
                                        )

                                    with ui.tab_panels(tabs, value=settings_tab).classes("w-full").style("height: 480px;"):
                                        with ui.tab_panel(settings_tab):
                                            lib_info = CHART_LIBRARIES.get(self._selected_chart_type, {})
                                            if lib_info:
                                                with ui.row().classes("items-center gap-2 p-2 bg-gray-50 rounded mb-2"):
                                                    ui.icon("info", size="xs").classes("text-gray-400")
                                                    ui.label(f"{lib_info.get('lib', '')} • {lib_info.get('type', '')}").classes(
                                                        "text-xs text-gray-500 font-mono"
                                                    )

                                            with ui.scroll_area().classes("w-full").style("height: 420px;"):
                                                with ui.column().classes("p-2 gap-4 w-full"):
                                                    self._render_viz_settings_panel(analysis)

                                        with ui.tab_panel(code_tab):
                                            self._render_python_code_panel(analysis, dialog)

                # Store refresh callback so _select_chart_type can use it
                self._viz_settings_refresh = _render_viz_body
                _render_viz_body()
                
                # Footer with actions
                with ui.row().classes("w-full justify-end gap-2 p-4 border-t bg-gray-50"):
                    ui.button("Cancel", on_click=dialog.close).props("flat")
                    ui.button(
                        "Apply", 
                        icon="check",
                        on_click=lambda: self._apply_viz_settings(dialog)
                    ).props("color=primary")
        
        dialog.open()

    def _render_viz_settings_panel(self, analysis: dict) -> None:
        """Render the settings panel based on chart type."""
        all_cols = analysis["all_cols"]
        numeric_cols = analysis["numeric_cols"]
        categorical_cols = analysis["categorical_cols"]
        datetime_cols = analysis["datetime_cols"]
        chart_type = self._selected_chart_type
        
        # DATA section
        with ui.card().classes("w-full"):
            with ui.card_section():
                ui.label("📊 Data Mapping").classes("text-sm font-bold text-gray-700")
            
            with ui.card_section().classes("pt-0"):
                if chart_type in ["bar", "line", "area", "scatter", "histogram"]:
                    # X-Axis - allow all columns
                    x_options = {c: c for c in all_cols}
                    default_x = self._chart_config.get("x") or (categorical_cols[0] if categorical_cols else (all_cols[0] if all_cols else None))
                    
                    ui.select(
                        label="X-Axis (Categories)",
                        options=x_options,
                        value=default_x,
                        on_change=lambda e: self._update_chart_config("x", e.value),
                    ).classes("w-full mb-2")
                    
                    if chart_type == "bar":
                        ui.select(
                            label="Orientation",
                            options={"v": "Vertical", "h": "Horizontal"},
                            value=self._chart_config.get("orientation", "v"),
                            on_change=lambda e: self._update_chart_config("orientation", e.value),
                        ).classes("w-full mb-2")
                
                if chart_type in ["bar", "line", "area", "scatter"]:
                    # Y-Axis - prefer numeric but allow all
                    y_options = {c: f"{c} ★" if c in numeric_cols else c for c in all_cols}
                    default_y = self._chart_config.get("y") or (numeric_cols[0] if numeric_cols else (all_cols[1] if len(all_cols) > 1 else all_cols[0] if all_cols else None))
                    
                    ui.select(
                        label="Y-Axis (Values) - ★ = numeric",
                        options=y_options,
                        value=default_y,
                        on_change=lambda e: self._update_chart_config("y", e.value),
                    ).classes("w-full mb-2")
                
                if chart_type in ["pie", "donut"]:
                    label_options = {c: c for c in all_cols}
                    value_options = {c: f"{c} ★" if c in numeric_cols else c for c in all_cols}
                    
                    ui.select(
                        label="Labels (Categories)",
                        options=label_options,
                        value=self._chart_config.get("labels") or (categorical_cols[0] if categorical_cols else (all_cols[0] if all_cols else None)),
                        on_change=lambda e: self._update_chart_config("labels", e.value),
                    ).classes("w-full mb-2")
                    
                    ui.select(
                        label="Values (Size) - ★ = numeric",
                        options=value_options,
                        value=self._chart_config.get("values") or (numeric_cols[0] if numeric_cols else None),
                        on_change=lambda e: self._update_chart_config("values", e.value),
                    ).classes("w-full mb-2")
                
                if chart_type in ["bar", "line", "scatter", "area"]:
                    color_options = {"": "None (single color)"} | {c: c for c in all_cols}
                    ui.select(
                        label="Color / Group By",
                        options=color_options,
                        value=self._chart_config.get("color", ""),
                        on_change=lambda e: self._update_chart_config("color", e.value),
                    ).classes("w-full")
        
        # DISPLAY section
        with ui.card().classes("w-full"):
            with ui.card_section():
                ui.label("🎨 Display Options").classes("text-sm font-bold text-gray-700")
            
            with ui.card_section().classes("pt-0"):
                ui.input(
                    label="Chart Title",
                    value=self._chart_config.get("title", ""),
                    on_change=lambda e: self._update_chart_config("title", e.value),
                ).classes("w-full mb-2")
                
                if chart_type in ["bar", "line", "area", "scatter"]:
                    ui.input(
                        label="X-Axis Label",
                        value=self._chart_config.get("x_label", ""),
                        on_change=lambda e: self._update_chart_config("x_label", e.value),
                    ).classes("w-full mb-2")
                    
                    ui.input(
                        label="Y-Axis Label",
                        value=self._chart_config.get("y_label", ""),
                        on_change=lambda e: self._update_chart_config("y_label", e.value),
                    ).classes("w-full mb-2")
                
                with ui.row().classes("gap-4"):
                    ui.checkbox(
                        "Show legend",
                        value=self._chart_config.get("show_legend", True),
                        on_change=lambda e: self._update_chart_config("show_legend", e.value),
                    )
                    
                    if chart_type in ["bar", "line", "scatter"]:
                        ui.checkbox(
                            "Show values",
                            value=self._chart_config.get("show_values", False),
                            on_change=lambda e: self._update_chart_config("show_values", e.value),
                        )
        
        # STYLE section (for applicable charts)
        if chart_type in ["bar", "line", "pie", "donut", "area"]:
            with ui.card().classes("w-full"):
                with ui.card_section():
                    ui.label("⚙️ Style Settings").classes("text-sm font-bold text-gray-700")
                
                with ui.card_section().classes("pt-0"):
                    ui.select(
                        label="Color Palette",
                        options={
                            "plotly": "Plotly (Default)",
                            "set2": "Set2 (Pastel)",
                            "viridis": "Viridis",
                            "plasma": "Plasma",
                            "blues": "Blues",
                            "reds": "Reds",
                            "greens": "Greens",
                            "dark24": "Dark24",
                        },
                        value=self._chart_config.get("color_palette", "plotly"),
                        on_change=lambda e: self._update_chart_config("color_palette", e.value),
                    ).classes("w-full mb-2")
                    
                    if chart_type == "line":
                        ui.select(
                            label="Line Style",
                            options={"solid": "Solid", "dash": "Dashed", "dot": "Dotted"},
                            value=self._chart_config.get("line_style", "solid"),
                            on_change=lambda e: self._update_chart_config("line_style", e.value),
                        ).classes("w-full mb-2")
                        
                        ui.checkbox(
                            "Show markers on line",
                            value=self._chart_config.get("show_markers", False),
                            on_change=lambda e: self._update_chart_config("show_markers", e.value),
                        )
                    
                    if chart_type == "bar":
                        ui.select(
                            label="Bar Mode (when grouped)",
                            options={"group": "Grouped", "stack": "Stacked", "relative": "Relative"},
                            value=self._chart_config.get("bar_mode", "group"),
                            on_change=lambda e: self._update_chart_config("bar_mode", e.value),
                        ).classes("w-full")
                    
                    if chart_type in ["pie", "donut"]:
                        ui.checkbox(
                            "Show percentages",
                            value=self._chart_config.get("show_percent", True),
                            on_change=lambda e: self._update_chart_config("show_percent", e.value),
                        )

    def _render_python_code_panel(self, analysis: dict, dialog) -> None:
        """Render the Python code editor panel."""
        # Generate code if not modified or empty
        if not self._python_code_modified or not self._python_code:
            self._python_code = self._generate_viz_code()
        
        with ui.column().classes("w-full h-full gap-2"):
            # Info banner
            with ui.row().classes("items-center gap-2 p-2 bg-blue-50 rounded"):
                ui.icon("lightbulb", size="xs").classes("text-blue-500")
                ui.label("Edit the Python code below to customize your visualization").classes(
                    "text-xs text-blue-700"
                )
            
            # Status indicator
            with ui.row().classes("items-center gap-2"):
                if self._python_code_modified:
                    ui.badge("Modified", color="orange").props("outline")
                    ui.button(
                        "Reset to Generated",
                        icon="refresh",
                        on_click=lambda: self._reset_python_code(dialog),
                    ).props("flat dense size=sm")
                else:
                    ui.badge("Auto-generated", color="green").props("outline")
            
            # Code editor
            self._python_editor = ui.codemirror(
                value=self._python_code,
                language="Python",
                on_change=self._on_python_code_change,
            ).classes("w-full border rounded").style(
                "height: 280px; font-size: 12px;"
            )
            
            # Action buttons
            with ui.row().classes("items-center gap-2"):
                ui.button(
                    "Run Code",
                    icon="play_arrow",
                    on_click=lambda: self._execute_python_code(dialog),
                ).props("color=primary dense")
                
                ui.button(
                    "Validate",
                    icon="check_circle",
                    on_click=self._validate_python_code,
                ).props("flat dense")
                
                ui.space()
                
                ui.label("Ctrl+Enter to run").classes("text-xs text-gray-400")
            
            # Preview container for execution results
            self._code_preview_container = ui.column().classes("w-full")

    def _generate_viz_code(self) -> str:
        """Generate Python visualization code from current config."""
        if self.result_df is None:
            return "# No data available. Run a query first."
        
        # Build ChartConfig from current settings
        config = ChartConfig(
            chart_type=self._selected_chart_type,
            title=self._chart_config.get("title", ""),
            x=self._chart_config.get("x"),
            y=self._chart_config.get("y"),
            labels=self._chart_config.get("labels"),
            values=self._chart_config.get("values"),
            color=self._chart_config.get("color") or None,
            x_label=self._chart_config.get("x_label", ""),
            y_label=self._chart_config.get("y_label", ""),
            width=900,
            height=500,
        )
        
        # Build options
        options = {
            "show_legend": self._chart_config.get("show_legend", True),
            "show_values": self._chart_config.get("show_values", False),
            "color_palette": self._chart_config.get("color_palette", "plotly"),
            "orientation": self._chart_config.get("orientation", "v"),
            "bar_mode": self._chart_config.get("bar_mode", "group"),
            "line_style": self._chart_config.get("line_style", "solid"),
            "show_markers": self._chart_config.get("show_markers", False),
            "show_percent": self._chart_config.get("show_percent", True),
        }
        
        return generate_visualization_code(config, self.result_df, options)

    def _on_python_code_change(self, e) -> None:
        """Handle Python code changes."""
        new_code = e.value
        if new_code != self._python_code:
            self._python_code = new_code
            self._python_code_modified = True

    def _reset_python_code(self, dialog) -> None:
        """Reset Python code to auto-generated version."""
        self._python_code_modified = False
        self._python_code = self._generate_viz_code()
        if self._python_editor:
            self._python_editor.value = self._python_code
        ui.notify("Code reset to generated version", type="info")

    def _validate_python_code(self) -> None:
        """Validate the Python code without executing."""
        errors = validate_visualization_code(self._python_code)
        if errors:
            ui.notify(f"Validation errors: {'; '.join(errors)}", type="negative")
        else:
            ui.notify("Code is valid", type="positive")

    def _execute_python_code(self, dialog) -> None:
        """Execute the Python code and show the result."""
        if self.result_df is None:
            ui.notify("No data available. Run a query first.", type="warning")
            return
        
        # Clear preview container
        if self._code_preview_container:
            self._code_preview_container.clear()
        
        # Execute the code
        result = execute_visualization_code(self._python_code, self.result_df)
        
        if result.success:
            ui.notify("Code executed successfully", type="positive")
            
            # Store the figure for rendering (not HTML)
            self._chart_config["_custom_figure"] = result.figure
            self._chart_config["_use_custom_code"] = True
            
            # Show preview in the dialog
            if self._code_preview_container and result.figure:
                with self._code_preview_container:
                    with ui.card().classes("w-full bg-green-50 border border-green-200 p-2"):
                        ui.label("Preview").classes("text-xs font-semibold text-green-700")
                    # Use ui.plotly() instead of ui.html() to avoid script tag issues
                    ui.plotly(result.figure).classes("w-full").style("max-height: 300px;")
        else:
            ui.notify(f"Execution error: {result.error}", type="negative")
            
            # Show error in preview container
            if self._code_preview_container:
                with self._code_preview_container:
                    with ui.card().classes("w-full bg-red-50 border border-red-200 p-2"):
                        with ui.row().classes("items-start gap-2"):
                            ui.icon("error", size="sm").classes("text-red-500")
                            with ui.column().classes("gap-1"):
                                ui.label("Execution Error").classes("text-sm font-semibold text-red-700")
                                if result.error_line:
                                    ui.label(f"Line {result.error_line}").classes("text-xs text-red-500")
                                ui.code(result.error or "Unknown error", language="text").classes("text-xs")

    def _preview_chart(self, dialog) -> None:
        """Preview the chart with current settings."""
        self._selected_view = "visualization"
        self._render_results()
        ui.notify("Preview updated", type="info")

    def _select_chart_type(self, chart_type: str, dialog=None) -> None:
        """Select a chart type and refresh settings in place (no dialog flicker)."""
        self._selected_chart_type = chart_type
        # Refresh the settings panel container if available, avoiding close/reopen
        if hasattr(self, '_viz_settings_refresh') and self._viz_settings_refresh:
            self._viz_settings_refresh()
        elif dialog:
            dialog.close()
            self._show_viz_options_dialog()

    def _render_column_mapping_dialog(self, analysis: dict) -> None:
        """Legacy method - now using _render_viz_settings_panel."""
        self._render_viz_settings_panel(analysis)

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
        import numpy as np
        
        analysis = {
            "numeric_cols": [],
            "categorical_cols": [],
            "datetime_cols": [],
            "all_cols": list(df.columns),
        }
        
        for col in df.columns:
            dtype = df[col].dtype
            
            # Check for numeric types (including int64, float64, Int64, etc.)
            if pd.api.types.is_numeric_dtype(dtype):
                analysis["numeric_cols"].append(col)
            elif pd.api.types.is_integer_dtype(dtype):
                analysis["numeric_cols"].append(col)
            elif dtype in [np.int64, np.int32, np.float64, np.float32, 'int64', 'int32', 'float64', 'float32']:
                analysis["numeric_cols"].append(col)
            elif pd.api.types.is_datetime64_any_dtype(dtype):
                analysis["datetime_cols"].append(col)
            else:
                # Try to detect if it's actually numeric but stored as object
                try:
                    if len(df) > 0:
                        sample = df[col].dropna().head(10)
                        if len(sample) > 0:
                            # Try converting to numeric
                            pd.to_numeric(sample, errors='raise')
                            analysis["numeric_cols"].append(col)
                            continue
                except (ValueError, TypeError):
                    pass
                
                # Try datetime detection
                try:
                    if df[col].dtype == object and len(df) > 0:
                        pd.to_datetime(df[col].dropna().iloc[0])
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
        has_any_cols = len(analysis["all_cols"]) > 0
        
        # Always show table
        charts.append({"id": "table", "name": "Table", "icon": "table_chart", "category": "Basic"})
        
        # Show basic charts if we have any data
        if has_any_cols:
            charts.append({"id": "bar", "name": "Bar Chart", "icon": "bar_chart", "category": "Basic"})
            charts.append({"id": "line", "name": "Line Chart", "icon": "show_chart", "category": "Basic"})
            charts.append({"id": "area", "name": "Area Chart", "icon": "area_chart", "category": "Basic"})
        
        if has_any_cols:
            charts.append({"id": "pie", "name": "Pie Chart", "icon": "pie_chart", "category": "Part-to-Whole"})
            charts.append({"id": "donut", "name": "Donut Chart", "icon": "donut_large", "category": "Part-to-Whole"})
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
        """Render the selected visualization with advanced options."""
        if self._selected_chart_type == "table":
            self._render_table()
            return
        
        try:
            # Check if we should use custom code figure
            if self._chart_config.get("_use_custom_code") and self._chart_config.get("_custom_figure"):
                fig = self._chart_config["_custom_figure"]
                
                # Show custom code badge
                with ui.row().classes("items-center gap-2 mb-2"):
                    ui.badge("Custom Python Code").props("color=orange outline")
                    ui.button(
                        "Reset to Auto",
                        icon="refresh",
                        on_click=self._reset_to_auto_chart,
                    ).props("flat dense size=sm")
                
                ui.plotly(fig).classes("w-full")
                return
            
            # Auto-detect x/y/labels/values from the DataFrame when not explicitly configured
            all_cols = list(self.result_df.columns)
            num_cols = [
                c for c in all_cols
                if pd.api.types.is_numeric_dtype(self.result_df[c])
            ]

            x_val = self._chart_config.get("x") or (all_cols[0] if all_cols else None)
            y_val = self._chart_config.get("y")
            if not y_val and self._selected_chart_type in ("bar", "line", "area", "scatter"):
                candidates = [c for c in num_cols if c != x_val]
                y_val = (candidates[0] if candidates
                         else num_cols[0] if num_cols
                         else all_cols[1] if len(all_cols) > 1
                         else x_val)

            labels_val = self._chart_config.get("labels")
            values_val = self._chart_config.get("values")
            if not labels_val and self._selected_chart_type in ("pie", "donut"):
                labels_val = all_cols[0] if all_cols else None
            if not values_val and self._selected_chart_type in ("pie", "donut"):
                values_val = (num_cols[0] if num_cols
                              else all_cols[1] if len(all_cols) > 1
                              else None)

            # Build config with all options
            config = ChartConfig(
                chart_type=self._selected_chart_type,
                title=self._chart_config.get("title", ""),
                x=x_val,
                y=y_val,
                labels=labels_val,
                values=values_val,
                color=self._chart_config.get("color") or None,
                width=900,
                height=500,
            )
            
            # Build additional options dict for advanced settings
            options = {
                "show_legend": self._chart_config.get("show_legend", True),
                "show_values": self._chart_config.get("show_values", False),
                "color_palette": self._chart_config.get("color_palette", "plotly"),
                "x_label": self._chart_config.get("x_label", ""),
                "y_label": self._chart_config.get("y_label", ""),
            }
            
            # Chart-specific options
            if self._selected_chart_type == "bar":
                options["orientation"] = self._chart_config.get("orientation", "v")
                options["bar_mode"] = self._chart_config.get("bar_mode", "group")
            
            if self._selected_chart_type == "line":
                options["line_style"] = self._chart_config.get("line_style", "solid")
                options["show_markers"] = self._chart_config.get("show_markers", False)
            
            if self._selected_chart_type in ["pie", "donut"]:
                options["show_percent"] = self._chart_config.get("show_percent", True)
            
            # Render chart figure directly (not HTML)
            fig = ChartFactory.render_figure(self.result_df, config, options)
            
            if fig is None:
                # render_figure() not supported by this renderer — fall back to table
                self._render_table()
                return
            
            # Show library info badge
            CHART_LIBRARIES = {
                "bar": "Plotly Express • Bar Chart",
                "line": "Plotly Express • Line Chart",
                "area": "Plotly Express • Area Chart",
                "pie": "Plotly Express • Pie Chart",
                "donut": "Plotly Express • Donut Chart",
                "scatter": "Plotly Express • Scatter Plot",
                "histogram": "Plotly Express • Histogram",
                "heatmap": "Plotly Express • Heatmap",
                "box": "Plotly Express • Box Plot",
            }
            
            lib_info = CHART_LIBRARIES.get(self._selected_chart_type, "")
            if lib_info:
                with ui.row().classes("items-center gap-2 mb-2"):
                    ui.badge(lib_info).props("color=grey-7 outline")
            
            ui.plotly(fig).classes("w-full")
            
        except Exception as e:
            import traceback
            with ui.card().classes("w-full bg-red-50 p-4 border border-red-200"):
                ui.label("Chart Error").classes("font-semibold text-red-700")
                ui.label(str(e)).classes("text-red-600 text-sm mt-1")
                with ui.expansion("Details").classes("mt-2"):
                    ui.code(traceback.format_exc()).classes("text-xs")

    def _reset_to_auto_chart(self) -> None:
        """Reset chart to use auto-generated visualization instead of custom code."""
        self._chart_config["_use_custom_code"] = False
        self._chart_config["_custom_figure"] = None
        self._python_code_modified = False
        self._python_code = ""
        self._render_results()
        ui.notify("Reset to auto-generated chart", type="info")

    # ── Agent integration ─────────────────────────────────────────────────────

    def _get_agent_context(self) -> dict:
        """Return page context so the agent knows what's in the editors."""
        return {
            "current_sql": self.editor.get_value() if self.editor else self._initial_sql,
            "current_python": (
                self._main_python_editor.value
                if self._main_python_editor
                else self._python_code
            ),
            "current_connection_id": self.current_connection,
            "query_name": self.query_name,
        }

    def _apply_agent_sql(self, new_sql: str) -> None:
        """Apply SQL proposed by the agent (accept diff)."""
        self._initial_sql = new_sql
        if self.editor:
            self.editor.set_value(new_sql)
        else:
            # Editor not visible – make it visible first
            if not self._editors_visible:
                self._toggle_editors()

    def _apply_agent_python(self, new_code: str) -> None:
        """Apply Python visualization code proposed by the agent (accept diff)."""
        self._python_code = new_code
        self._python_code_modified = True
        if self._main_python_editor:
            self._main_python_editor.set_value(new_code)
        elif not self._editors_visible:
            self._toggle_editors()

    # ── Query execution ───────────────────────────────────────────────────────

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
                
                # Regenerate Python visualization code with new data
                if not self._python_code_modified:
                    self._python_code = self._generate_viz_code()
                    # Update main Python editor if visible
                    if self._main_python_editor:
                        self._main_python_editor.set_value(self._python_code)
                
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
