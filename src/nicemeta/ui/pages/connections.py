"""
Connections management page for NiceMeta.
"""

from nicegui import ui

from nicemeta.ui.components.sidebar import (
    MetabaseHeader,
    MetabaseSidebar,
    get_connections,
    refresh_cache,
)
from nicemeta.services.connection_service import (
    ConnectionService,
    create_connection,
    update_connection,
    delete_connection,
    get_connection_by_id,
)

_FILE_TYPES = {"csv", "excel"}

DB_TYPE_OPTIONS = {
    "postgresql": "PostgreSQL",
    "mysql": "MySQL",
    "sqlite": "SQLite",
    "sqlserver": "SQL Server",
    "csv": "CSV File(s)",
    "excel": "Excel File",
}

DB_ICONS = {
    "postgresql": "hub",
    "mysql": "account_tree",
    "sqlite": "folder_open",
    "sqlserver": "window",
    "csv": "table_view",
    "excel": "description",
}


class ConnectionsPage:
    """Connections management page controller."""

    def __init__(self):
        self._cards_container = None

    async def render(self) -> None:
        """Render the connections page."""
        await refresh_cache()

        sidebar = MetabaseSidebar()
        sidebar.create()

        header = MetabaseHeader(sidebar=sidebar, title="Data", show_back=True)
        header.create()

        with ui.column().classes("w-full p-6 gap-6 bg-gray-50 dark:bg-[#252526] min-h-screen"):
            with ui.row().classes("items-center justify-between w-full"):
                ui.label("Data Connections").classes("text-xl font-semibold")
                ui.button(
                    "Add Connection",
                    icon="add",
                    on_click=self._add_connection,
                ).props("color=primary")

            self._cards_container = ui.row().classes("gap-4 flex-wrap")
            self._render_connections()

    def _render_connections(self) -> None:
        """Render connection cards."""
        self._cards_container.clear()
        connections = get_connections()

        with self._cards_container:
            for conn in connections:
                is_file = conn["db_type"] in _FILE_TYPES
                connection_card(
                    name=conn["name"],
                    db_type=conn["db_type"],
                    host=conn["database"] if is_file else f"{conn['host']}:{conn['port']}",
                    database=conn["database"],
                    is_file=is_file,
                    status="unknown",
                    on_test=lambda c=conn: self._test_connection(c),
                    on_edit=lambda c=conn: self._edit_connection(c),
                    on_delete=lambda c=conn: self._delete_connection(c),
                )

            with ui.card().classes(
                "w-80 h-48 flex items-center justify-center cursor-pointer "
                "border-2 border-dashed border-gray-300 dark:border-[#3e3e42] hover:border-blue-400"
            ) as card:
                card.on("click", self._add_connection)
                with ui.column().classes("items-center gap-2 text-gray-400 dark:text-gray-500"):
                    ui.icon("add", size="xl")
                    ui.label("Add Connection")

    # ── Add Connection ──────────────────────────────────────────

    def _add_connection(self) -> None:
        """Show add connection dialog with dynamic fields."""
        with ui.dialog() as dialog, ui.card().classes("w-[90vw] max-w-xl"):
            ui.label("Add Connection").classes("text-lg font-semibold mb-4")

            # Shared fields
            db_type = ui.select(
                label="Database Type",
                options=DB_TYPE_OPTIONS,
                value="postgresql",
            ).classes("w-full")

            name_input = ui.input(
                label="Connection Name", placeholder="My Database"
            ).classes("w-full")

            # Dynamic fields container
            fields = ui.column().classes("w-full gap-4")

            # Mutable state holders
            state = {
                "host": "localhost", "port": 5432, "database": "",
                "user": "", "password": "", "delimiter": ",", "encoding": "utf-8",
            }

            def _rebuild_fields():
                fields.clear()
                with fields:
                    if db_type.value in _FILE_TYPES:
                        _build_file_fields(state, db_type.value)
                    else:
                        _build_db_fields(state)

            db_type.on_value_change(lambda _: _rebuild_fields())
            _rebuild_fields()

            # Actions
            with ui.row().classes("justify-between items-center mt-4"):
                ui.button(
                    "Test Connection", icon="cable",
                    on_click=lambda: self._do_test_connection_from_state(db_type.value, state),
                ).props("flat")

                with ui.row().classes("gap-2"):
                    ui.button("Cancel", on_click=dialog.close).props("flat")

                    async def save_and_close():
                        await self._do_save_connection_from_state(
                            name_input.value, db_type.value, state, dialog,
                        )

                    ui.button("Save", on_click=save_and_close).props("color=primary")

        dialog.open()

    # ── Edit Connection ─────────────────────────────────────────

    def _edit_connection(self, conn: dict) -> None:
        """Edit a connection with dynamic fields."""
        is_file = conn["db_type"] in _FILE_TYPES

        with ui.dialog() as dialog, ui.card().classes("w-[90vw] max-w-xl"):
            ui.label("Edit Connection").classes("text-lg font-semibold mb-4")

            db_type = ui.select(
                label="Database Type",
                options=DB_TYPE_OPTIONS,
                value=conn["db_type"],
            ).classes("w-full")

            name_input = ui.input(
                label="Connection Name", value=conn["name"],
            ).classes("w-full")

            fields = ui.column().classes("w-full gap-4")

            options = conn.get("options") or {}
            state = {
                "host": conn.get("host", "localhost"),
                "port": conn.get("port", 5432),
                "database": conn.get("database", ""),
                "user": conn.get("username", "") or conn.get("user", ""),
                "password": conn.get("password", ""),
                "delimiter": options.get("csv_delimiter", ","),
                "encoding": options.get("csv_encoding", "utf-8"),
            }

            def _rebuild_fields():
                fields.clear()
                with fields:
                    if db_type.value in _FILE_TYPES:
                        _build_file_fields(state, db_type.value)
                    else:
                        _build_db_fields(state)

            db_type.on_value_change(lambda _: _rebuild_fields())
            _rebuild_fields()

            with ui.row().classes("justify-between items-center mt-4"):
                ui.button(
                    "Test Connection", icon="cable",
                    on_click=lambda: self._do_test_connection_from_state(db_type.value, state),
                ).props("flat")

                with ui.row().classes("gap-2"):
                    ui.button("Cancel", on_click=dialog.close).props("flat")

                    async def save_changes():
                        await self._do_update_connection_from_state(
                            conn["id"], name_input.value, db_type.value, state, dialog,
                        )

                    ui.button("Save", on_click=save_changes).props("color=primary")

        dialog.open()

    # ── Test / Save / Update helpers ────────────────────────────

    async def _do_test_connection_from_state(self, db_type: str, state: dict) -> None:
        ui.notify("Testing connection...", type="info")
        try:
            from nicemeta.connections.manager import ConnectionManager
            from nicemeta.config.connections import ConnectionConfig

            config = ConnectionConfig(
                name="Test",
                type=db_type,
                host=state.get("host", "localhost"),
                port=int(state.get("port") or 0),
                database=state["database"],
                user=state.get("user", ""),
                password=state.get("password", ""),
            )

            manager = ConnectionManager()
            adapter = manager.create_adapter(config)

            # Pass CSV options through info.options
            if db_type == "csv" and adapter.info.options is not None:
                adapter.info.options["csv_delimiter"] = state.get("delimiter", ",")
                adapter.info.options["csv_encoding"] = state.get("encoding", "utf-8")

            success, message = await adapter.test_connection()
            if success:
                ui.notify(f"Connection successful: {message}", type="positive")
            else:
                ui.notify(f"Connection failed: {message}", type="negative")
        except Exception as e:
            ui.notify(f"Error: {e}", type="negative")

    async def _do_save_connection_from_state(
        self, name: str, db_type: str, state: dict, dialog,
    ) -> None:
        if not name:
            ui.notify("Please enter a connection name", type="warning")
            return
        if not state.get("database"):
            label = "file path" if db_type in _FILE_TYPES else "database name"
            ui.notify(f"Please enter a {label}", type="warning")
            return

        ui.notify("Saving connection...", type="info")
        try:
            await create_connection(
                name=name,
                db_type=db_type,
                host=state.get("host", ""),
                port=int(state.get("port") or 0),
                database=state["database"],
                username=state.get("user", ""),
                password=state.get("password", ""),
            )
            await refresh_cache()
            self._render_connections()
            ui.notify(f"Connection '{name}' saved!", type="positive")
            dialog.close()
        except Exception as e:
            ui.notify(f"Error saving connection: {e}", type="negative")

    async def _do_update_connection_from_state(
        self, connection_id: str, name: str, db_type: str, state: dict, dialog,
    ) -> None:
        if not name:
            ui.notify("Please enter a connection name", type="warning")
            return
        if not state.get("database"):
            label = "file path" if db_type in _FILE_TYPES else "database name"
            ui.notify(f"Please enter a {label}", type="warning")
            return

        ui.notify("Saving connection...", type="info")
        try:
            await update_connection(
                connection_id=connection_id,
                name=name,
                db_type=db_type,
                host=state.get("host", ""),
                port=int(state.get("port") or 0),
                database=state["database"],
                username=state.get("user", ""),
                password=state.get("password", ""),
            )
            await refresh_cache()
            self._render_connections()
            ui.notify(f"Connection '{name}' updated!", type="positive")
            dialog.close()
        except Exception as e:
            ui.notify(f"Error updating connection: {e}", type="negative")

    async def _test_connection(self, conn: dict) -> None:
        options = conn.get("options") or {}
        state = {
            "host": conn.get("host", ""),
            "port": conn.get("port", 0),
            "database": conn.get("database", ""),
            "user": conn.get("username", "") or conn.get("user", ""),
            "password": conn.get("password", ""),
            "delimiter": options.get("csv_delimiter", ","),
            "encoding": options.get("csv_encoding", "utf-8"),
        }
        ui.notify(f"Testing {conn['name']}...", type="info")
        await self._do_test_connection_from_state(conn["db_type"], state)

    def _delete_connection(self, conn: dict) -> None:
        with ui.dialog() as dialog, ui.card():
            ui.label(f"Delete '{conn['name']}'?").classes("text-lg font-semibold")
            ui.label(
                "This will remove the connection. Queries using it will no longer work."
            ).classes("text-gray-500 dark:text-gray-400")

            async def do_delete():
                await self._do_delete_connection(conn, dialog)

            with ui.row().classes("justify-end gap-2 mt-4"):
                ui.button("Cancel", on_click=dialog.close).props("flat")
                ui.button("Delete", on_click=do_delete).props("color=negative")

        dialog.open()

    async def _do_delete_connection(self, conn: dict, dialog) -> None:
        try:
            await delete_connection(conn["id"])
            await refresh_cache()
            self._render_connections()
            ui.notify(f"Connection '{conn['name']}' deleted", type="info")
            dialog.close()
        except Exception as e:
            ui.notify(f"Error deleting connection: {e}", type="negative")


