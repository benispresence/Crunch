"""
Admin page for NiceMeta.
"""

from nicegui import ui

from nicemeta.ui.components.sidebar import MetabaseHeader, MetabaseSidebar


class AdminPage:
    """Admin page controller."""

    def __init__(self):
        self.active_tab = "users"

    async def render(self) -> None:
        """Render the admin page."""
        sidebar = MetabaseSidebar()
        sidebar.create()
        
        header = MetabaseHeader(sidebar=sidebar, title="Settings", show_back=True)
        header.create()
        
        with ui.column().classes("w-full p-6 gap-6 bg-gray-50 dark:bg-[#252526] min-h-screen"):
            # Tabs
            with ui.tabs().classes("w-full") as tabs:
                users_tab = ui.tab("Users", icon="people")
                settings_tab = ui.tab("Settings", icon="settings")
                system_tab = ui.tab("System", icon="computer")
            
            with ui.tab_panels(tabs, value=users_tab).classes("w-full"):
                with ui.tab_panel(users_tab):
                    await self._render_users_panel()
                
                with ui.tab_panel(settings_tab):
                    await self._render_settings_panel()
                
                with ui.tab_panel(system_tab):
                    await self._render_system_panel()

    async def _render_users_panel(self) -> None:
        """Render the users management panel."""
        with ui.column().classes("w-full gap-4"):
            # Header
            with ui.row().classes("items-center justify-between w-full"):
                ui.label("User Management").classes("text-lg font-semibold")
                ui.button(
                    "Add User",
                    icon="person_add",
                    on_click=self._add_user,
                ).props("color=primary")
            
            # Users table
            columns = [
                {"name": "email", "label": "Email", "field": "email", "sortable": True},
                {"name": "name", "label": "Name", "field": "name", "sortable": True},
                {"name": "role", "label": "Role", "field": "role", "sortable": True},
                {"name": "status", "label": "Status", "field": "status"},
                {"name": "actions", "label": "Actions", "field": "actions"},
            ]
            
            # Placeholder users
            rows = [
                {
                    "email": "admin@example.com",
                    "name": "Admin User",
                    "role": "Admin",
                    "status": "Active",
                },
            ]
            
            ui.table(
                columns=columns,
                rows=rows,
                row_key="email",
            ).classes("w-full")

    async def _render_settings_panel(self) -> None:
        """Render the settings panel."""
        with ui.column().classes("w-full gap-6"):
            # General Settings
            with ui.card().classes("w-full"):
                ui.label("General Settings").classes("text-lg font-semibold mb-4")
                
                ui.input(
                    label="Application Title",
                    value="NiceMeta",
                ).classes("w-full max-w-md")
                
                ui.checkbox("Enable user registration", value=True)
                ui.checkbox("Require email verification", value=False)
            
            # Authentication Settings
            with ui.card().classes("w-full"):
                ui.label("Authentication").classes("text-lg font-semibold mb-4")
                
                ui.number(
                    label="Session timeout (minutes)",
                    value=60,
                    min=5,
                    max=1440,
                ).classes("w-48")
                
                ui.checkbox("Enable OAuth login", value=False)
            
            # Database Settings
            with ui.card().classes("w-full"):
                ui.label("Internal Database").classes("text-lg font-semibold mb-4")
                
                ui.select(
                    label="Database Type",
                    options=["SQLite", "PostgreSQL"],
                    value="SQLite",
                ).classes("w-48")
                
                ui.label(
                    "Note: Changing the database type requires migration"
                ).classes("text-sm text-gray-500 dark:text-gray-400 mt-2")
            
            # Save button
            ui.button(
                "Save Settings",
                icon="save",
                on_click=self._save_settings,
            ).props("color=primary")

    async def _render_system_panel(self) -> None:
        """Render the system information panel."""
        with ui.column().classes("w-full gap-6"):
            # System Info
            with ui.card().classes("w-full"):
                ui.label("System Information").classes("text-lg font-semibold mb-4")
                
                with ui.grid(columns=2).classes("gap-4"):
                    info_item("Version", "0.1.0")
                    info_item("Python", "3.11+")
                    info_item("Database", "SQLite")
                    info_item("Uptime", "1 hour")
            
            # Statistics
            with ui.card().classes("w-full"):
                ui.label("Statistics").classes("text-lg font-semibold mb-4")
                
                with ui.grid(columns=4).classes("gap-4"):
                    stat_box("Users", "1")
                    stat_box("Queries", "0")
                    stat_box("Dashboards", "0")
                    stat_box("Connections", "0")
            
            # Actions
            with ui.card().classes("w-full"):
                ui.label("Maintenance").classes("text-lg font-semibold mb-4")
                
                with ui.row().classes("gap-4"):
                    ui.button(
                        "Clear Cache",
                        icon="delete_sweep",
                        on_click=lambda: ui.notify("Cache cleared"),
                    ).props("flat")
                    
                    ui.button(
                        "Export Data",
                        icon="download",
                        on_click=lambda: ui.notify("Export started"),
                    ).props("flat")
                    
                    ui.button(
                        "View Logs",
                        icon="article",
                        on_click=lambda: ui.notify("Logs viewer not implemented"),
                    ).props("flat")

    def _add_user(self) -> None:
        """Show add user dialog."""
        with ui.dialog() as dialog, ui.card().classes("w-[90vw] max-w-md"):
            ui.label("Add User").classes("text-lg font-semibold mb-4")
            
            email_input = ui.input(label="Email").classes("w-full")
            name_input = ui.input(label="Name").classes("w-full")
            password_input = ui.input(
                label="Password",
                password=True,
                password_toggle_button=True,
            ).classes("w-full")
            
            role_select = ui.select(
                label="Role",
                options=["Viewer", "Editor", "Admin"],
                value="Viewer",
            ).classes("w-full")
            
            with ui.row().classes("justify-end gap-2 mt-4"):
                ui.button("Cancel", on_click=dialog.close).props("flat")
                ui.button(
                    "Create",
                    on_click=lambda: self._do_add_user(
                        email_input.value,
                        name_input.value,
                        password_input.value,
                        role_select.value,
                        dialog,
                    ),
                ).props("color=primary")
        
        dialog.open()

    def _do_add_user(
        self, email: str, name: str, password: str, role: str, dialog
    ) -> None:
        """Actually create the user."""
        if not email or not password:
            ui.notify("Email and password are required", type="warning")
            return
        
        # In production, create user via FastAPI Users
        ui.notify(f"User {email} created", type="positive")
        dialog.close()

    def _save_settings(self) -> None:
        """Save settings."""
        ui.notify("Settings saved", type="positive")


def info_item(label: str, value: str) -> None:
    """Create an info item."""
    with ui.row().classes("items-center gap-2"):
        ui.label(f"{label}:").classes("text-gray-500 dark:text-gray-400")
        ui.label(value).classes("font-medium")


def stat_box(label: str, value: str) -> None:
    """Create a statistics box."""
    with ui.card().classes("p-4 text-center"):
        ui.label(value).classes("text-2xl font-bold")
        ui.label(label).classes("text-sm text-gray-500 dark:text-gray-400")


async def admin_page() -> None:
    """Entry point for admin page."""
    page = AdminPage()
    await page.render()

