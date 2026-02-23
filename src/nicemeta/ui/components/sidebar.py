"""
Metabase-style sidebar and header components.
"""

import asyncio
import logging
from datetime import datetime
from typing import Callable

logger = logging.getLogger(__name__)

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
from nicemeta.services.git_service import get_git_service

# Cache for queries (refreshed on demand)
_cached_queries: list[dict] = []
_cached_connections: list[dict] = []
_cached_dashboards: list[dict] = []
_cache_initialized: bool = False

# Folders (still in-memory for now)
_folders: list[dict] = [
    {"id": "1", "name": "My Queries", "parent_id": None},
]

# JavaScript for drag-to-resize sidebar, with localStorage persistence.
# Text clips at the resize line because the drawer has overflow:hidden.
_RESIZE_JS = """
(function() {
  var KEY = 'nm_sw';
  var MIN = 44;
  var MAX = 500;

  function applyWidth(w) {
    var styleEl = document.getElementById('nm-w-override');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'nm-w-override';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent =
      '.q-drawer--left{width:' + w + 'px!important;min-width:0!important}';
    var pc = document.querySelector('.q-page-container');
    if (pc) pc.style.setProperty('padding-left', w + 'px', 'important');
  }

  function init() {
    var drawer = document.querySelector('.q-drawer--left');
    if (!drawer || document.getElementById('nm-rh')) return;

    // Re-apply saved width whenever drawer style changes (e.g. after toggle)
    var obs = new MutationObserver(function() {
      var saved = parseInt(localStorage.getItem(KEY) || '0', 10);
      if (saved >= MIN && saved <= MAX) setTimeout(function(){ applyWidth(saved); }, 30);
    });
    obs.observe(drawer, { attributes: true, attributeFilter: ['style'] });

    var rh = document.createElement('div');
    rh.id = 'nm-rh';
    rh.style.cssText = [
      'position:absolute', 'right:0', 'top:0',
      'width:5px', 'height:100%', 'cursor:col-resize',
      'z-index:9999', 'user-select:none', 'border-radius:0 2px 2px 0'
    ].join(';');
    drawer.appendChild(rh);

    rh.addEventListener('mouseenter', function() {
      rh.style.background = 'rgba(86,156,214,0.45)';
    });
    rh.addEventListener('mouseleave', function() {
      if (!rh._d) rh.style.background = '';
    });

    rh.addEventListener('mousedown', function(e) {
      e.preventDefault();
      rh._d = true;
      rh.style.background = 'rgba(86,156,214,0.7)';
      document.body.classList.add('nm-resizing');
      var x0 = e.clientX;
      var w0 = drawer.offsetWidth;

      function mv(e) {
        applyWidth(Math.max(MIN, Math.min(MAX, w0 + e.clientX - x0)));
      }
      function up() {
        rh._d = false;
        rh.style.background = '';
        document.body.classList.remove('nm-resizing');
        localStorage.setItem(KEY, drawer.offsetWidth);
        window.removeEventListener('mousemove', mv);
        window.removeEventListener('mouseup', up);
      }
      window.addEventListener('mousemove', mv);
      window.addEventListener('mouseup', up);
    });

    var saved = parseInt(localStorage.getItem(KEY) || '0', 10);
    if (saved >= MIN && saved <= MAX) applyWidth(saved);
  }

  var n = 0;
  var iv = setInterval(function() {
    n++;
    if (n > 50) { clearInterval(iv); return; }
    if (document.querySelector('.q-drawer--left')) { clearInterval(iv); setTimeout(init, 80); }
  }, 100);
})();
"""


async def refresh_cache() -> None:
    """Refresh the cached queries, connections, and dashboards from database."""
    global _cached_queries, _cached_connections, _cached_dashboards, _cache_initialized
    try:
        _cached_queries = await db_get_saved_queries()
        _cached_connections = await db_get_connections()
        _cached_dashboards = await db_get_dashboards()
        _cache_initialized = True
    except Exception as e:
        logger.exception("Error refreshing cache")


def get_saved_queries() -> list[dict]:
    return _cached_queries


async def get_saved_queries_async() -> list[dict]:
    return await db_get_saved_queries()


async def get_query_by_id(query_id: str) -> dict | None:
    return await db_get_query_by_id(query_id)