# ── Form field builders ─────────────────────────────────────────

def _build_db_fields(state: dict) -> None:
    """Build traditional database fields (host, port, database, user, password)."""
    with ui.row().classes("gap-4 w-full"):
        ui.input(
            label="Host", value=state.get("host", "localhost"),
            on_change=lambda e: state.__setitem__("host", e.value),
        ).classes("flex-grow")
        ui.number(
            label="Port", value=state.get("port", 5432),
            on_change=lambda e: state.__setitem__("port", int(e.value or 0)),
        ).classes("w-24")

    ui.input(
        label="Database", value=state.get("database", ""),
        placeholder="mydb",
        on_change=lambda e: state.__setitem__("database", e.value),
    ).classes("w-full")

    with ui.row().classes("gap-4 w-full"):
        ui.input(
            label="Username", value=state.get("user", ""),
            on_change=lambda e: state.__setitem__("user", e.value),
        ).classes("flex-grow")
        ui.input(
            label="Password", value=state.get("password", ""),
            password=True, password_toggle_button=True,
            on_change=lambda e: state.__setitem__("password", e.value),
        ).classes("flex-grow")

    with ui.expansion("Advanced Options", icon="settings").classes("w-full"):
        ui.select(
            label="SSL Mode",
            options=["disable", "allow", "prefer", "require"],
            value="prefer",
        ).classes("w-full")


