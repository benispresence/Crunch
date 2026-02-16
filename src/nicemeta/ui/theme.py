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
    color: #d4d4d4;
}
body.body--dark .q-header,
body.body--dark .q-footer,
body.body--dark .q-drawer {
    background-color: #1e1e1e !important;
    border-color: #3e3e42 !important;
    color: #d4d4d4 !important;
}
body.body--dark .q-header *,
body.body--dark .q-drawer * {
    color: inherit;
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
body.body--dark .q-tab-panels {
    background-color: #1e1e1e;
}
body.body--dark .q-tab--active {
    color: #d4d4d4 !important;
}
body.body--dark .q-separator {
    background-color: #3e3e42;
}
body.body--dark .q-field__native,
body.body--dark .q-field__input {
    color: #d4d4d4 !important;
}
body.body--dark .q-btn--flat {
    color: #d4d4d4;
}

/* --- Quasar light mode color overrides (light grey) --- */
body.body--light {
    --q-primary: #3b82f6;
}
body.body--light .q-header,
body.body--light .q-footer {
    background-color: #ffffff !important;
    border-bottom: 1px solid #e5e7eb;
    color: #1f2937 !important;
}
body.body--light .q-drawer {
    background-color: #ffffff !important;
    border-right: 1px solid #e5e7eb;
    color: #1f2937 !important;
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

/* --- Sidebar/header utility classes (respond to Quasar dark mode) --- */
.nm-sidebar-icon { color: #6b7280; }
.nm-sidebar-muted { color: #9ca3af; }
.nm-sidebar-hover:hover { background-color: rgba(0,0,0,0.04); }
.nm-sidebar-border-b { border-bottom: 1px solid #e5e7eb; }
.nm-sidebar-border-t { border-top: 1px solid #e5e7eb; }

body.body--dark .nm-sidebar-icon { color: #9ca3af; }
body.body--dark .nm-sidebar-muted { color: #6b7280; }
body.body--dark .nm-sidebar-hover:hover { background-color: rgba(255,255,255,0.06); }
body.body--dark .nm-sidebar-border-b { border-bottom-color: #3e3e42; }
body.body--dark .nm-sidebar-border-t { border-top-color: #3e3e42; }

.nm-chip { background-color: #f3f4f6; }
body.body--dark .nm-chip { background-color: #2d2d2d; }

/* --- Active nav item highlight --- */
.nm-nav-active {
    background-color: rgba(107, 114, 128, 0.1);
    border-left: 3px solid #6b7280;
}
body.body--dark .nm-nav-active {
    background-color: rgba(156, 163, 175, 0.12);
    border-left-color: #9ca3af;
}
"""

# Script to sync Quasar's body--dark class with Tailwind's html.dark class
_DARK_SYNC_SCRIPT = """
<script>
(function() {
    function syncDark() {
        document.documentElement.classList.toggle('dark', document.body.classList.contains('body--dark'));
    }
    const observer = new MutationObserver(syncDark);
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    syncDark();
})();
</script>
"""


def inject_theme() -> None:
    """Inject the theme CSS and dark-mode sync script. Call once per page."""
    ui.add_head_html(f"<style>{_THEME_CSS}</style>")
    ui.add_head_html(_DARK_SYNC_SCRIPT)


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

    btn = ui.button(icon="contrast", on_click=toggle).props("flat round dense")
    btn.tooltip("Toggle dark/light mode")
    return btn


def apply_saved_theme() -> None:
    """Apply the user's saved theme preference. Call after inject_theme()."""
    is_dark = app.storage.user.get("nm_dark_mode", True)
    set_dark_mode(is_dark)
