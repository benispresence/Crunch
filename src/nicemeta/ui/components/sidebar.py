"""
Metabase-style sidebar and header components.
"""

from datetime import datetime
from typing import Callable

from nicegui import app, ui

# Global saved queries storage
_saved_queries: list[dict] = []
_saved_dashboards: list[dict] = []
_folders: list[dict] = [
    {"id": "1", "name": "My Queries", "parent_id": None},
]


def get_saved_queries() -> list[dict]:
    """Get all saved queries."""
    return _saved_queries


def save_query(
    name: str,
    sql: str,
    connection_id: str,
    folder_id: str | None = None,
    query_id: str | None = None,
) -> dict:
    """Save a query."""
    global _saved_queries
    
    if query_id:
        # Update existing
        for q in _saved_queries:
            if q["id"] == query_id:
                q["name"] = name
                q["sql"] = sql
                q["connection_id"] = connection_id
                q["folder_id"] = folder_id
                q["updated_at"] = datetime.now().isoformat()
                return q
    
    # Create new
    new_query = {
        "id": str(len(_saved_queries) + 1),
        "name": name,
        "sql": sql,
        "connection_id": connection_id,
        "folder_id": folder_id or "1",
        "created_at": datetime.now().isoformat(),
        "updated_at": datetime.now().isoformat(),
    }
    _saved_queries.append(new_query)
    return new_query


def delete_query(query_id: str) -> None:
    """Delete a query."""
    global _saved_queries
    _saved_queries = [q for q in _saved_queries if q["id"] != query_id]


def get_folders() -> list[dict]:
    """Get all folders."""
    return _folders


def get_saved_dashboards() -> list[dict]:
    """Get all saved dashboards."""
    return _saved_dashboards


class MetabaseSidebar:
    """Collapsible sidebar with saved items like Metabase."""
    
    def __init__(self, on_query_select: Callable[[dict], None] | None = None):
        self.on_query_select = on_query_select
        self._drawer = None
    
    def create(self) -> ui.left_drawer:
        """Create the sidebar drawer."""
        self._drawer = ui.left_drawer(value=False).classes(
            "bg-white border-r border-gray-200"
        ).style("width: 280px")
        
        with self._drawer:
            # Header
            with ui.row().classes("items-center justify-between p-4 border-b border-gray-200"):
                with ui.row().classes("items-center gap-2"):
                    ui.icon("analytics", size="md").classes("text-blue-500")
                    ui.label("NiceMeta").classes("text-lg font-bold text-gray-800")
                ui.button(
                    icon="close",
                    on_click=lambda: self._drawer.toggle(),
                ).props("flat round dense").classes("text-gray-500")
            
            # Search in sidebar
            with ui.row().classes("p-3"):
                ui.input(placeholder="Search...").props("dense outlined").classes(
                    "w-full"
                ).style("font-size: 13px")
            
            # Navigation sections
            with ui.scroll_area().classes("flex-grow"):
                # Collections / Folders
                self._render_section("Collections", "folder", self._render_folders)
                
                # Saved Queries
                self._render_section("Saved Questions", "description", self._render_queries)
                
                # Dashboards
                self._render_section("Dashboards", "dashboard", self._render_dashboards)
            
            # Bottom nav
            with ui.column().classes("border-t border-gray-200 p-2"):
                self._nav_item("/connections", "storage", "Data")
                self._nav_item("/admin", "settings", "Settings")
        
        return self._drawer
    
    def _render_section(self, title: str, icon: str, render_fn: Callable) -> None:
        """Render a collapsible section."""
        with ui.expansion(title, icon=icon).classes("w-full").props("dense"):
            render_fn()
    
    def _render_folders(self) -> None:
        """Render folders list."""
        folders = get_folders()
        if not folders:
            ui.label("No folders yet").classes("text-gray-400 text-sm p-2")
            return
        
        for folder in folders:
            with ui.row().classes(
                "items-center gap-2 px-2 py-1 hover:bg-gray-100 rounded cursor-pointer"
            ):
                ui.icon("folder", size="sm").classes("text-yellow-500")
                ui.label(folder["name"]).classes("text-sm text-gray-700")
    
    def _render_queries(self) -> None:
        """Render saved queries list."""
        queries = get_saved_queries()
        if not queries:
            ui.label("No saved questions yet").classes("text-gray-400 text-sm p-2")
            return
        
        for query in queries:
            with ui.row().classes(
                "items-center gap-2 px-2 py-1 hover:bg-gray-100 rounded cursor-pointer"
            ).on("click", lambda q=query: self._select_query(q)):
                ui.icon("code", size="sm").classes("text-blue-500")
                ui.label(query["name"]).classes("text-sm text-gray-700 truncate")
    
    def _render_dashboards(self) -> None:
        """Render dashboards list."""
        dashboards = get_saved_dashboards()
        if not dashboards:
            ui.label("No dashboards yet").classes("text-gray-400 text-sm p-2")
            return
        
        for dashboard in dashboards:
            with ui.row().classes(
                "items-center gap-2 px-2 py-1 hover:bg-gray-100 rounded cursor-pointer"
            ):
                ui.icon("dashboard", size="sm").classes("text-purple-500")
                ui.label(dashboard["name"]).classes("text-sm text-gray-700")
    
    def _nav_item(self, path: str, icon: str, label: str) -> None:
        """Create a navigation item."""
        with ui.link(target=path).classes("no-underline"):
            with ui.row().classes(
                "items-center gap-3 px-3 py-2 rounded hover:bg-gray-100 cursor-pointer"
            ):
                ui.icon(icon, size="sm").classes("text-gray-500")
                ui.label(label).classes("text-sm text-gray-700")
    
    def _select_query(self, query: dict) -> None:
        """Handle query selection."""
        if self.on_query_select:
            self.on_query_select(query)
        # Navigate to SQL editor with query
        ui.navigate.to(f"/sql?query_id={query['id']}")
    
    def toggle(self) -> None:
        """Toggle the drawer."""
        if self._drawer:
            self._drawer.toggle()


