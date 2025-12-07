"""
Dashboard page for NiceMeta.
"""

from nicegui import ui

from nicemeta.ui.components.sidebar import MetabaseHeader, MetabaseSidebar
from nicemeta.ui.components.folder_tree import FolderTree


class DashboardPage:
    """Dashboard page controller."""

    def __init__(self, dashboard_id: str | None = None):
        self.dashboard_id = dashboard_id
        self.is_editing = False
        self.widgets: list[dict] = []
        self._sidebar = None

    async def render(self) -> None:
        """Render the dashboard page."""
        self._sidebar = MetabaseSidebar()
        self._sidebar.create()
        
        if self.dashboard_id:
            await self._render_dashboard_view()
        else:
            await self._render_dashboard_list()

    async def _render_dashboard_list(self) -> None:
        """Render the dashboard list view."""
        header = MetabaseHeader(sidebar=self._sidebar, title="Dashboards")
        header.create()
        
        with ui.column().classes("w-full p-6 gap-6 bg-gray-50 min-h-screen"):
            # Header with actions
            with ui.row().classes("items-center justify-between w-full"):
                ui.label("All Dashboards").classes("text-xl font-semibold text-gray-800")
                
                ui.button(
                    "New Dashboard",
                    icon="add",
                    on_click=self._create_dashboard,
                ).props("color=primary")
            
            # Dashboard grid
            with ui.row().classes("gap-4 flex-wrap"):
                # Placeholder dashboards
                dashboard_card(
                    "Sales Overview",
                    "Weekly sales metrics and KPIs",
                    "1",
                    updated="2 hours ago",
                )
                dashboard_card(
                    "User Analytics",
                    "User engagement and growth metrics",
                    "2",
                    updated="1 day ago",
                )
                
                # Empty state card
                with ui.card().classes(
                    "w-72 h-48 flex items-center justify-center cursor-pointer "
                    "border-2 border-dashed border-gray-300 hover:border-blue-400"
                ) as card:
                    card.on("click", self._create_dashboard)
                    with ui.column().classes("items-center gap-2 text-gray-400"):
                        ui.icon("add_circle_outline", size="xl")
                        ui.label("Create Dashboard")

    async def _render_dashboard_view(self) -> None:
        """Render a specific dashboard."""
        header = MetabaseHeader(sidebar=self._sidebar, title=f"Dashboard: {self.dashboard_id}", show_back=True)
        header.create()
        
        with ui.column().classes("w-full p-4 gap-4"):
            # Dashboard toolbar
            with ui.row().classes("items-center justify-between w-full"):
                with ui.row().classes("items-center gap-2"):
                    ui.button(
                        icon="arrow_back",
                        on_click=lambda: ui.navigate.to("/dashboards"),
                    ).props("flat round")
                    ui.label("Sample Dashboard").classes("text-xl font-semibold")
                
                with ui.row().classes("gap-2"):
                    if self.is_editing:
                        ui.button(
                            "Add Widget",
                            icon="add",
                            on_click=self._add_widget,
                        ).props("flat")
                        ui.button(
                            "Save",
                            icon="save",
                            on_click=self._save_dashboard,
                        ).props("color=primary")
                        ui.button(
                            "Cancel",
                            on_click=self._toggle_edit,
                        ).props("flat")
                    else:
                        ui.button(
                            "Edit",
                            icon="edit",
                            on_click=self._toggle_edit,
                        ).props("flat")
                        ui.button(
                            "Refresh",
                            icon="refresh",
                            on_click=self._refresh_dashboard,
                        ).props("flat")
                        
                        with ui.button(icon="more_vert").props("flat round"):
                            with ui.menu():
                                ui.menu_item("Share")
                                ui.menu_item("Duplicate")
                                ui.menu_item("Export PDF")
                                ui.separator()
                                ui.menu_item("Delete")
            
            # Dashboard grid
            self._grid_container = ui.element("div").classes(
                "w-full grid grid-cols-12 gap-4 min-h-[600px]"
            )
            
            with self._grid_container:
                # Placeholder widgets
                widget_placeholder("Sales by Region", 6, 4)
                widget_placeholder("Revenue Trend", 6, 4)
                widget_placeholder("Top Products", 4, 4)
                widget_placeholder("Customer Segments", 4, 4)
                widget_placeholder("KPI Summary", 4, 4)

    def _create_dashboard(self) -> None:
        """Create a new dashboard."""
        with ui.dialog() as dialog, ui.card().classes("w-96"):
            ui.label("New Dashboard").classes("text-lg font-semibold")
            
            name_input = ui.input(label="Name", placeholder="My Dashboard").classes("w-full")
            desc_input = ui.textarea(
                label="Description",
                placeholder="Dashboard description...",
            ).classes("w-full")
            
            with ui.row().classes("justify-end gap-2 mt-4"):
                ui.button("Cancel", on_click=dialog.close).props("flat")
                ui.button(
                    "Create",
                    on_click=lambda: self._do_create_dashboard(
                        name_input.value, desc_input.value, dialog
                    ),
                ).props("color=primary")
        
        dialog.open()

    def _do_create_dashboard(self, name: str, description: str, dialog) -> None:
        """Actually create the dashboard."""
        if not name:
            ui.notify("Please enter a name", type="warning")
            return
        
        # In production, save to database
        ui.notify(f"Created dashboard: {name}")
        dialog.close()
        ui.navigate.to("/dashboards/new")

    def _toggle_edit(self) -> None:
        """Toggle edit mode."""
        self.is_editing = not self.is_editing
        # In production, re-render with edit controls

    def _add_widget(self) -> None:
        """Add a widget to the dashboard."""
        with ui.dialog() as dialog, ui.card().classes("w-[600px]"):
            ui.label("Add Widget").classes("text-lg font-semibold")
            
            with ui.tabs().classes("w-full") as tabs:
                saved_tab = ui.tab("Saved Queries")
                new_tab = ui.tab("New Query")
            
            with ui.tab_panels(tabs, value=saved_tab).classes("w-full"):
                with ui.tab_panel(saved_tab):
                    ui.label("Select a saved query to add as a widget").classes(
                        "text-gray-500 p-4"
                    )
                    # In production, show list of saved queries
                
                with ui.tab_panel(new_tab):
                    ui.label("Create a new query for this widget").classes(
                        "text-gray-500 p-4"
                    )
            
            with ui.row().classes("justify-end gap-2 mt-4"):
                ui.button("Cancel", on_click=dialog.close).props("flat")
                ui.button("Add", on_click=dialog.close).props("color=primary")
        
        dialog.open()

    def _save_dashboard(self) -> None:
        """Save the dashboard."""
        ui.notify("Dashboard saved", type="positive")
        self.is_editing = False

    def _refresh_dashboard(self) -> None:
        """Refresh all widgets."""
        ui.notify("Refreshing dashboard...")


