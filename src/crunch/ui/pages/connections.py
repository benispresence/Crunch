"""
Connections management page for NiceMeta.
"""

import shutil
import uuid
from pathlib import Path

from nicegui import ui
from nicegui.events import UploadEventArguments

from crunch.ui.components.agent_panel import AgentPanel
from crunch.ui.components.sidebar import (
    MetabaseHeader,
    MetabaseSidebar,
    get_connections,
    refresh_cache,
)
from crunch.services.connection_service import (
    ConnectionService,
    create_connection,
    update_connection,
    delete_connection,
    get_connection_by_id,
)

# Upload directory for file-based connections
UPLOAD_BASE = Path("data/uploads")

# Supported file extensions for CSV/Excel
FILE_EXTS = {".csv", ".tsv", ".txt", ".xlsx", ".xls"}

DB_TYPE_OPTIONS = {
    "postgresql": "PostgreSQL",
    "mysql": "MySQL",
    "sqlite": "SQLite",
    "sqlserver": "SQL Server",
    "file": "CSV / Excel",
}

DB_ICONS = {
    "postgresql": "🐘",
    "mysql": "🐬",
    "sqlite": "📁",
    "sqlserver": "🪟",
    "file": "📄",
}


def _get_upload_dir(connection_id: str) -> Path:
    """Get the upload directory for a file connection."""
    return UPLOAD_BASE / connection_id


def _list_uploaded_files(connection_id: str) -> list[Path]:
    """List uploaded files for a connection."""
    upload_dir = _get_upload_dir(connection_id)
    if not upload_dir.is_dir():
        return []
    return sorted(p for p in upload_dir.iterdir() if p.is_file() and p.suffix.lower() in FILE_EXTS)


