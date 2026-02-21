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

/* ── Sidebar: single-scroll, text-clips-at-resize-line ─────────────────── */

/* The drawer clips everything at its right edge */
.q-drawer--left {
    overflow: hidden !important;
}

/* Scrollarea content: no horizontal scroll, text just vanishes at the line */
.q-drawer--left .q-scrollarea__content {
    overflow-x: hidden !important;
    min-width: 0 !important;
}

/* Every sidebar row: one line, no wrap, clips at drawer edge */
.nm-sidebar-row {
    display: flex;
    align-items: center;
    overflow: hidden;
    white-space: nowrap;
    flex-wrap: nowrap;
    min-width: 0;
    padding: 6px 12px;
    border-radius: 6px;
    transition: background 0.12s;
}
.nm-sidebar-row:hover {
    background: rgba(0, 0, 0, 0.05);
}
body.body--dark .nm-sidebar-row:hover {
    background: rgba(255, 255, 255, 0.06);
}

/* Child rows inside expansions get smaller indent */
.nm-sidebar-child {
    padding: 4px 12px 4px 20px;
}

/* Labels inside rows clip too */
.nm-sidebar-label {
    overflow: hidden;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
}

/* Section dividers */
.nm-sidebar-sep {
    margin: 4px 0 !important;
    opacity: 0.15;
}

/* Section group header ("Browse", etc.) */
.nm-sidebar-section-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 10px 16px 2px;
    opacity: 0.45;
    overflow: hidden;
    white-space: nowrap;
}

/* Expansion items: clip header label at drawer edge */
.nm-sidebar-expansion .q-item {
    overflow: hidden !important;
    white-space: nowrap !important;
    flex-wrap: nowrap !important;
    min-width: 0 !important;
    padding: 4px 12px !important;
}
.nm-sidebar-expansion .q-item__label {
    overflow: hidden !important;
    white-space: nowrap !important;
}

/* Suppress transitions during drag resize */
body.nm-resizing .q-drawer--left,
body.nm-resizing .q-page-container {
    transition: none !important;
}

/* Resize handle hover highlight (rendered by JS) */
#nm-rh:hover {
    background: rgba(86, 156, 214, 0.4) !important;
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
