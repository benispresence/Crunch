"""
Minimal theme system for NiceMeta.

Uses Quasar's built-in dark mode with a small CSS overlay for
Cursor-inspired dark colors and CodeMirror theming.
"""

from nicegui import app, ui

# Cursor-inspired dark palette overrides for Quasar
_THEME_CSS = """
/* --- Quasar dark mode color overrides (Cursor-inspired) --- */
body.body--dark {
    --q-dark: #1e1e1e;
    --q-dark-page: #181818;
    --q-primary: #569cd6;
}
body.body--dark .q-header,
body.body--dark .q-footer,
body.body--dark .q-drawer {
    background-color: #252526 !important;
    border-color: #3e3e42 !important;
}
body.body--dark .q-card {
    background-color: #252526;
    border-color: #3e3e42;
}
body.body--dark .q-table__container {
    background-color: #252526;
}
body.body--dark .q-field--outlined .q-field__control:before {
    border-color: #3e3e42;
}

/* --- Quasar light mode color overrides (light grey) --- */
body.body--light {
    --q-primary: #3b82f6;
}
body.body--light .q-header,
body.body--light .q-footer {
    background-color: #ffffff !important;
    border-bottom: 1px solid #e5e7eb;
}
body.body--light .q-drawer {
    background-color: #ffffff !important;
    border-right: 1px solid #e5e7eb;
}
body.body--light .q-page-container {
    background-color: #f5f5f5;
}

/* --- CodeMirror dark mode --- */
body.body--dark .cm-editor {
    background-color: #1e1e1e;
}
body.body--dark .cm-gutters {
    background-color: #1e1e1e;
    border-right: 1px solid #3e3e42;
    color: #858585;
}
body.body--dark .cm-content {
    color: #d4d4d4;
}
body.body--dark .cm-activeLine {
    background-color: #2a2d2e;
}
body.body--dark .cm-activeLineGutter {
    background-color: #2a2d2e;
}

/* --- Active nav item highlight --- */
.nm-nav-active {
    background-color: rgba(59, 130, 246, 0.1);
    border-left: 3px solid var(--q-primary);
}
body.body--dark .nm-nav-active {
    background-color: rgba(86, 156, 214, 0.15);
}
"""


def inject_theme() -> None:
    """Inject the theme CSS. Call once per page."""
    ui.add_head_html(f"<style>{_THEME_CSS}</style>")


def set_dark_mode(dark: bool) -> None:
    """Toggle dark mode using Quasar's built-in mechanism."""
    ui.run_javascript(f"Quasar.Dark.set({'true' if dark else 'false'})")


def create_theme_toggle() -> ui.button:
    """Create a dark/light mode toggle button."""
    async def toggle():
        # Read current state from storage, default to dark
        storage = app.storage.user
        is_dark = storage.get("nm_dark_mode", True)
        new_dark = not is_dark
        storage["nm_dark_mode"] = new_dark
        set_dark_mode(new_dark)

    btn = ui.button(icon="dark_mode", on_click=toggle).props("flat round dense")
    btn.tooltip("Toggle dark/light mode")
    return btn


def apply_saved_theme() -> None:
    """Apply the user's saved theme preference. Call after inject_theme()."""
    is_dark = app.storage.user.get("nm_dark_mode", True)
    set_dark_mode(is_dark)