async def save_query(
    name: str,
    sql: str,
    connection_id: str,
    folder_id: str | None = None,
    query_id: str | None = None,
) -> dict:
    global _cached_queries
    result = await db_save_query(
        name=name, sql=sql, connection_id=connection_id,
        folder_id=folder_id, query_id=query_id,
    )
    await refresh_cache()
    asyncio.ensure_future(get_git_service().sync_query(result))
    return result


async def delete_query(query_id: str) -> bool:
    global _cached_queries
    item = await db_get_query_by_id(query_id)
    result = await db_delete_query(query_id)
    await refresh_cache()
    if result and item:
        asyncio.ensure_future(get_git_service().sync_query(item, deleted=True))
    return result


def get_connections() -> list[dict]:
    return _cached_connections


async def get_connections_async() -> list[dict]:
    return await db_get_connections()


async def get_connection_by_id(connection_id: str) -> dict | None:
    return await db_get_connection_by_id(connection_id)


def get_folders() -> list[dict]:
    return _folders


def get_saved_dashboards() -> list[dict]:
    return _cached_dashboards


async def get_saved_dashboards_async() -> list[dict]:
    return await db_get_dashboards()


async def get_dashboard_by_id(dashboard_id: str) -> dict | None:
    return await db_get_dashboard_by_id(dashboard_id)


async def create_dashboard(name: str, description: str | None = None) -> dict:
    result = await db_create_dashboard(name=name, description=description)
    await refresh_cache()
    asyncio.ensure_future(get_git_service().sync_dashboard(result))
    return result


async def delete_dashboard(dashboard_id: str) -> bool:
    item = await db_get_dashboard_by_id(dashboard_id)
    result = await db_delete_dashboard(dashboard_id)
    await refresh_cache()
    if result and item:
        asyncio.ensure_future(get_git_service().sync_dashboard(item, deleted=True))
    return result


