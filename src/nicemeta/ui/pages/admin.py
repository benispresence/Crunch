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

        with ui.column().classes("w-full p-6 gap-6 min-h-screen"):
            # Tabs
            with ui.tabs().classes("w-full") as tabs:
                users_tab = ui.tab("Users", icon="people")
                settings_tab = ui.tab("Settings", icon="settings")
                packages_tab = ui.tab("Packages", icon="inventory_2")
                ai_tab = ui.tab("AI", icon="smart_toy")
                git_tab = ui.tab("Git", icon="merge")
                system_tab = ui.tab("System", icon="computer")

            with ui.tab_panels(tabs, value=users_tab).classes("w-full"):
                with ui.tab_panel(users_tab):
                    await self._render_users_panel()

                with ui.tab_panel(settings_tab):
                    await self._render_settings_panel()

                with ui.tab_panel(packages_tab):
                    await self._render_packages_panel()

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
                ).classes("text-sm text-grey-6 mt-2")
            
            # Save button
            ui.button(
                "Save Settings",
                icon="save",
                on_click=self._save_settings,
            ).props("color=primary")

    async def _render_packages_panel(self) -> None:
        """Render the Python packages management panel."""
        from nicemeta.services import package_service
        from nicemeta.visualization.code_executor import CodeExecutor

        packages = await package_service.list_all()

        with ui.column().classes("w-full gap-6 max-w-3xl"):
            # Info banner
            with ui.card().classes("w-full bg-blue-1 border"):
                with ui.row().classes("items-start gap-3 p-4"):
                    ui.icon("info", size="sm").classes("text-primary mt-1 flex-shrink-0")
                    with ui.column().classes("gap-1"):
                        ui.label("Sandbox Package Manager").classes("font-semibold text-primary")
                        ui.label(
                            "Packages listed here can be imported in visualization code. "
                            "Only whitelisted packages are accessible — users cannot import "
                            "arbitrary modules. Default packages (pandas, numpy, plotly, etc.) "
                            "are pre-configured and cannot be removed."
                        ).classes("text-sm text-primary")

            # Add package card
            with ui.card().classes("w-full"):
                ui.label("Add Package").classes("text-lg font-semibold mb-3")
                ui.label(
                    "Add a PyPI package to the whitelist. It will be installed automatically."
                ).classes("text-sm text-grey-6 mb-3")

                with ui.row().classes("gap-3 items-end flex-wrap"):
                    pkg_name_input = ui.input(
                        label="PyPI Package Name",
                        placeholder="e.g. wordcloud",
                    ).classes("w-48")
                    import_name_input = ui.input(
                        label="Import Name (if different)",
                        placeholder="e.g. sklearn",
                    ).classes("w-48")
                    version_input = ui.input(
                        label="Version Spec",
                        placeholder="e.g. >=1.0,<2.0",
                    ).classes("w-40")

                    async def _do_add_package():
                        name = pkg_name_input.value.strip()
                        if not name:
                            ui.notify("Package name is required", type="warning")
                            return
                        ui.notify(f"Installing {name}...", type="info")
                        result = await package_service.add_package(
                            package_name=name,
                            import_name=import_name_input.value.strip() or None,
                            version_spec=version_input.value.strip() or None,
                            auto_install=True,
                        )
                        CodeExecutor.invalidate_cache()
                        if result.get("status") == "installed":
                            ui.notify(
                                f"Installed {name} v{result.get('installed_version', '?')}",
                                type="positive",
                            )
                        else:
                            ui.notify(
                                f"Failed to install {name}: {result.get('error_message', 'unknown error')}",
                                type="negative",
                            )
                        # Refresh table
                        updated = await package_service.list_all()
                        pkg_table.rows = [_pkg_row(p) for p in updated]
                        pkg_table.update()

                    ui.button(
                        "Add & Install", icon="add", on_click=_do_add_package
                    ).props("color=primary dense")

            # Packages table
            with ui.card().classes("w-full"):
                with ui.row().classes("items-center justify-between w-full mb-3"):
                    ui.label("Allowed Packages").classes("text-lg font-semibold")

                    async def _refresh_versions():
                        ui.notify("Scanning installed versions...", type="info")
                        await package_service.refresh_all_versions()
                        CodeExecutor.invalidate_cache()
                        updated = await package_service.list_all()
                        pkg_table.rows = [_pkg_row(p) for p in updated]
                        pkg_table.update()
                        ui.notify("Versions refreshed", type="positive")

                    ui.button(
                        "Refresh", icon="refresh", on_click=_refresh_versions
                    ).props("flat dense")

                def _pkg_row(p: dict) -> dict:
                    status = p.get("status", "unknown")
                    status_icon = {
                        "installed": "check_circle",
                        "installing": "hourglass_empty",
                        "pending": "schedule",
                        "failed": "error",
                    }.get(status, "help")
                    return {
                        "id": p["id"],
                        "package_name": p["package_name"],
                        "import_name": p.get("import_name") or p["package_name"],
                        "installed_version": p.get("installed_version") or "-",
                        "status": status,
                        "status_icon": status_icon,
                        "is_enabled": p.get("is_enabled", True),
                        "is_default": p.get("is_default", False),
                        "error_message": p.get("error_message") or "",
                    }

                columns = [
                    {"name": "package_name", "label": "Package", "field": "package_name",
                     "sortable": True, "align": "left"},
                    {"name": "import_name", "label": "Import As", "field": "import_name",
                     "align": "left"},
                    {"name": "installed_version", "label": "Version",
                     "field": "installed_version", "align": "left"},
                    {"name": "status", "label": "Status", "field": "status", "align": "left"},
                    {"name": "is_enabled", "label": "Enabled", "field": "is_enabled",
                     "align": "center"},
                    {"name": "actions", "label": "Actions", "field": "actions",
                     "align": "center"},
                ]

                rows = [_pkg_row(p) for p in packages]

                pkg_table = ui.table(
                    columns=columns,
                    rows=rows,
                    row_key="id",
                ).classes("w-full")

                # Add slot templates for status and action columns
                pkg_table.add_slot(
                    "body-cell-status",
                    """
                    <q-td :props="props">
                        <q-badge
                            :color="props.row.status === 'installed' ? 'positive' :
                                    props.row.status === 'installing' ? 'warning' :
                                    props.row.status === 'failed' ? 'negative' : 'grey'"
                            :label="props.row.status"
                        />
                        <q-tooltip v-if="props.row.error_message">
                            {{ props.row.error_message }}
                        </q-tooltip>
                    </q-td>
                    """,
                )

                pkg_table.add_slot(
                    "body-cell-is_enabled",
                    """
                    <q-td :props="props">
                        <q-toggle
                            :model-value="props.row.is_enabled"
                            @update:model-value="() => $parent.$emit('toggle_enabled', props.row)"
                            dense
                        />
                    </q-td>
                    """,
                )

                pkg_table.add_slot(
                    "body-cell-actions",
                    """
                    <q-td :props="props">
                        <q-btn
                            v-if="props.row.status !== 'installed'"
                            icon="download"
                            dense flat round size="sm"
                            color="primary"
                            @click="$parent.$emit('install_pkg', props.row)"
                        >
                            <q-tooltip>Install</q-tooltip>
                        </q-btn>
                        <q-btn
                            v-if="props.row.status === 'installed'"
                            icon="upgrade"
                            dense flat round size="sm"
                            color="secondary"
                            @click="$parent.$emit('update_pkg', props.row)"
                        >
                            <q-tooltip>Update</q-tooltip>
                        </q-btn>
                        <q-btn
                            v-if="!props.row.is_default"
                            icon="delete"
                            dense flat round size="sm"
                            color="negative"
                            @click="$parent.$emit('remove_pkg', props.row)"
                        >
                            <q-tooltip>Remove</q-tooltip>
                        </q-btn>
                    </q-td>
                    """,
                )

                async def _on_toggle_enabled(e):
                    row = e.args
                    new_val = not row["is_enabled"]
                    await package_service.toggle_enabled(row["id"], new_val)
                    CodeExecutor.invalidate_cache()
                    updated = await package_service.list_all()
                    pkg_table.rows = [_pkg_row(p) for p in updated]
                    pkg_table.update()
                    state = "enabled" if new_val else "disabled"
                    ui.notify(f"{row['package_name']} {state}", type="info")

                async def _on_install(e):
                    row = e.args
                    ui.notify(f"Installing {row['package_name']}...", type="info")
                    result = await package_service.install_package(row["id"])
                    CodeExecutor.invalidate_cache()
                    if result["success"]:
                        ui.notify(
                            f"Installed {row['package_name']} v{result.get('version', '?')}",
                            type="positive",
                        )
                    else:
                        ui.notify(
                            f"Failed: {result.get('error', 'unknown')}",
                            type="negative",
                        )
                    updated = await package_service.list_all()
                    pkg_table.rows = [_pkg_row(p) for p in updated]
                    pkg_table.update()

                async def _on_update(e):
                    row = e.args
                    ui.notify(f"Updating {row['package_name']}...", type="info")
                    result = await package_service.update_package(row["id"])
                    CodeExecutor.invalidate_cache()
                    if result["success"]:
                        ui.notify(
                            f"Updated to v{result.get('version', '?')}",
                            type="positive",
                        )
                    else:
                        ui.notify(f"Failed: {result.get('error', 'unknown')}", type="negative")
                    updated = await package_service.list_all()
                    pkg_table.rows = [_pkg_row(p) for p in updated]
                    pkg_table.update()

                async def _on_remove(e):
                    row = e.args
                    ok = await package_service.remove_package(row["id"])
                    CodeExecutor.invalidate_cache()
                    if ok:
                        ui.notify(f"Removed {row['package_name']}", type="positive")
                    else:
                        ui.notify("Cannot remove default packages", type="warning")
                    updated = await package_service.list_all()
                    pkg_table.rows = [_pkg_row(p) for p in updated]
                    pkg_table.update()

                pkg_table.on("toggle_enabled", _on_toggle_enabled)
                pkg_table.on("install_pkg", _on_install)
                pkg_table.on("update_pkg", _on_update)
                pkg_table.on("remove_pkg", _on_remove)

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
            with ui.card().classes("w-full bg-blue-1 border"):
                with ui.row().classes("items-start gap-3 p-4"):
                    ui.icon("info", size="sm").classes("text-primary mt-1 flex-shrink-0")
                    with ui.column().classes("gap-1"):
                        ui.label("AI Agent Setup").classes("font-semibold text-primary")
                        ui.label(
                            "Keys are stored in your user profile on the server. "
                            "They never leave your server and are only used for direct API calls "
                            "to Anthropic or OpenAI."
                        ).classes("text-sm text-primary")

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
                    ).classes("text-xs text-grey-5")

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
                    ).classes("text-xs text-grey-5")

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
                        "text-sm font-mono text-grey-7"
                    )

                status_area = ui.label(
                    git.get_status() or "(not initialized — click Initialize below)"
                ).classes(
                    "text-xs font-mono whitespace-pre bg-grey-2 rounded p-2 w-full"
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
                ).classes("text-sm text-grey-6 mb-3")

                workspace_input = ui.input(
                    label="Workspace Path",
                    value=storage.get("git_workspace_path", str(DEFAULT_WORKSPACE)),
                ).classes("w-full")

                ui.label(f"Current: {git.workspace}").classes("text-xs text-grey-5 mt-1")

                def _set_workspace():
                    nonlocal git
                    new_path = workspace_input.value.strip()
                    if not new_path:
                        ui.notify("Path cannot be empty", type="warning")
                        return
                    from pathlib import Path
                    resolved = Path(new_path).resolve()
                    if ".." in Path(new_path).parts:
                        ui.notify("Path must not contain '..'", type="negative")
                        return
                    storage["git_workspace_path"] = str(resolved)
                    git = reset_git_service(str(resolved))
                    ui.notify(f"Workspace set to: {resolved}", type="positive")
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
                        "text-xs font-mono text-grey-6 mb-2"
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
                    "text-xs font-mono whitespace-pre bg-grey-2 rounded p-2 w-full"
                ).style("min-height: 2rem")

                def _set_op_output(text: str, error: bool = False):
                    op_output.text = text
                    if error:
                        op_output.classes(add="text-negative")
                    else:
                        op_output.classes(remove="text-negative")

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
                ).classes("text-sm text-grey-6 mb-3")

                clone_url_input = ui.input(
                    label="Repository URL",
                    placeholder="https://github.com/user/nicemeta-workspace.git",
                ).classes("w-full")

                clone_output = ui.label("").classes(
                    "text-xs font-mono whitespace-pre bg-grey-2 rounded p-2 w-full"
                ).style("min-height: 2rem")

                async def _do_clone():
                    from nicemeta.services.git_service import _validate_git_url
                    url = clone_url_input.value.strip()
                    if not url:
                        ui.notify("URL is required", type="warning")
                        return
                    url_err = _validate_git_url(url)
                    if url_err:
                        ui.notify(f"Invalid URL: {url_err}", type="negative")
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
                    ).classes("text-grey-5 text-sm")

    def _save_settings(self) -> None:
        """Save settings."""
        ui.notify("Settings saved", type="positive")


def info_item(label: str, value: str) -> None:
    """Create an info item."""
    with ui.row().classes("items-center gap-2"):
        ui.label(f"{label}:").classes("text-grey-6")
        ui.label(value).classes("font-medium")


def stat_box(label: str, value: str) -> None:
    """Create a statistics box."""
    with ui.card().classes("p-4 text-center"):
        ui.label(value).classes("text-2xl font-bold")
        ui.label(label).classes("text-sm text-grey-6")


async def admin_page() -> None:
    """Entry point for admin page."""
    page = AdminPage()
    await page.render()