def _open_file_browser(target_input: ui.input) -> None:
    """Open a file browser dialog to pick files or folders.

    When the user selects a file or folder, the path is written into *target_input*.
    """
    current_dir: list[Path] = [Path.home()]

    with ui.dialog() as browser_dialog, ui.card().classes("w-[600px] max-h-[80vh]"):
        ui.label("Browse Files").classes("text-lg font-semibold")

        # Path breadcrumb / current path display
        path_label = ui.label(str(current_dir[0])).classes(
            "text-sm text-grey-6 break-all"
        )

        listing_container = ui.scroll_area().classes("w-full").style("height: 350px")

        def _navigate(directory: Path) -> None:
            current_dir[0] = directory
            path_label.text = str(directory)
            _render_listing()

        def _render_listing() -> None:
            listing_container.clear()
            directory = current_dir[0]

            with listing_container:
                try:
                    entries = sorted(directory.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
                except PermissionError:
                    ui.label("Permission denied").classes("text-sm text-negative p-2")
                    return

                # Parent directory link
                if directory.parent != directory:
                    with ui.row().classes(
                        "items-center gap-2 w-full px-2 py-1 cursor-pointer rounded hover:bg-grey-2"
                    ).on("click", lambda d=directory.parent: _navigate(d)):
                        ui.icon("arrow_upward", size="sm").classes("text-grey-6")
                        ui.label("..").classes("text-sm font-medium")

                for entry in entries:
                    if entry.name.startswith("."):
                        continue  # skip hidden files

                    is_dir = entry.is_dir()
                    is_data = entry.is_file() and entry.suffix.lower() in FILE_EXTS

                    if not is_dir and not is_data:
                        continue  # only show dirs and supported files

                    icon_name = "folder" if is_dir else "description"
                    icon_color = "text-warning" if is_dir else "text-grey-6"

                    with ui.row().classes(
                        "items-center gap-2 w-full px-2 py-1 cursor-pointer rounded hover:bg-grey-2"
                    ) as row:
                        ui.icon(icon_name, size="sm").classes(icon_color)
                        ui.label(entry.name).classes(
                            "text-sm flex-grow" + (" font-medium" if is_dir else "")
                        )
                        if is_data:
                            size_kb = entry.stat().st_size / 1024
                            ui.label(f"{size_kb:.0f} KB").classes("text-xs text-grey-5")

                        if is_dir:
                            row.on("click", lambda d=entry: _navigate(d))
                        else:
                            def _select_file(p=entry):
                                target_input.value = str(p)
                                browser_dialog.close()
                            row.on("click", lambda p=entry: _select_file(p))

        _render_listing()

        with ui.row().classes("justify-between items-center mt-3 w-full"):
            def _select_folder():
                target_input.value = str(current_dir[0])
                browser_dialog.close()

            ui.button("Select This Folder", icon="folder_open", on_click=_select_folder).props(
                "flat"
            )
            ui.button("Cancel", on_click=browser_dialog.close).props("flat")

    browser_dialog.open()


class ConnectionsPage:
    """Connections management page controller."""

    def __init__(self):
        self._cards_container = None
        self._page_container = None
        self._header = None

    async def render(self) -> None:
        """Render the connections page."""
        await refresh_cache()

        sidebar = MetabaseSidebar()
        sidebar.create()

        agent = AgentPanel()
        agent.create()

        self._header = MetabaseHeader(sidebar=sidebar, title="Data", show_back=True, agent=agent)
        self._header.create()

        self._page_container = ui.column().classes("w-full p-6 gap-6 min-h-screen")
        with self._page_container:
            self._render_card_grid()

    def _render_card_grid(self) -> None:
        """Render the connection cards grid view."""
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
                if conn["db_type"] == "file":
                    opts = conn.get("options") or {}
                    file_list = opts.get("files", [])
                    file_count = len(file_list)
                    file_names = ", ".join(
                        Path(f).name for f in file_list[:3]
                    ) if file_list else conn.get("database", "No files")
                    connection_card(
                        name=conn["name"],
                        db_type=conn["db_type"],
                        host=f"{file_count} file(s)" if file_count else conn.get("database", ""),
                        database=file_names,
                        on_click=lambda c=conn: self._view_connection(c),
                        on_test=lambda c=conn: self._test_connection(c),
                        on_edit=lambda c=conn: self._edit_connection(c),
                        on_delete=lambda c=conn: self._delete_connection(c),
                    )
                else:
                    connection_card(
                        name=conn["name"],
                        db_type=conn["db_type"],
                        host=f"{conn['host']}:{conn['port']}",
                        database=conn["database"],
                        on_click=lambda c=conn: self._view_connection(c),
                        on_test=lambda c=conn: self._test_connection(c),
                        on_edit=lambda c=conn: self._edit_connection(c),
                        on_delete=lambda c=conn: self._delete_connection(c),
                    )

            with ui.card().classes(
                "w-80 h-48 flex items-center justify-center cursor-pointer "
                "border-2 border-dashed border"
            ) as card:
                card.on("click", self._add_connection)
                with ui.column().classes("items-center gap-2 text-grey-5"):
                    ui.icon("add_circle_outline", size="xl")
                    ui.label("Add Connection")

    async def _view_connection(self, conn: dict) -> None:
        """Show the detail view for a connection (schemas → tables → columns)."""
        self._page_container.clear()

        with self._page_container:
            # Breadcrumb
            with ui.row().classes("items-center gap-2"):
                ui.button(
                    "Data",
                    icon="arrow_back",
                    on_click=self._back_to_grid,
                ).props("flat dense")
                ui.icon("chevron_right", size="xs").classes("text-grey-5")
                icon = DB_ICONS.get(conn["db_type"], "📊")
                ui.label(f"{icon}  {conn['name']}").classes("text-lg font-semibold")

            # Loading indicator
            loading = ui.row().classes("items-center gap-2 p-4")
            with loading:
                ui.spinner("dots", size="md")
                ui.label("Loading schemas and tables...").classes("text-grey-6")

            try:
                from crunch.ui.utils import create_adapter_from_connection
                adapter = await create_adapter_from_connection(conn)
                schemas = await adapter.get_schemas()

                # Load all tables grouped by schema
                schema_tables = {}
                for schema in schemas:
                    tables = await adapter.get_tables(schema)
                    schema_tables[schema] = tables

                await adapter.close()

                loading.delete()

                # Render schemas and tables
                if not schemas:
                    ui.label("No schemas found").classes("text-grey-6 p-4")
                    return

                for schema in schemas:
                    tables = schema_tables.get(schema, [])
                    with ui.expansion(
                        f"{schema} ({len(tables)} tables)",
                        icon="schema",
                        value=len(schemas) == 1,  # auto-expand if single schema
                    ).classes("w-full"):
                        if not tables:
                            ui.label("No tables").classes("text-grey-6 text-sm p-2")
                            continue

                        # Table list
                        columns_def = [
                            {"name": "icon", "label": "", "field": "icon", "style": "width: 40px"},
                            {"name": "name", "label": "Table", "field": "name", "sortable": True},
                            {"name": "type", "label": "Type", "field": "type", "sortable": True},
                            {"name": "action", "label": "", "field": "action", "style": "width: 120px"},
                        ]
                        rows = []
                        for ti in tables:
                            rows.append({
                                "icon": "view_agenda" if ti.table_type == "view" else "table_chart",
                                "name": ti.name,
                                "type": ti.table_type,
                            })

                        for ti in tables:
                            qualified = f"{schema}.{ti.name}" if schema else ti.name
                            icon_name = "view_agenda" if ti.table_type == "view" else "table_chart"

                            with ui.expansion(
                                ti.name,
                                icon=icon_name,
                            ).classes("w-full").props("dense"):
                                # Column detail + query button
                                with ui.row().classes("items-center gap-2 mb-2"):
                                    ui.button(
                                        "Query this table",
                                        icon="play_arrow",
                                        on_click=lambda cid=conn["id"], t=qualified: ui.navigate.to(
                                            f"/sql?connection_id={cid}&table={t}"
                                        ),
                                    ).props("color=primary dense")

                                # Load columns inline
                                col_container = ui.column().classes("w-full")
                                with col_container:
                                    ui.label("Loading columns...").classes("text-xs text-grey-6")

                                async def _load_cols(
                                    c=conn, t=ti.name, s=schema, cc=col_container
                                ):
                                    try:
                                        a = await create_adapter_from_connection(c)
                                        cols = await a.get_columns(t, s)
                                        await a.close()
                                        cc.clear()
                                        with cc:
                                            if not cols:
                                                ui.label("No columns").classes("text-xs text-grey-6")
                                                return
                                            col_rows = []
                                            for ci in cols:
                                                col_rows.append({
                                                    "name": ci.name,
                                                    "type": ci.data_type,
                                                    "nullable": "YES" if ci.nullable else "NO",
                                                    "pk": "PK" if ci.primary_key else "",
                                                })
                                            ui.table(
                                                columns=[
                                                    {"name": "name", "label": "Column", "field": "name"},
                                                    {"name": "type", "label": "Type", "field": "type"},
                                                    {"name": "nullable", "label": "Nullable", "field": "nullable"},
                                                    {"name": "pk", "label": "Key", "field": "pk"},
                                                ],
                                                rows=col_rows,
                                            ).classes("w-full").props("dense flat")
                                    except Exception as ex:
                                        cc.clear()
                                        with cc:
                                            ui.label(f"Error: {ex}").classes("text-xs text-negative")

                                ui.timer(0.1, _load_cols, once=True)

            except Exception as ex:
                loading.delete()
                ui.label(f"Error loading connection: {ex}").classes("text-negative p-4")

    async def _back_to_grid(self) -> None:
        """Go back to the card grid view."""
        await refresh_cache()
        self._page_container.clear()
        with self._page_container:
            self._render_card_grid()

    def _add_connection(self) -> None:
        """Show add connection dialog."""
        pending_files: list[dict] = []  # [{name, content}] for uploaded files

        with ui.dialog() as dialog, ui.card().classes("w-[550px]"):
            ui.label("Add Connection").classes("text-lg font-semibold mb-4")

            db_type = ui.select(
                label="Connection Type",
                options=DB_TYPE_OPTIONS,
                value="postgresql",
            ).classes("w-full")

            name_input = ui.input(
                label="Connection Name", placeholder="My Database"
            ).classes("w-full")

            # --- Database fields (hidden for file type) ---
            db_fields = ui.column().classes("w-full gap-2")
            db_fields.bind_visibility_from(db_type, "value", backward=lambda v: v != "file")
            with db_fields:
                with ui.row().classes("gap-4 w-full"):
                    host_input = ui.input(label="Host", value="localhost").classes("flex-grow")
                    port_input = ui.number(label="Port", value=5432).classes("w-24")

                database_input = ui.input(label="Database", placeholder="mydb").classes("w-full")

                with ui.row().classes("gap-4 w-full"):
                    user_input = ui.input(label="Username").classes("flex-grow")
                    password_input = ui.input(
                        label="Password",
                        password=True,
                        password_toggle_button=True,
                    ).classes("flex-grow")

                with ui.expansion("Advanced Options", icon="settings").classes("w-full"):
                    ui.select(
                        label="SSL Mode",
                        options=["disable", "allow", "prefer", "require"],
                        value="prefer",
                    ).classes("w-full")

            # --- File fields (shown for file type) ---
            file_fields = ui.column().classes("w-full gap-3")
            file_fields.bind_visibility_from(db_type, "value", backward=lambda v: v == "file")

            file_list_container = None

            with file_fields:
                ui.label(
                    "Browse to a CSV/Excel file or folder, or upload files below."
                ).classes("text-sm text-grey-6")

                with ui.row().classes("w-full items-end gap-2"):
                    path_input = ui.input(
                        label="File or Folder Path",
                        placeholder="/path/to/data.csv or /path/to/folder",
                    ).classes("flex-grow")
                    ui.button(
                        icon="folder_open",
                        on_click=lambda: _open_file_browser(path_input),
                    ).props("flat dense").tooltip("Browse files")

                ui.separator().classes("my-2")
                ui.label("Or upload files").classes("text-sm text-grey-6")

                def handle_upload(e: UploadEventArguments):
                    pending_files.append({
                        "name": e.name,
                        "content": e.content.read(),
                    })
                    _render_pending_files()
                    ui.notify(f"Added: {e.name}", type="positive")

                ui.upload(
                    label="Drop files here or click to browse",
                    multiple=True,
                    on_upload=handle_upload,
                    auto_upload=True,
                ).props('accept=".csv,.tsv,.txt,.xlsx,.xls"').classes("w-full")

                file_list_container = ui.column().classes("w-full gap-1")

            def _render_pending_files():
                file_list_container.clear()
                with file_list_container:
                    for i, f in enumerate(pending_files):
                        with ui.row().classes("items-center gap-2 w-full"):
                            ui.icon("description", size="xs").classes("text-grey-6")
                            ui.label(f["name"]).classes("text-sm flex-grow")
                            ui.label(f"{len(f['content']) / 1024:.0f} KB").classes(
                                "text-xs text-grey-5"
                            )
                            ui.button(
                                icon="close",
                                on_click=lambda idx=i: _remove_pending(idx),
                            ).props("flat round dense size=xs")

            def _remove_pending(idx: int):
                pending_files.pop(idx)
                _render_pending_files()

            # Actions
            with ui.row().classes("justify-between items-center mt-4"):
                async def do_test():
                    if db_type.value == "file":
                        await self._do_test_file_connection(
                            path_input.value, pending_files
                        )
                    else:
                        await self._do_test_connection(
                            db_type.value,
                            host_input.value,
                            int(port_input.value or 0),
                            database_input.value,
                            user_input.value,
                            password_input.value,
                        )

                ui.button(
                    "Test Connection", icon="cable", on_click=do_test,
                ).props("flat")

                with ui.row().classes("gap-2"):
                    ui.button("Cancel", on_click=dialog.close).props("flat")

                    async def save_and_close():
                        if db_type.value == "file":
                            await self._do_save_file_connection(
                                name_input.value,
                                path_input.value,
                                pending_files,
                                dialog,
                            )
                        else:
                            await self._do_save_connection(
                                name_input.value,
                                db_type.value,
                                host_input.value,
                                int(port_input.value or 0),
                                database_input.value,
                                user_input.value,
                                password_input.value,
                                dialog,
                            )

                    ui.button("Save", on_click=save_and_close).props("color=primary")

        dialog.open()

    async def _do_test_file_connection(
        self,
        path_value: str,
        pending_files: list[dict],
    ) -> None:
        """Test a file-based connection."""
        ui.notify("Testing file connection...", type="info")
        try:
            from crunch.connections.adapters.file_adapter import FileAdapter
            from crunch.connections.base import ConnectionInfo

            file_paths = self._resolve_file_paths(path_value, pending_files)
            if not file_paths:
                ui.notify("No files found. Enter a valid path or upload files.", type="warning")
                return

            # Use a temp dir as database path for path-based connections
            db_path = str(Path(path_value)) if path_value.strip() else "uploaded"
            info = ConnectionInfo(
                name="Test", db_type="file", host="local", port=0,
                database=db_path,
                options={"files": file_paths},
            )
            adapter = FileAdapter(info)
            success, message = await adapter.test_connection()
            await adapter.close()

            if success:
                ui.notify(f"Connection successful! {message}", type="positive")
            else:
                ui.notify(f"Connection failed: {message}", type="negative")
        except Exception as e:
            ui.notify(f"Error: {str(e)}", type="negative")

    @staticmethod
    def _resolve_file_paths(
        path_value: str, pending_files: list[dict]
    ) -> list[str]:
        """Resolve file paths from user path input and/or uploaded files."""
        file_paths = []
        exts = {".csv", ".tsv", ".txt", ".xlsx", ".xls"}

        # From path input
        if path_value and path_value.strip():
            p = Path(path_value.strip())
            if p.is_file() and p.suffix.lower() in exts:
                file_paths.append(str(p))
            elif p.is_dir():
                for f in sorted(p.iterdir()):
                    if f.is_file() and f.suffix.lower() in exts:
                        file_paths.append(str(f))

        # From uploaded files (these exist only in memory at this point)
        for f in pending_files:
            # Signal that these need to be saved
            file_paths.append(f"__pending__:{f['name']}")

        return file_paths

    async def _do_save_file_connection(
        self,
        name: str,
        path_value: str,
        pending_files: list[dict],
        dialog,
    ) -> None:
        """Save a file-based connection."""
        if not name:
            ui.notify("Please enter a connection name", type="warning")
            return

        path_value = (path_value or "").strip()
        if not path_value and not pending_files:
            ui.notify("Please enter a file path or upload files", type="warning")
            return

        try:
            conn_id = str(uuid.uuid4())
            file_paths = []
            exts = {".csv", ".tsv", ".txt", ".xlsx", ".xls"}

            # Resolve path-based files
            if path_value:
                p = Path(path_value)
                if p.is_file() and p.suffix.lower() in exts:
                    file_paths.append(str(p))
                elif p.is_dir():
                    for f in sorted(p.iterdir()):
                        if f.is_file() and f.suffix.lower() in exts:
                            file_paths.append(str(f))

            # Save uploaded files to disk
            if pending_files:
                upload_dir = _get_upload_dir(conn_id)
                upload_dir.mkdir(parents=True, exist_ok=True)
                for f in pending_files:
                    fp = upload_dir / f["name"]
                    fp.write_bytes(f["content"])
                    file_paths.append(str(fp))

            if not file_paths:
                ui.notify("No valid CSV/Excel files found at that path", type="warning")
                return

            # Use the path or upload dir as database field
            db_path = path_value if path_value else str(_get_upload_dir(conn_id))

            await create_connection(
                name=name,
                db_type="file",
                host="local",
                port=0,
                database=db_path,
                username="",
                password="",
                options={"files": file_paths},
                connection_id=conn_id,
            )

            await refresh_cache()
            self._render_connections()
            ui.notify(
                f"Connection '{name}' saved with {len(file_paths)} file(s)!",
                type="positive",
            )
            dialog.close()

        except Exception as e:
            ui.notify(f"Error saving connection: {str(e)}", type="negative")

    async def _do_test_connection(
        self,
        db_type: str,
        host: str,
        port: int,
        database: str,
        user: str,
        password: str,
    ) -> None:
        """Test the connection."""
        ui.notify("Testing connection...", type="info")

        try:
            from crunch.connections.manager import ConnectionManager
            from crunch.config.connections import ConnectionConfig

            config = ConnectionConfig(
                name="Test",
                type=db_type,
                host=host,
                port=port,
                database=database,
                user=user,
                password=password,
            )

            manager = ConnectionManager()
            adapter = manager.create_adapter(config)
            success, message = await adapter.test_connection()

            if success:
                ui.notify(f"Connection successful! {message}", type="positive")
            else:
                ui.notify(f"Connection failed: {message}", type="negative")

        except Exception as e:
            ui.notify(f"Error: {str(e)}", type="negative")

    async def _do_save_connection(
        self,
        name: str,
        db_type: str,
        host: str,
        port: int,
        database: str,
        user: str,
        password: str,
        dialog,
    ) -> None:
        """Save the connection to database."""
        if not name:
            ui.notify("Please enter a connection name", type="warning")
            return

        if not database:
            ui.notify("Please enter a database name", type="warning")
            return

        try:
            await create_connection(
                name=name,
                db_type=db_type,
                host=host,
                port=port,
                database=database,
                username=user,
                password=password,
            )

            await refresh_cache()
            self._render_connections()
            ui.notify(f"Connection '{name}' saved!", type="positive")
            dialog.close()

        except Exception as e:
            ui.notify(f"Error saving connection: {str(e)}", type="negative")

    async def _test_connection(self, conn: dict) -> None:
        """Test an existing connection."""
        ui.notify(f"Testing {conn['name']}...", type="info")

        if conn["db_type"] == "file":
            try:
                from crunch.connections.base import ConnectionInfo
                from crunch.connections.adapters.file_adapter import FileAdapter

                # Use saved file paths from options
                opts = conn.get("options") or {}
                file_paths = opts.get("files", [])

                # Fallback: scan upload directory
                if not file_paths:
                    uploaded = _list_uploaded_files(conn["id"])
                    file_paths = [str(f) for f in uploaded]

                if not file_paths:
                    ui.notify("No files configured for this connection", type="warning")
                    return

                info = ConnectionInfo(
                    name=conn["name"],
                    db_type="file",
                    host="local",
                    port=0,
                    database=conn.get("database", ""),
                    options={"files": file_paths},
                )
                adapter = FileAdapter(info)
                success, message = await adapter.test_connection()
                await adapter.close()

                if success:
                    ui.notify(f"Connection successful! {message}", type="positive")
                else:
                    ui.notify(f"Connection failed: {message}", type="negative")
            except Exception as e:
                ui.notify(f"Error: {str(e)}", type="negative")
        else:
            await self._do_test_connection(
                conn["db_type"],
                conn["host"],
                conn["port"],
                conn["database"],
                conn.get("user", "") or conn.get("username", ""),
                conn.get("password", ""),
            )

    def _edit_connection(self, conn: dict) -> None:
        """Edit a connection."""
        with ui.dialog() as dialog, ui.card().classes("w-[550px]"):
            ui.label("Edit Connection").classes("text-lg font-semibold mb-4")

            db_type = ui.select(
                label="Connection Type",
                options=DB_TYPE_OPTIONS,
                value=conn["db_type"],
            ).classes("w-full").props("disable")

            name_input = ui.input(
                label="Connection Name",
                value=conn["name"],
            ).classes("w-full")

            if conn["db_type"] == "file":
                # Path input with browse button
                opts = conn.get("options") or {}
                existing_path = conn.get("database", "")
                # If database points to upload dir, don't show it as a user path
                if existing_path and "data/uploads/" in existing_path:
                    existing_path = ""

                ui.label(
                    "Browse to a CSV/Excel file or folder, or manage uploaded files below."
                ).classes("text-sm text-grey-6 mt-2")

                with ui.row().classes("w-full items-end gap-2"):
                    edit_path_input = ui.input(
                        label="File or Folder Path",
                        value=existing_path,
                        placeholder="/path/to/data.csv or /path/to/folder",
                    ).classes("flex-grow")
                    ui.button(
                        icon="folder_open",
                        on_click=lambda: _open_file_browser(edit_path_input),
                    ).props("flat dense").tooltip("Browse files")

                ui.separator().classes("my-2")
                ui.label("Uploaded Files").classes("text-sm font-semibold")

                existing_files = _list_uploaded_files(conn["id"])
                files_container = ui.column().classes("w-full gap-1")

                def _render_existing_files():
                    files_container.clear()
                    current_files = _list_uploaded_files(conn["id"])
                    with files_container:
                        if not current_files:
                            ui.label("No files uploaded").classes("text-sm text-grey-6")
                        for f in current_files:
                            with ui.row().classes("items-center gap-2 w-full"):
                                ui.icon("description", size="xs").classes("text-grey-6")
                                ui.label(f.name).classes("text-sm flex-grow")
                                size_kb = f.stat().st_size / 1024
                                ui.label(f"{size_kb:.0f} KB").classes("text-xs text-grey-5")
                                ui.button(
                                    icon="delete",
                                    on_click=lambda fp=f: _delete_file(fp),
                                ).props("flat round dense size=xs")

                _render_existing_files()

                def _delete_file(file_path: Path):
                    file_path.unlink(missing_ok=True)
                    _render_existing_files()
                    ui.notify(f"Removed: {file_path.name}")

                ui.label("Add More Files").classes("text-sm font-semibold mt-3")

                def handle_edit_upload(e: UploadEventArguments):
                    upload_dir = _get_upload_dir(conn["id"])
                    upload_dir.mkdir(parents=True, exist_ok=True)
                    file_path = upload_dir / e.name
                    file_path.write_bytes(e.content.read())
                    _render_existing_files()
                    ui.notify(f"Added: {e.name}", type="positive")

                ui.upload(
                    label="Drop files here",
                    multiple=True,
                    on_upload=handle_edit_upload,
                    auto_upload=True,
                ).props('accept=".csv,.tsv,.txt,.xlsx,.xls"').classes("w-full")

                with ui.row().classes("justify-end gap-2 mt-4"):
                    ui.button("Cancel", on_click=dialog.close).props("flat")

                    async def save_file_changes():
                        if not name_input.value:
                            ui.notify("Please enter a connection name", type="warning")
                            return

                        file_paths = []
                        path_val = edit_path_input.value.strip()

                        # Resolve path-based files
                        if path_val:
                            p = Path(path_val)
                            if p.is_file() and p.suffix.lower() in FILE_EXTS:
                                file_paths.append(str(p))
                            elif p.is_dir():
                                for f in sorted(p.iterdir()):
                                    if f.is_file() and f.suffix.lower() in FILE_EXTS:
                                        file_paths.append(str(f))

                        # Add uploaded files
                        uploaded = _list_uploaded_files(conn["id"])
                        for f in uploaded:
                            file_paths.append(str(f))

                        db_path = path_val if path_val else str(_get_upload_dir(conn["id"]))

                        await update_connection(
                            connection_id=conn["id"],
                            name=name_input.value,
                            db_type="file",
                            host="local",
                            port=0,
                            database=db_path,
                            username="",
                            password="",
                            options={"files": file_paths},
                        )
                        await refresh_cache()
                        self._render_connections()
                        ui.notify(f"Connection '{name_input.value}' updated!", type="positive")
                        dialog.close()

                    ui.button("Save", on_click=save_file_changes).props("color=primary")
            else:
                # Standard database edit form
                with ui.row().classes("gap-4 w-full"):
                    host_input = ui.input(
                        label="Host",
                        value=conn["host"],
                    ).classes("flex-grow")
                    port_input = ui.number(
                        label="Port",
                        value=conn["port"],
                    ).classes("w-24")

                database_input = ui.input(
                    label="Database",
                    value=conn["database"],
                ).classes("w-full")

                with ui.row().classes("gap-4 w-full"):
                    user_input = ui.input(
                        label="Username",
                        value=conn.get("username", "") or conn.get("user", ""),
                    ).classes("flex-grow")
                    password_input = ui.input(
                        label="Password",
                        password=True,
                        password_toggle_button=True,
                        value=conn.get("password", ""),
                    ).classes("flex-grow")

                with ui.row().classes("justify-between items-center mt-4"):
                    ui.button(
                        "Test Connection",
                        icon="cable",
                        on_click=lambda: self._do_test_connection(
                            db_type.value,
                            host_input.value,
                            int(port_input.value or 0),
                            database_input.value,
                            user_input.value,
                            password_input.value,
                        ),
                    ).props("flat")

                    with ui.row().classes("gap-2"):
                        ui.button("Cancel", on_click=dialog.close).props("flat")

                        async def save_changes():
                            await self._do_update_connection(
                                conn["id"],
                                name_input.value,
                                db_type.value,
                                host_input.value,
                                int(port_input.value or 0),
                                database_input.value,
                                user_input.value,
                                password_input.value,
                                dialog,
                            )

                        ui.button("Save", on_click=save_changes).props("color=primary")

        dialog.open()

    async def _do_update_connection(
        self,
        connection_id: str,
        name: str,
        db_type: str,
        host: str,
        port: int,
        database: str,
        user: str,
        password: str,
        dialog,
    ) -> None:
        """Update the connection in database."""
        if not name:
            ui.notify("Please enter a connection name", type="warning")
            return

        if not database:
            ui.notify("Please enter a database name", type="warning")
            return

        try:
            await update_connection(
                connection_id=connection_id,
                name=name,
                db_type=db_type,
                host=host,
                port=port,
                database=database,
                username=user,
                password=password,
            )

            await refresh_cache()
            self._render_connections()
            ui.notify(f"Connection '{name}' updated!", type="positive")
            dialog.close()

        except Exception as e:
            ui.notify(f"Error updating connection: {str(e)}", type="negative")

    def _delete_connection(self, conn: dict) -> None:
        """Delete a connection."""
        with ui.dialog() as dialog, ui.card():
            ui.label(f"Delete '{conn['name']}'?").classes("text-lg font-semibold")
            ui.label(
                "This will remove the connection. Queries using this connection "
                "will no longer work."
            ).classes("text-grey-6")

            async def do_delete():
                await self._do_delete_connection(conn, dialog)

            with ui.row().classes("justify-end gap-2 mt-4"):
                ui.button("Cancel", on_click=dialog.close).props("flat")
                ui.button("Delete", on_click=do_delete).props("color=negative")

        dialog.open()

    async def _do_delete_connection(self, conn: dict, dialog) -> None:
        """Actually delete the connection from database."""
        try:
            # Clean up uploaded files for file connections
            if conn["db_type"] == "file":
                upload_dir = _get_upload_dir(conn["id"])
                if upload_dir.exists():
                    shutil.rmtree(upload_dir, ignore_errors=True)

            await delete_connection(conn["id"])
            await refresh_cache()
            self._render_connections()
            ui.notify(f"Connection '{conn['name']}' deleted", type="info")
            dialog.close()
        except Exception as e:
            ui.notify(f"Error deleting connection: {str(e)}", type="negative")


def connection_card(
    name: str,
    db_type: str,
    host: str,
    database: str,
    status: str = "unknown",
    on_click=None,
    on_test=None,
    on_edit=None,
    on_delete=None,
) -> ui.element:
    """Create a connection card."""
    status_colors = {
        "connected": "text-positive",
        "error": "text-negative",
        "unknown": "text-grey-5",
    }

    with ui.card().classes("w-80 cursor-pointer") as card:
        with ui.row().classes("items-center justify-between"):
            with ui.row().classes("items-center gap-2"):
                ui.label(DB_ICONS.get(db_type, "📊")).classes("text-2xl")
                ui.label(name).classes("font-semibold")

            with ui.button(icon="more_vert").props("flat round dense"):
                with ui.menu():
                    ui.menu_item("Test Connection", on_test)
                    ui.menu_item("Edit", on_edit)
                    ui.separator()
                    ui.menu_item("Delete", on_delete)

        # Clickable body area
        body = ui.column().classes("mt-2 gap-1")
        if on_click:
            body.on("click", on_click)
        with body:
            with ui.row().classes("items-center gap-2 text-sm text-grey-6"):
                ui.icon("dns" if db_type != "file" else "folder", size="xs")
                ui.label(host)

            with ui.row().classes("items-center gap-2 text-sm text-grey-6"):
                ui.icon("storage" if db_type != "file" else "description", size="xs")
                ui.label(database).classes("truncate").style("max-width: 220px")

        with ui.row().classes("items-center gap-2 mt-3"):
            ui.icon("circle", size="xs").classes(status_colors.get(status, "text-grey-5"))
            ui.label("Browse tables →").classes("text-sm text-grey-6")

    return None


async def connections_page() -> None:
    """Entry point for connections page."""
    page = ConnectionsPage()
    await page.render()