class MetabaseHeader:
    """Metabase-style header bar."""
    
    def __init__(
        self,
        sidebar: MetabaseSidebar | None = None,
        title: str = "",
        show_back: bool = False,
        on_save: Callable | None = None,
    ):
        self.sidebar = sidebar
        self.title = title
        self.show_back = show_back
        self.on_save = on_save
        self._title_label = None
    
    def create(self) -> ui.header:
        """Create the header."""
        with ui.header().classes("bg-white border-b border-gray-200 shadow-sm") as header:
            with ui.row().classes("w-full items-center px-4 py-2 gap-4"):
                # Left section - hamburger + logo/back
                with ui.row().classes("items-center gap-2"):
                    # Hamburger menu
                    ui.button(
                        icon="menu",
                        on_click=lambda: self.sidebar.toggle() if self.sidebar else None,
                    ).props("flat round dense").classes("text-gray-600")
                    
                    # Logo
                    with ui.link(target="/").classes("no-underline"):
                        with ui.row().classes("items-center gap-1"):
                            ui.icon("analytics", size="md").classes("text-blue-500")
                    
                    if self.show_back:
                        ui.button(
                            icon="arrow_back",
                            on_click=lambda: ui.navigate.to("/"),
                        ).props("flat round dense").classes("text-gray-600")
                    
                    # Title (editable if in editor)
                    if self.title:
                        self._title_label = ui.label(self.title).classes(
                            "text-lg font-semibold text-gray-800 ml-2"
                        )
                
                ui.space()
                
                # Center section - Search
                ui.input(placeholder="Search...").props("dense outlined").classes(
                    "w-80"
                ).style("font-size: 14px")
                
                ui.space()
                
                # Right section - New button + Settings + User
                with ui.row().classes("items-center gap-2"):
                    # + New button
                    with ui.button("New", icon="add").props("color=primary"):
                        with ui.menu():
                            ui.menu_item(
                                "Question",
                                lambda: ui.navigate.to("/sql"),
                            )
                            ui.menu_item(
                                "SQL Query",
                                lambda: ui.navigate.to("/sql"),
                            )
                            ui.menu_item(
                                "Dashboard",
                                lambda: ui.navigate.to("/dashboards"),
                            )
                            ui.separator()
                            ui.menu_item(
                                "Collection",
                                lambda: ui.notify("Create collection coming soon"),
                            )
                    
                    # Settings gear
                    ui.button(
                        icon="settings",
                        on_click=lambda: ui.navigate.to("/admin"),
                    ).props("flat round").classes("text-gray-600")
                    
                    # User menu
                    with ui.button(icon="account_circle").props("flat round").classes("text-gray-600"):
                        with ui.menu():
                            ui.menu_item("Profile")
                            ui.menu_item("Account Settings")
                            ui.separator()
                            ui.menu_item("Sign Out")
        
        return header
    
    def set_title(self, title: str) -> None:
        """Update the header title."""
        self.title = title
        if self._title_label:
            self._title_label.text = title


def create_metabase_layout(
    title: str = "",
    show_back: bool = False,
    on_query_select: Callable[[dict], None] | None = None,
) -> tuple[MetabaseSidebar, MetabaseHeader]:
    """Create the full Metabase-style layout with sidebar and header."""
    sidebar = MetabaseSidebar(on_query_select=on_query_select)
    sidebar.create()
    
    header = MetabaseHeader(sidebar=sidebar, title=title, show_back=show_back)
    header.create()
    
    return sidebar, header


# Keep old functions for backward compatibility
def create_sidebar() -> None:
    """Create sidebar - deprecated, use MetabaseSidebar."""
    sidebar = MetabaseSidebar()
    sidebar.create()


def create_header(title: str) -> None:
    """Create header - deprecated, use MetabaseHeader."""
    header = MetabaseHeader(title=title)
    header.create()
