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


class ConnectionsPage:
    """Connections management page controller."""

    def __init__(self):
        self._cards_container = None

    async def render(self) -> None:
        """Render the connections page."""
        # Refresh cache to ensure we have latest connections
        await refresh_cache()
        
        # Metabase-style layout
        sidebar = MetabaseSidebar()
        sidebar.create()
        
        header = MetabaseHeader(sidebar=sidebar, title="Data", show_back=True)
        header.create()
        
        with ui.column().classes("w-full p-6 gap-6 bg-gray-50 dark:bg-[#252526] min-h-screen"):
            # Header with actions
            with ui.row().classes("items-center justify-between w-full"):
                ui.label("Data Connections").classes("text-xl font-semibold")
                
                ui.button(
                    "Add Connection",
                    icon="add",
                    on_click=self._add_connection,
                ).props("color=primary")
            
            # Connection cards container
            self._cards_container = ui.row().classes("gap-4 flex-wrap")
            self._render_connections()

    def _render_connections(self) -> None:
        """Render connection cards."""
        self._cards_container.clear()
        
        connections = get_connections()
        
        with self._cards_container:
            # Show saved connections
            for conn in connections:
                connection_card(
                    name=conn["name"],
                    db_type=conn["db_type"],
                    host=f"{conn['host']}:{conn['port']}",
                    database=conn["database"],
                    status="unknown",
                    on_test=lambda c=conn: self._test_connection(c),
                    on_edit=lambda c=conn: self._edit_connection(c),
                    on_delete=lambda c=conn: self._delete_connection(c),
                )
            
            # Add connection placeholder
            with ui.card().classes(
                "w-80 h-48 flex items-center justify-center cursor-pointer "
                "border-2 border-dashed border-gray-300 dark:border-[#3e3e42] hover:border-blue-400"
            ) as card:
                card.on("click", self._add_connection)
                with ui.column().classes("items-center gap-2 text-gray-400 dark:text-gray-500"):
                    ui.icon("add", size="xl")
                    ui.label("Add Connection")

    def _add_connection(self) -> None:
        """Show add connection dialog."""
        with ui.dialog() as dialog, ui.card().classes("w-[90vw] max-w-xl"):
            ui.label("Add Connection").classes("text-lg font-semibold mb-4")
            
            # Connection type
            db_type_options = {
                "postgresql": "PostgreSQL",
                "mysql": "MySQL", 
                "sqlite": "SQLite",
                "sqlserver": "SQL Server",
            }
            db_type = ui.select(
                label="Database Type",
                options=db_type_options,
                value="postgresql",
            ).classes("w-full")
            
            # Connection details
            name_input = ui.input(label="Connection Name", placeholder="My Database").classes(
                "w-full"
            )
            
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
            
            # SSL options
            with ui.expansion("Advanced Options", icon="settings").classes("w-full"):
                ssl_mode = ui.select(
                    label="SSL Mode",
                    options=["disable", "allow", "prefer", "require"],
                    value="prefer",
                ).classes("w-full")
            
            # Actions
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
                    
                    async def save_and_close():
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
            from nicemeta.connections.manager import ConnectionManager
            from nicemeta.config.connections import ConnectionConfig
            
            # Create config
            config = ConnectionConfig(
                name="Test",
                type=db_type,
                host=host,
                port=port,
                database=database,
                user=user,
                password=password,
            )
            
            # Create adapter and test
            manager = ConnectionManager()
            adapter = manager.create_adapter(config)
            success, message = await adapter.test_connection()
            
            if success:
                ui.notify("✓ Connection successful!", type="positive")
            else:
                ui.notify(f"✗ Connection failed: {message}", type="negative")
                
        except Exception as e:
            ui.notify(f"✗ Error: {str(e)}", type="negative")

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
            # Save to database
            await create_connection(
                name=name,
                db_type=db_type,
                host=host,
                port=port,
                database=database,
                username=user,
                password=password,
            )
            
            # Refresh cache
            await refresh_cache()
            
            # Refresh the display
            self._render_connections()
            
            ui.notify(f"Connection '{name}' saved!", type="positive")
            dialog.close()
            
        except Exception as e:
            ui.notify(f"Error saving connection: {str(e)}", type="negative")

    async def _test_connection(self, conn: dict) -> None:
        """Test an existing connection."""
        ui.notify(f"Testing {conn['name']}...", type="info")
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
        with ui.dialog() as dialog, ui.card().classes("w-[90vw] max-w-xl"):
            ui.label("Edit Connection").classes("text-lg font-semibold mb-4")
            
            # Connection type
            db_type_options = {
                "postgresql": "PostgreSQL",
                "mysql": "MySQL", 
                "sqlite": "SQLite",
                "sqlserver": "SQL Server",
            }
            db_type = ui.select(
                label="Database Type",
                options=db_type_options,
                value=conn["db_type"],
            ).classes("w-full")
            
            # Connection details
            name_input = ui.input(
                label="Connection Name", 
                value=conn["name"],
            ).classes("w-full")
            
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
            
            # Actions
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
            # Update in database
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
            
            # Refresh cache
            await refresh_cache()
            
            # Refresh the display
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
            ).classes("text-gray-500 dark:text-gray-400")

            async def do_delete():
                await self._do_delete_connection(conn, dialog)
            
            with ui.row().classes("justify-end gap-2 mt-4"):
                ui.button("Cancel", on_click=dialog.close).props("flat")
                ui.button("Delete", on_click=do_delete).props("color=negative")
        
        dialog.open()

    async def _do_delete_connection(self, conn: dict, dialog) -> None:
        """Actually delete the connection from database."""
        try:
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
    on_test=None,
    on_edit=None,
    on_delete=None,
) -> ui.element:
    """Create a connection card."""
    db_icons = {
        "postgresql": "hub",
        "mysql": "account_tree",
        "sqlite": "folder_open",
        "sqlserver": "window",
    }
    
    status_colors = {
        "connected": "text-gray-500 dark:text-gray-400",
        "error": "text-red-500",
        "unknown": "text-gray-400 dark:text-gray-500",
    }
    
    with ui.card().classes("w-80"):
        with ui.row().classes("items-center justify-between"):
            with ui.row().classes("items-center gap-2"):
                ui.icon(db_icons.get(db_type, "storage"), size="md").classes("text-gray-500 dark:text-gray-400")
                ui.label(name).classes("font-semibold")
            
            with ui.button(icon="more_vert").props("flat round dense"):
                with ui.menu():
                    ui.menu_item("Test Connection", on_test)
                    ui.menu_item("Edit", on_edit)
                    ui.separator()
                    ui.menu_item("Delete", on_delete)
        
        with ui.column().classes("mt-2 gap-1"):
            with ui.row().classes("items-center gap-2 text-sm text-gray-500 dark:text-gray-400"):
                ui.icon("dns", size="xs")
                ui.label(host)

            with ui.row().classes("items-center gap-2 text-sm text-gray-500 dark:text-gray-400"):
                ui.icon("database", size="xs")
                ui.label(database)
        
        with ui.row().classes("items-center gap-2 mt-3"):
            ui.icon("circle", size="xs").classes(status_colors.get(status, "text-gray-400 dark:text-gray-500"))
            ui.label(status.capitalize()).classes("text-sm text-gray-500 dark:text-gray-400")
    
    return None


async def connections_page() -> None:
    """Entry point for connections page."""
    page = ConnectionsPage()
    await page.render()
