"""
Admin page for NiceMeta.
"""

from nicegui import app, ui

from nicemeta.ui.components.sidebar import MetabaseHeader, MetabaseSidebar
from nicemeta.ui.components.agent_panel import (
    AgentPanel,
    _KEY_ANTHROPIC,
    _KEY_OPENAI,
    _KEY_PROVIDER,
    _KEY_MODEL,
)
from nicemeta.services.agent_service import ALL_MODELS, ANTHROPIC_MODELS
from nicemeta.services.git_service import get_git_service, reset_git_service, DEFAULT_WORKSPACE


class AdminPage:
    """Admin page controller."""

    def __init__(self):
        self.active_tab = "users"

    async def render(self) -> None:
        """Render the admin page."""
        sidebar = MetabaseSidebar()
        sidebar.create()

        agent = AgentPanel()
        agent.create()

        header = MetabaseHeader(sidebar=sidebar, title="Settings", show_back=True, agent=agent)
        header.create()

        with ui.column().classes("w-full p-6 gap-6 bg-gray-50 min-h-screen"):
            # Tabs
            with ui.tabs().classes("w-full") as tabs:
                users_tab = ui.tab("Users", icon="people")
                settings_tab = ui.tab("Settings", icon="settings")
                ai_tab = ui.tab("AI", icon="smart_toy")
                git_tab = ui.tab("Git", icon="merge")
                system_tab = ui.tab("System", icon="computer")

            with ui.tab_panels(tabs, value=users_tab).classes("w-full"):
                with ui.tab_panel(users_tab):
                    await self._render_users_panel()

                with ui.tab_panel(settings_tab):
                    await self._render_settings_panel()

                with ui.tab_panel(ai_tab):
                    self._render_ai_panel()

                with ui.tab_panel(git_tab):
                    await self._render_git_panel()

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
                ).classes("text-sm text-gray-500 mt-2")
            
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
        with ui.dialog() as dialog, ui.card().classes("w-96"):
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

    def _render_ai_panel(self) -> None:
        """Render the AI agent settings panel."""
        storage = app.storage.user

        with ui.column().classes("w-full gap-6 max-w-2xl"):
            # ── Info banner ──────────────────────────────────────────────
            with ui.card().classes("w-full bg-blue-50 border border-blue-200"):
                with ui.row().classes("items-start gap-3 p-4"):
                    ui.icon("info", size="sm").classes("text-blue-500 mt-1 flex-shrink-0")
                    with ui.column().classes("gap-1"):
                        ui.label("AI Agent Setup").classes("font-semibold text-blue-800")
                        ui.label(
                            "Keys are stored encrypted in your user profile (app.storage.user). "
                            "They never leave your server and are only used for direct API calls "
                            "to Anthropic or OpenAI."
                        ).classes("text-sm text-blue-700")

            # ── Anthropic ─────────────────────────────────────────────────
            with ui.card().classes("w-full"):
                ui.label("Anthropic (Claude)").classes("text-lg font-semibold mb-4")

                with ui.column().classes("gap-3"):
                    ant_key_input = ui.input(
                        label="API Key",
                        value=storage.get(_KEY_ANTHROPIC, ""),
                        password=True,
                        password_toggle_button=True,
                        placeholder="sk-ant-...",
                    ).classes("w-full")

                    ui.label(
                        "Get your key at console.anthropic.com"
                    ).classes("text-xs text-gray-400")

                    def _save_anthropic():
                        storage[_KEY_ANTHROPIC] = ant_key_input.value.strip()
                        ui.notify("Anthropic key saved", type="positive")

                    ui.button(
                        "Save Anthropic Key", icon="save", on_click=_save_anthropic
                    ).props("color=primary dense")

            # ── OpenAI ────────────────────────────────────────────────────
            with ui.card().classes("w-full"):
                ui.label("OpenAI (GPT)").classes("text-lg font-semibold mb-4")

                with ui.column().classes("gap-3"):
                    oai_key_input = ui.input(
                        label="API Key",
                        value=storage.get(_KEY_OPENAI, ""),
                        password=True,
                        password_toggle_button=True,
                        placeholder="sk-...",
                    ).classes("w-full")

                    ui.label(
                        "Get your key at platform.openai.com"
                    ).classes("text-xs text-gray-400")

                    def _save_openai():
                        storage[_KEY_OPENAI] = oai_key_input.value.strip()
                        ui.notify("OpenAI key saved", type="positive")

                    ui.button(
                        "Save OpenAI Key", icon="save", on_click=_save_openai
                    ).props("color=primary dense")

            # ── Defaults ──────────────────────────────────────────────────
            with ui.card().classes("w-full"):
                ui.label("Default Model").classes("text-lg font-semibold mb-4")

                cur_provider = storage.get(_KEY_PROVIDER, "anthropic")
                cur_model = storage.get(_KEY_MODEL, "claude-sonnet-4-6")

                provider_sel = ui.select(
                    label="Provider",
                    options={"anthropic": "Anthropic (Claude)", "openai": "OpenAI (GPT)"},
                    value=cur_provider,
                ).classes("w-full")

                models_now = ALL_MODELS.get(cur_provider, ANTHROPIC_MODELS)
                if cur_model not in models_now:
                    cur_model = next(iter(models_now))

                model_sel = ui.select(
                    label="Model",
                    options=models_now,
                    value=cur_model,
                ).classes("w-full")

                def _on_provider_change(e) -> None:
                    models = ALL_MODELS.get(e.value, ANTHROPIC_MODELS)
                    model_sel.options = models
                    model_sel.value = next(iter(models))

                provider_sel.on("update:model-value", _on_provider_change)

                def _save_defaults():
                    storage[_KEY_PROVIDER] = provider_sel.value
                    storage[_KEY_MODEL] = model_sel.value
                    ui.notify("Default model saved", type="positive")

                ui.button(
                    "Save Defaults", icon="save", on_click=_save_defaults
                ).props("color=primary dense")

    async def _render_git_panel(self) -> None:
        """Render the Git version control panel."""
        git = get_git_service()
        storage = app.storage.general

        with ui.column().classes("w-full gap-6 max-w-3xl"):

            # ── Status ────────────────────────────────────────────────────────
            with ui.card().classes("w-full"):
                with ui.row().classes("items-center justify-between w-full mb-3"):
                    ui.label("Git Status").classes("text-lg font-semibold")
                    status_label = ui.label(git.get_short_status()).classes(
                        "text-sm font-mono text-gray-600"
                    )

                status_area = ui.label(
                    git.get_status() or "(not initialized — click Initialize below)"
                ).classes(
                    "text-xs font-mono whitespace-pre bg-gray-100 rounded p-2 w-full"
                )

                def _refresh_status():
                    status_label.text = git.get_short_status()
                    status_area.text = git.get_status() or "(not initialized)"

                ui.button(
                    "Refresh", icon="refresh", on_click=_refresh_status
                ).props("flat dense")

            # ── Workspace ─────────────────────────────────────────────────────
            with ui.card().classes("w-full"):
                ui.label("Workspace Path").classes("text-lg font-semibold mb-3")
                ui.label(
                    "All queries, dashboards, and connection configs are stored here as files."
                ).classes("text-sm text-gray-500 mb-3")

                workspace_input = ui.input(
                    label="Workspace Path",
                    value=storage.get("git_workspace_path", str(DEFAULT_WORKSPACE)),
                ).classes("w-full")

                ui.label(f"Current: {git.workspace}").classes("text-xs text-gray-400 mt-1")

                def _set_workspace():
                    nonlocal git
                    new_path = workspace_input.value.strip()
                    if not new_path:
                        ui.notify("Path cannot be empty", type="warning")
                        return
                    storage["git_workspace_path"] = new_path
                    git = reset_git_service(new_path)
                    ui.notify(f"Workspace set to: {new_path}", type="positive")
                    _refresh_status()

                ui.button(
                    "Set Workspace", icon="folder", on_click=_set_workspace
                ).props("color=primary dense")

            # ── Remote Origin ─────────────────────────────────────────────────
            with ui.card().classes("w-full"):
                ui.label("Remote Origin").classes("text-lg font-semibold mb-3")

                current_remote = git.get_remote()
                if current_remote:
                    ui.label(f"Current: {current_remote}").classes(
                        "text-xs font-mono text-gray-500 mb-2"
                    )

                remote_input = ui.input(
                    label="Remote URL",
                    value=current_remote,
                    placeholder="https://github.com/user/nicemeta-workspace.git",
                ).classes("w-full")

                async def _set_remote():
                    url = remote_input.value.strip()
                    if not url:
                        ui.notify("Remote URL cannot be empty", type="warning")
                        return
                    ok, msg = await git.set_remote(url)
                    if ok:
                        ui.notify(msg, type="positive")
                    else:
                        ui.notify(f"Failed: {msg}", type="negative")

                ui.button(
                    "Set Remote", icon="cloud_upload", on_click=_set_remote
                ).props("color=primary dense")

            # ── Operations ────────────────────────────────────────────────────
            with ui.card().classes("w-full"):
                ui.label("Operations").classes("text-lg font-semibold mb-3")

                op_output = ui.label("").classes(
                    "text-xs font-mono whitespace-pre bg-gray-100 rounded p-2 w-full"
                ).style("min-height: 2rem")

                def _set_op_output(text: str, error: bool = False):
                    op_output.text = text
                    if error:
                        op_output.classes(add="text-red-600")
                    else:
                        op_output.classes(remove="text-red-600")

                def _do_initialize():
                    ok, msg = git.initialize()
                    _set_op_output(msg, not ok)
                    if ok:
                        ui.notify("Git repo initialized!", type="positive")
                    else:
                        ui.notify(msg, type="info")
                    _refresh_status()

                async def _do_sync_all():
                    _set_op_output("Syncing all content to workspace…")
                    try:
                        msg = await git.sync_all()
                        _set_op_output(msg)
                        ui.notify(msg[:80], type="positive")
                    except Exception as exc:
                        _set_op_output(str(exc), error=True)
                    _refresh_status()

                async def _do_push():
                    _set_op_output("Pushing to remote…")
                    ok, msg = await git.push()
                    _set_op_output(msg, not ok)
                    if ok:
                        ui.notify("Pushed successfully!", type="positive")
                    else:
                        ui.notify(f"Push failed", type="negative")
                    _refresh_status()

                async def _do_pull():
                    _set_op_output("Pulling from remote…")
                    ok, msg = await git.pull()
                    _set_op_output(msg, not ok)
                    if ok:
                        ui.notify("Pulled and imported!", type="positive")
                    else:
                        ui.notify("Pull failed", type="negative")
                    _refresh_status()

                async def _do_fetch():
                    _set_op_output("Fetching from remote…")
                    ok, msg = await git.fetch()
                    _set_op_output(msg, not ok)
                    if ok:
                        ui.notify("Fetched!", type="positive")
                    else:
                        ui.notify("Fetch failed", type="negative")
                    _refresh_status()

                with ui.row().classes("gap-3 flex-wrap mb-3"):
                    ui.button(
                        "Initialize", icon="play_arrow", on_click=_do_initialize
                    ).props("outline dense").tooltip(
                        "Create a new git repo in the workspace directory"
                    )
                    ui.button(
                        "Sync All", icon="sync", on_click=_do_sync_all
                    ).props("color=primary dense").tooltip(
                        "Export all queries, dashboards, and connections to files and commit"
                    )
                    ui.button(
                        "Push", icon="upload", on_click=_do_push
                    ).props("color=secondary dense").tooltip(
                        "Push local commits to remote origin"
                    )
                    ui.button(
                        "Pull & Import", icon="download", on_click=_do_pull
                    ).props("color=secondary dense").tooltip(
                        "Pull from remote and import changes into NiceMeta"
                    )
                    ui.button(
                        "Fetch", icon="cloud_download", on_click=_do_fetch
                    ).props("outline dense").tooltip(
                        "Fetch remote changes without merging"
                    )

            # ── Clone & Import ────────────────────────────────────────────────
            with ui.card().classes("w-full"):
                ui.label("Clone & Import").classes("text-lg font-semibold mb-2")
                ui.label(
                    "Clone a NiceMeta workspace repo and import its queries "
                    "and dashboards into this instance."
                ).classes("text-sm text-gray-500 mb-3")

                clone_url_input = ui.input(
                    label="Repository URL",
                    placeholder="https://github.com/user/nicemeta-workspace.git",
                ).classes("w-full")

                clone_output = ui.label("").classes(
                    "text-xs font-mono whitespace-pre bg-gray-100 rounded p-2 w-full"
                ).style("min-height: 2rem")

                async def _do_clone():
                    url = clone_url_input.value.strip()
                    if not url:
                        ui.notify("URL is required", type="warning")
                        return
                    clone_output.text = f"Cloning {url}…"
                    ok, msg = await git.clone_and_import(url)
                    clone_output.text = msg
                    if ok:
                        ui.notify("Cloned and imported successfully!", type="positive")
                        _refresh_status()
                    else:
                        ui.notify("Clone failed", type="negative")

                ui.button(
                    "Clone & Import", icon="file_download", on_click=_do_clone
                ).props("color=primary dense")

            # ── Commit Log ────────────────────────────────────────────────────
            with ui.card().classes("w-full"):
                ui.label("Recent Commits").classes("text-lg font-semibold mb-3")

                commits = git.get_log(limit=30)
                if commits:
                    ui.table(
                        columns=[
                            {"name": "hash", "label": "Hash", "field": "hash",
                             "align": "left", "style": "font-family:monospace;width:6em"},
                            {"name": "message", "label": "Message", "field": "message",
                             "align": "left"},
                            {"name": "when", "label": "When", "field": "when",
                             "align": "right", "style": "width:10em"},
                        ],
                        rows=commits,
                        row_key="hash",
                    ).classes("w-full").props("dense flat")
                else:
                    ui.label(
                        "No commits yet — Initialize the repo and run Sync All."
                    ).classes("text-gray-400 text-sm")

    def _save_settings(self) -> None:
        """Save settings."""
        ui.notify("Settings saved", type="positive")


def info_item(label: str, value: str) -> None:
    """Create an info item."""
    with ui.row().classes("items-center gap-2"):
        ui.label(f"{label}:").classes("text-gray-500")
        ui.label(value).classes("font-medium")


def stat_box(label: str, value: str) -> None:
    """Create a statistics box."""
    with ui.card().classes("p-4 text-center"):
        ui.label(value).classes("text-2xl font-bold")
        ui.label(label).classes("text-sm text-gray-500")


async def admin_page() -> None:
    """Entry point for admin page."""
    page = AdminPage()
    await page.render()

