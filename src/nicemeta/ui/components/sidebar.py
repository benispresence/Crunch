"""
Metabase-style sidebar and header components.
"""

import asyncio
from datetime import datetime
from typing import Callable

from nicegui import app, ui

from nicemeta.ui.theme import inject_theme, apply_saved_theme, create_theme_toggle

# Import database services
from nicemeta.services.query_service import (
    QueryService,
    get_saved_queries as db_get_saved_queries,
    save_query as db_save_query,
    delete_query as db_delete_query,
    get_query_by_id as db_get_query_by_id,
)
from nicemeta.services.connection_service import (
    ConnectionService,
    get_connections as db_get_connections,
    get_connection_by_id as db_get_connection_by_id,
)
from nicemeta.services.dashboard_service import (
    DashboardService,
    get_dashboards as db_get_dashboards,
    get_dashboard_by_id as db_get_dashboard_by_id,
    create_dashboard as db_create_dashboard,
    delete_dashboard as db_delete_dashboard,
)

# Cache for queries (refreshed on demand)
_cached_queries: list[dict] = []
_cached_connections: list[dict] = []
_cached_dashboards: list[dict] = []
_cache_initialized: bool = False

# Folders (still in-memory for now - can be moved to DB later)
_folders: list[dict] = [
    {"id": "1", "name": "My Queries", "parent_id": None},
]


async def refresh_cache() -> None:
    """Refresh the cached queries, connections, and dashboards from database."""
    global _cached_queries, _cached_connections, _cached_dashboards, _cache_initialized
    try:
        _cached_queries = await db_get_saved_queries()
        _cached_connections = await db_get_connections()
        _cached_dashboards = await db_get_dashboards()
        _cache_initialized = True
    except Exception as e:
        print(f"Error refreshing cache: {e}")


def get_saved_queries() -> list[dict]:
    """Get all saved queries (from cache)."""
    return _cached_queries


async def get_saved_queries_async() -> list[dict]:
    """Get all saved queries from database."""
    return await db_get_saved_queries()


async def get_query_by_id(query_id: str) -> dict | None:
    """Get a query by ID from database."""
    return await db_get_query_by_id(query_id)


async def save_query(
    name: str,
    sql: str,
    connection_id: str,
    folder_id: str | None = None,
    query_id: str | None = None,
) -> dict:
    """Save a query to database."""
    global _cached_queries
    result = await db_save_query(
        name=name,
        sql=sql,
        connection_id=connection_id,
        folder_id=folder_id,
        query_id=query_id,
    )
    # Refresh cache after save
    await refresh_cache()
    return result


async def delete_query(query_id: str) -> bool:
    """Delete a query from database."""
    global _cached_queries
    result = await db_delete_query(query_id)
    # Refresh cache after delete
    await refresh_cache()
    return result


def get_connections() -> list[dict]:
    """Get all connections (from cache)."""
    return _cached_connections


async def get_connections_async() -> list[dict]:
    """Get all connections from database."""
    return await db_get_connections()


async def get_connection_by_id(connection_id: str) -> dict | None:
    """Get a connection by ID from database."""
    return await db_get_connection_by_id(connection_id)


def get_folders() -> list[dict]:
    """Get all folders."""
    return _folders


def get_saved_dashboards() -> list[dict]:
    """Get all saved dashboards (from cache)."""
    return _cached_dashboards


async def get_saved_dashboards_async() -> list[dict]:
    """Get all saved dashboards from database."""
    return await db_get_dashboards()


async def get_dashboard_by_id(dashboard_id: str) -> dict | None:
    """Get a dashboard by ID from database."""
    return await db_get_dashboard_by_id(dashboard_id)


async def create_dashboard(name: str, description: str | None = None) -> dict:
    """Create a new dashboard."""
    result = await db_create_dashboard(name=name, description=description)
    await refresh_cache()
    return result


async def delete_dashboard(dashboard_id: str) -> bool:
    """Delete a dashboard."""
    result = await db_delete_dashboard(dashboard_id)
    await refresh_cache()
    return result