def dashboard_card(
    name: str, description: str, dashboard_id: str, updated: str = ""
) -> ui.element:
    """Create a dashboard preview card."""
    with ui.card().classes("w-72 cursor-pointer hover:shadow-lg transition-shadow") as card:
        card.on("click", lambda: ui.navigate.to(f"/dashboards/{dashboard_id}"))
        
        # Preview area
        with ui.element("div").classes(
            "h-32 bg-gradient-to-br from-blue-50 to-indigo-100 "
            "flex items-center justify-center"
        ):
            ui.icon("dashboard", size="xl").classes("text-blue-300")
        
        # Info
        with ui.column().classes("p-3 gap-1"):
            ui.label(name).classes("font-semibold")
            ui.label(description).classes("text-sm text-gray-500 truncate")
            if updated:
                ui.label(f"Updated {updated}").classes("text-xs text-gray-400")
    
    return card


def widget_placeholder(title: str, width: int, height: int) -> ui.element:
    """Create a widget placeholder."""
    with ui.card().classes(f"col-span-{width}").style(f"min-height: {height * 50}px"):
        ui.label(title).classes("font-semibold mb-2")
        with ui.element("div").classes(
            "w-full h-full bg-gray-100 rounded flex items-center justify-center"
        ):
            ui.label("Chart placeholder").classes("text-gray-400")
    
    return None


async def dashboard_page(dashboard_id: str | None = None) -> None:
    """Entry point for dashboard page."""
    page = DashboardPage(dashboard_id)
    await page.render()