def _build_file_fields(state: dict, db_type: str) -> None:
    """Build file-based fields (file path, CSV options)."""
    hint = (
        "Path to a .csv file or a directory containing .csv files"
        if db_type == "csv"
        else "Path to an .xlsx or .xls file"
    )
    ui.input(
        label="File / Directory Path",
        value=state.get("database", ""),
        placeholder="/path/to/data.csv" if db_type == "csv" else "/path/to/data.xlsx",
        on_change=lambda e: state.__setitem__("database", e.value),
    ).classes("w-full").tooltip(hint)

    if db_type == "csv":
        with ui.expansion("CSV Options", icon="settings").classes("w-full"):
            with ui.row().classes("gap-4"):
                ui.input(
                    label="Delimiter", value=state.get("delimiter", ","),
                    on_change=lambda e: state.__setitem__("delimiter", e.value),
                ).classes("w-24")
                ui.select(
                    label="Encoding",
                    options=["utf-8", "latin-1", "windows-1252", "ascii"],
                    value=state.get("encoding", "utf-8"),
                    on_change=lambda e: state.__setitem__("encoding", e.value),
                ).classes("w-40")


# ── Connection Card ─────────────────────────────────────────────

def connection_card(
    name: str,
    db_type: str,
    host: str,
    database: str,
    is_file: bool = False,
    status: str = "unknown",
    on_test=None,
    on_edit=None,
    on_delete=None,
) -> ui.element:
    """Create a connection card."""
    status_colors = {
        "connected": "text-gray-500 dark:text-gray-400",
        "error": "text-red-500",
        "unknown": "text-gray-400 dark:text-gray-500",
    }

    with ui.card().classes("w-80"):
        with ui.row().classes("items-center justify-between"):
            with ui.row().classes("items-center gap-2"):
                ui.icon(DB_ICONS.get(db_type, "storage"), size="md").classes(
                    "text-gray-500 dark:text-gray-400"
                )
                ui.label(name).classes("font-semibold")

            with ui.button(icon="more_vert").props("flat round dense"):
                with ui.menu():
                    ui.menu_item("Test Connection", on_test)
                    ui.menu_item("Edit", on_edit)
                    ui.separator()
                    ui.menu_item("Delete", on_delete)

        with ui.column().classes("mt-2 gap-1"):
            if is_file:
                with ui.row().classes("items-center gap-2 text-sm text-gray-500 dark:text-gray-400"):
                    ui.icon("insert_drive_file", size="xs")
                    ui.label(database).classes("truncate").style("max-width: 250px")
            else:
                with ui.row().classes("items-center gap-2 text-sm text-gray-500 dark:text-gray-400"):
                    ui.icon("dns", size="xs")
                    ui.label(host)
                with ui.row().classes("items-center gap-2 text-sm text-gray-500 dark:text-gray-400"):
                    ui.icon("database", size="xs")
                    ui.label(database)

        with ui.row().classes("items-center gap-2 mt-3"):
            ui.icon("circle", size="xs").classes(
                status_colors.get(status, "text-gray-400 dark:text-gray-500")
            )
            ui.label(DB_TYPE_OPTIONS.get(db_type, db_type)).classes(
                "text-sm text-gray-500 dark:text-gray-400"
            )

    return None


async def connections_page() -> None:
    """Entry point for connections page."""
    page = ConnectionsPage()
    await page.render()