class MetabaseSidebar:
    """Collapsible sidebar with saved items like Metabase."""
    
    def __init__(self, on_query_select: Callable[[dict], None] | None = None):
        self.on_query_select = on_query_select
        self._drawer = None
        self._queries_container = None
        self._search_input = None
        self._search_term = ""
    
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
            
            # Search in sidebar (filters saved queries)
            with ui.row().classes("p-3"):
                self._search_input = ui.input(
                    placeholder="Search saved queries...",
                    on_change=lambda e: self._filter_queries(e.value),
                ).props("dense outlined clearable").classes(
                    "w-full"
                ).style("font-size: 13px")
            
            # Navigation sections
            with ui.scroll_area().classes("flex-grow"):
                # Collections / Folders
                self._render_section("Collections", "folder", self._render_folders)
                
                # Saved Queries
                with ui.expansion("Saved Questions", icon="description").classes("w-full").props("dense"):
                    self._queries_container = ui.column().classes("w-full")
                    with self._queries_container:
                        self._render_queries_sync()
                
                # Dashboards
                self._render_section("Dashboards", "dashboard", self._render_dashboards)
            
            # Main nav
            with ui.column().classes("px-2 py-1"):
                self._nav_item("/", "home", "Home")
                self._nav_item("/sql", "code", "SQL Editor")
                self._nav_item("/query-builder", "build", "Query Builder")
                self._nav_item("/dashboards", "dashboard", "Dashboards")

            # Bottom nav
            with ui.column().classes("border-t border-gray-200 p-2"):
                self._nav_item("/connections", "storage", "Data")
                self._nav_item("/admin", "settings", "Settings")
                with ui.row().classes("items-center gap-2 px-3 py-1"):
                    create_theme_toggle()
        
        # Schedule cache refresh
        async def init_cache():
            await refresh_cache()
            self._refresh_queries_display()
        
        ui.timer(0.1, init_cache, once=True)
        
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
    
    def _render_queries_sync(self) -> None:
        """Render saved queries list (synchronous, uses cache)."""
        queries = get_saved_queries()
        if self._search_term:
            queries = [q for q in queries if self._search_term in q["name"].lower()]
        if not queries:
            msg = "No matches" if self._search_term else "No saved questions yet"
            ui.label(msg).classes("text-gray-400 text-sm p-2")
            return

        for query in queries:
            with ui.row().classes(
                "items-center gap-2 px-2 py-1 hover:bg-gray-100 rounded cursor-pointer"
            ).on("click", lambda q=query: self._select_query(q)):
                ui.icon("code", size="sm").classes("text-blue-500")
                ui.label(query["name"]).classes("text-sm text-gray-700 truncate")
    
    def _refresh_queries_display(self) -> None:
        """Refresh the queries display after cache update."""
        if self._queries_container:
            self._queries_container.clear()
            with self._queries_container:
                self._render_queries_sync()

    def _filter_queries(self, term: str) -> None:
        """Filter displayed queries by search term."""
        self._search_term = (term or "").strip().lower()
        self._refresh_queries_display()
    
    def _render_dashboards(self) -> None:
        """Render dashboards list."""
        dashboards = get_saved_dashboards()
        if not dashboards:
            ui.label("No dashboards yet").classes("text-gray-400 text-sm p-2")
            return
        
        for dashboard in dashboards:
            with ui.row().classes(
                "items-center gap-2 px-2 py-1 hover:bg-gray-100 rounded cursor-pointer"
            ).on("click", lambda d=dashboard: ui.navigate.to(f"/dashboards/{d['id']}")):
                ui.icon("dashboard", size="sm").classes("text-purple-500")
                with ui.column().classes("gap-0 flex-grow"):
                    ui.label(dashboard["name"]).classes("text-sm text-gray-700 truncate")
                    widget_count = dashboard.get("widget_count", 0)
                    ui.label(f"{widget_count} widget{'s' if widget_count != 1 else ''}").classes(
                        "text-xs text-gray-400"
                    )
    
    def _nav_item(self, path: str, icon: str, label: str) -> None:
        """Create a navigation item with active page highlighting."""
        current = self._current_path()
        is_active = current == path or (path != "/" and current.startswith(path))
        active_cls = " nm-nav-active" if is_active else ""
        with ui.link(target=path).classes("no-underline"):
            with ui.row().classes(
                f"items-center gap-3 px-3 py-2 rounded hover:bg-gray-100 cursor-pointer{active_cls}"
            ):
                ui.icon(icon, size="sm").classes("text-blue-500" if is_active else "text-gray-500")
                ui.label(label).classes("text-sm " + ("font-semibold" if is_active else "text-gray-700"))

    @staticmethod
    def _current_path() -> str:
        """Get the current page path."""
        try:
            return ui.context.client.request.url.path
        except Exception:
            return "/"
    
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
    
    async def refresh(self) -> None:
        """Refresh the sidebar content."""
        await refresh_cache()
        self._refresh_queries_display()


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
        # Inject theme CSS and apply saved preference
        inject_theme()
        apply_saved_theme()

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
                    
                    # Theme toggle
                    create_theme_toggle()

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