class MetabaseSidebar:
    """
    Persistent left sidebar.
    - Single scrollable area (all items scroll together).
    - Drag the right edge to resize; text clips at the resize line.
    - Width is saved to localStorage and restored on next load.
    """

    def __init__(self, on_query_select: Callable[[dict], None] | None = None):
        self.on_query_select = on_query_select
        self._drawer = None
        self._queries_container = None
        self._search_input = None
        self._search_term = ""

    def create(self) -> ui.left_drawer:
        """Create the sidebar drawer."""
        # behavior=desktop → persistent on desktop, overlay on mobile
        self._drawer = ui.left_drawer(value=True).props(
            "behavior=desktop bordered"
        ).style("width: 240px; min-width: 0; overflow: hidden;")

        with self._drawer:
            # One scroll area for everything — no separate fixed sections
            with ui.scroll_area().style("height: 100%; overflow-x: hidden;").classes("w-full"):
                with ui.column().classes("w-full gap-0").style("min-width: 0;"):

                    # ── Logo ─────────────────────────────────────────
                    with ui.link(target="/").classes("no-underline w-full"):
                        with ui.row().classes(
                            "items-center gap-2 px-4 py-3 nm-sidebar-row"
                        ):
                            ui.icon("analytics", size="sm").classes(
                                "text-blue-500 flex-shrink-0"
                            )
                            ui.label("NiceMeta").classes(
                                "text-base font-bold nm-sidebar-label"
                            )

                    # ── Search ────────────────────────────────────────
                    with ui.row().classes("px-3 py-2 w-full").style("min-width:0"):
                        self._search_input = ui.input(
                            placeholder="Search...",
                            on_change=lambda e: self._filter_queries(e.value),
                        ).props("dense outlined clearable").classes("w-full").style(
                            "font-size:13px"
                        )

                    ui.separator().classes("nm-sidebar-sep")

                    # ── Primary navigation ────────────────────────────
                    with ui.column().classes("w-full gap-0 px-2 py-1"):
                        self._nav_item("/", "home", "Home")
                        self._nav_item("/sql", "code", "SQL Editor")
                        self._nav_item("/query-builder", "build", "Query Builder")
                        self._nav_item("/dashboards", "dashboard", "Dashboards")

                    ui.separator().classes("nm-sidebar-sep")

                    # ── Browse label ──────────────────────────────────
                    ui.label("Browse").classes("nm-sidebar-section-label")

                    # ── Collections ───────────────────────────────────
                    with ui.expansion("Collections", icon="folder").classes(
                        "w-full nm-sidebar-expansion"
                    ).props("dense"):
                        self._render_folders()

                    # ── Saved Questions ───────────────────────────────
                    with ui.expansion("Saved Questions", icon="description").classes(
                        "w-full nm-sidebar-expansion"
                    ).props("dense"):
                        self._queries_container = ui.column().classes("w-full gap-0")
                        with self._queries_container:
                            self._render_queries_sync()

                    # ── Dashboards ────────────────────────────────────
                    with ui.expansion("Our Dashboards", icon="dashboard").classes(
                        "w-full nm-sidebar-expansion"
                    ).props("dense"):
                        self._render_dashboards()

                    ui.separator().classes("nm-sidebar-sep")

                    # ── Utility nav ───────────────────────────────────
                    with ui.column().classes("w-full gap-0 px-2 py-1"):
                        self._nav_item("/connections", "storage", "Data")
                        self._nav_item("/admin", "settings", "Settings")

                    # ── Theme toggle ──────────────────────────────────
                    with ui.row().classes("nm-sidebar-row px-4 py-2 gap-2"):
                        create_theme_toggle()
                        ui.label("Theme").classes("text-sm nm-sidebar-label")

        # Init cache then inject resize JS
        async def _init():
            await refresh_cache()
            self._refresh_queries_display()
            ui.run_javascript(_RESIZE_JS)

        ui.timer(0.1, _init, once=True)
        return self._drawer

    # ── Rendering helpers ─────────────────────────────────────────────────────

    def _render_folders(self) -> None:
        folders = get_folders()
        if not folders:
            ui.label("No collections yet").classes("text-gray-400 text-sm px-3 py-1")
            return
        for folder in folders:
            with ui.row().classes("nm-sidebar-row nm-sidebar-child hover:bg-gray-100 rounded cursor-pointer"):
                ui.icon("folder", size="xs").classes("text-yellow-500 flex-shrink-0")
                ui.label(folder["name"]).classes("text-sm nm-sidebar-label")

    def _render_queries_sync(self) -> None:
        queries = get_saved_queries()
        if self._search_term:
            queries = [q for q in queries if self._search_term in q["name"].lower()]
        if not queries:
            msg = "No matches" if self._search_term else "No saved questions yet"
            ui.label(msg).classes("text-gray-400 text-sm px-3 py-1")
            return
        for query in queries:
            with ui.row().classes(
                "nm-sidebar-row nm-sidebar-child hover:bg-gray-100 rounded cursor-pointer"
            ).on("click", lambda q=query: self._select_query(q)):
                ui.icon("code", size="xs").classes("text-blue-500 flex-shrink-0")
                ui.label(query["name"]).classes("text-sm nm-sidebar-label")

    def _render_dashboards(self) -> None:
        dashboards = get_saved_dashboards()
        if not dashboards:
            ui.label("No dashboards yet").classes("text-gray-400 text-sm px-3 py-1")
            return
        for dashboard in dashboards:
            with ui.row().classes(
                "nm-sidebar-row nm-sidebar-child hover:bg-gray-100 rounded cursor-pointer"
            ).on("click", lambda d=dashboard: ui.navigate.to(f"/dashboards/{d['id']}")):
                ui.icon("dashboard", size="xs").classes("text-purple-500 flex-shrink-0")
                ui.label(dashboard["name"]).classes("text-sm nm-sidebar-label")

    def _refresh_queries_display(self) -> None:
        if self._queries_container:
            self._queries_container.clear()
            with self._queries_container:
                self._render_queries_sync()

    def _filter_queries(self, term: str) -> None:
        self._search_term = (term or "").strip().lower()
        self._refresh_queries_display()

    def _nav_item(self, path: str, icon: str, label: str) -> None:
        current = self._current_path()
        is_active = current == path or (path != "/" and current.startswith(path))
        active_cls = " nm-nav-active" if is_active else ""
        icon_cls = "text-blue-500 flex-shrink-0" if is_active else "text-gray-500 flex-shrink-0"
        lbl_cls = "text-sm font-semibold nm-sidebar-label" if is_active else "text-sm nm-sidebar-label"

        with ui.link(target=path).classes("no-underline w-full"):
            with ui.row().classes(f"nm-sidebar-row rounded cursor-pointer{active_cls}"):
                ui.icon(icon, size="xs").classes(icon_cls)
                ui.label(label).classes(lbl_cls)

    @staticmethod
    def _current_path() -> str:
        try:
            return ui.context.client.request.url.path
        except Exception:
            return "/"

    def _select_query(self, query: dict) -> None:
        if self.on_query_select:
            self.on_query_select(query)
        ui.navigate.to(f"/sql?query_id={query['id']}")

    def toggle(self) -> None:
        if self._drawer:
            self._drawer.toggle()

    async def refresh(self) -> None:
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
        agent=None,  # AgentPanel | None  (avoid circular import with type hint)
    ):
        self.sidebar = sidebar
        self.title = title
        self.show_back = show_back
        self.on_save = on_save
        self.agent = agent
        self._title_label = None

    def create(self) -> ui.header:
        inject_theme()
        apply_saved_theme()

        with ui.header().classes("bg-white border-b border-gray-200 shadow-sm") as header:
            with ui.row().classes("w-full items-center px-4 py-2 gap-4"):
                with ui.row().classes("items-center gap-2"):
                    ui.button(
                        icon="menu",
                        on_click=lambda: self.sidebar.toggle() if self.sidebar else None,
                    ).props("flat round dense").classes("text-gray-600")

                    with ui.link(target="/").classes("no-underline"):
                        ui.icon("analytics", size="md").classes("text-blue-500")

                    if self.show_back:
                        ui.button(
                            icon="arrow_back",
                            on_click=lambda: ui.navigate.to("/"),
                        ).props("flat round dense").classes("text-gray-600")

                    if self.title:
                        self._title_label = ui.label(self.title).classes(
                            "text-lg font-semibold text-gray-800 ml-2"
                        )

                ui.space()

                ui.input(placeholder="Search...").props("dense outlined").classes(
                    "w-80"
                ).style("font-size: 14px")

                ui.space()

                with ui.row().classes("items-center gap-2"):
                    with ui.button("New", icon="add").props("color=primary"):
                        with ui.menu():
                            ui.menu_item("SQL Query", lambda: ui.navigate.to("/sql"))
                            ui.menu_item("Question", lambda: ui.navigate.to("/query-builder"))
                            ui.menu_item("Dashboard", lambda: ui.navigate.to("/dashboards"))

                    # AI Agent toggle button
                    _agent = self.agent
                    ui.button(
                        icon="smart_toy",
                        on_click=lambda: _agent.toggle() if _agent else None,
                    ).props("flat round").classes("text-gray-600").tooltip("AI Agent")

                    create_theme_toggle()

                    ui.button(
                        icon="settings",
                        on_click=lambda: ui.navigate.to("/admin"),
                    ).props("flat round").classes("text-gray-600")

                    with ui.button(icon="account_circle").props("flat round").classes("text-gray-600"):
                        with ui.menu():
                            ui.menu_item("Profile")
                            ui.menu_item("Account Settings")
                            ui.separator()
                            ui.menu_item("Sign Out")

        return header

    def set_title(self, title: str) -> None:
        self.title = title
        if self._title_label:
            self._title_label.text = title


def create_metabase_layout(
    title: str = "",
    show_back: bool = False,
    on_query_select: Callable[[dict], None] | None = None,
) -> tuple:
    """
    Create the full Metabase-style layout: sidebar + header + agent panel.
    Returns (MetabaseSidebar, MetabaseHeader, AgentPanel).
    """
    from nicemeta.ui.components.agent_panel import AgentPanel

    sidebar = MetabaseSidebar(on_query_select=on_query_select)
    sidebar.create()

    agent = AgentPanel()
    agent.create()

    header = MetabaseHeader(sidebar=sidebar, title=title, show_back=show_back, agent=agent)
    header.create()

    return sidebar, header, agent


# Backward-compat stubs
def create_sidebar() -> None:
    MetabaseSidebar().create()


def create_header(title: str) -> None:
    MetabaseHeader(title=title).create()
