"""
Theme system for NiceMeta.

Uses NiceGUI's native ui.dark_mode() and ui.colors() for theming.
Only injects CSS for custom layout components (sidebar, agent panel, CodeMirror).
"""

from nicegui import app, ui

# CSS for custom layout components ONLY — no Tailwind color overrides.
_LAYOUT_CSS = """
/* ── CodeMirror dark mode ──────────────────────────────────────────────── */
body.body--dark .cm-editor { background-color: #1e1e1e; }
body.body--dark .cm-gutters {
    background-color: #1e1e1e;
    border-right: 1px solid #3e3e42;
    color: #858585;
}
body.body--dark .cm-content { color: #d4d4d4; }
body.body--dark .cm-activeLine { background-color: #2a2d2e; }
body.body--dark .cm-activeLineGutter { background-color: #2a2d2e; }

/* ── Header & footer: neutral surface, not primary color ─────────────── */
.q-header, .q-footer {
    background-color: #fafafa !important;
    color: #333333 !important;
}
body.body--dark .q-header, body.body--dark .q-footer {
    background-color: #252526 !important;
    color: #cccccc !important;
}

/* ── Dark mode text readability ───────────────────────────────────────── */
body.body--dark .text-grey-7 { color: #b0b0b0 !important; }
body.body--dark .text-grey-6 { color: #999999 !important; }
body.body--dark .text-grey-5 { color: #808080 !important; }
body.body--dark .text-weight-medium { color: #e0e0e0 !important; }

/* ── Active nav item highlight ─────────────────────────────────────────── */
.nm-nav-active {
    background-color: rgba(0, 0, 0, 0.06);
    border-left: 3px solid #888;
}
body.body--dark .nm-nav-active {
    background-color: rgba(255, 255, 255, 0.08);
    border-left: 3px solid #aaa;
}

/* ── Sidebar links: no color, inherit text color ─────────────────────── */
.q-drawer--left a,
.q-drawer--left a:visited,
.q-drawer--left a .q-icon,
.q-drawer--left a label {
    color: inherit !important;
}

/* ── Sidebar layout ───────────────────────────────────────────────────── */
.q-drawer--left { overflow: hidden !important; }
.q-drawer--left .q-scrollarea__content {
    overflow-x: hidden !important;
    min-width: 0 !important;
}
.nm-sidebar-row {
    display: flex; align-items: center; overflow: hidden;
    white-space: nowrap; flex-wrap: nowrap; min-width: 0;
    padding: 6px 12px; border-radius: 6px; transition: background 0.12s;
}
.nm-sidebar-row:hover { background: rgba(0, 0, 0, 0.05); }
body.body--dark .nm-sidebar-row:hover { background: rgba(255, 255, 255, 0.06); }
.nm-sidebar-child { padding: 4px 12px 4px 20px; }
.nm-sidebar-label { overflow: hidden; white-space: nowrap; min-width: 0; flex: 1; }
.nm-sidebar-sep { margin: 4px 0 !important; opacity: 0.15; }
.nm-sidebar-section-label {
    font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.08em; padding: 10px 16px 2px; opacity: 0.45;
    overflow: hidden; white-space: nowrap;
}
.nm-sidebar-expansion .q-item {
    overflow: hidden !important; white-space: nowrap !important;
    flex-wrap: nowrap !important; min-width: 0 !important;
    padding: 4px 12px !important;
}
.nm-sidebar-expansion .q-item__label {
    overflow: hidden !important; white-space: nowrap !important;
}
body.nm-resizing .q-drawer--left,
body.nm-resizing .q-page-container { transition: none !important; }
#nm-rh:hover { background: rgba(86, 156, 214, 0.4) !important; }

/* ── AI Agent panel (right drawer) ─────────────────────────────────────── */
.q-drawer--right { overflow: hidden !important; }
.q-drawer--right .q-scrollarea__content {
    overflow-x: hidden !important; min-width: 0 !important;
}
.q-drawer--right .q-markdown p { margin: 0.3em 0; }
.q-drawer--right .q-markdown pre {
    background: #1e1e1e; color: #d4d4d4; border-radius: 6px;
    padding: 10px 14px; overflow-x: auto; font-size: 12px;
}
.q-drawer--right .q-markdown code {
    background: rgba(0,0,0,0.08); border-radius: 3px;
    padding: 1px 4px; font-size: 12px;
}
body.body--dark .q-drawer--right .q-markdown code { background: rgba(255,255,255,0.1); }
.nm-diff {
    font-family: 'JetBrains Mono', 'Fira Mono', monospace;
    font-size: 12px; line-height: 1.5; border-radius: 6px;
    overflow: auto; max-height: 340px; background: #1e1e1e; border: 1px solid #3e3e42;
}
.nm-diff-line { display: block; padding: 0 10px; white-space: pre; }
.nm-diff-add  { background: #1a3a1a; color: #4ec94e; }
.nm-diff-del  { background: #3a1a1a; color: #f97583; }
.nm-diff-hunk { background: #1a1f2e; color: #7a8aaa; padding: 2px 10px; font-size: 11px; }
.nm-diff-ctx  { color: #888; }
.nm-agent-btn-active {
    background: rgba(59, 130, 246, 0.12) !important;
    color: var(--q-primary) !important;
}
"""


def inject_theme() -> None:
    """Set up theme using NiceGUI native APIs. Call once per page."""
    is_dark = app.storage.user.get("nm_dark_mode", True)
    app.storage.user.setdefault("nm_dark_mode", True)

    # Native dark mode — sets body.body--dark/body--light before render
    ui.dark_mode(is_dark)

    # Quasar color palette
    ui.colors(
        primary='#569cd6' if is_dark else '#3b82f6',
        secondary='#26a69a',
        accent='#9c27b0',
        dark='#252526',
        dark_page='#181818',
        positive='#21ba45',
        negative='#c10015',
        info='#31ccec',
        warning='#f2c037',
    )

    # Layout CSS for custom components only
    ui.add_head_html(f"<style>{_LAYOUT_CSS}</style>")

    # Force header/footer to neutral surface colors (Quasar sets inline primary bg)
    if is_dark:
        ui.run_javascript("""
            document.querySelectorAll('.q-header, .q-footer').forEach(el => {
                el.style.setProperty('background-color', '#252526', 'important');
                el.style.setProperty('color', '#cccccc', 'important');
            });
        """)
    else:
        ui.run_javascript("""
            document.body.style.backgroundColor = '#f0f0f0';
            const pc = document.querySelector('.q-page-container');
            if (pc) pc.style.backgroundColor = '#f0f0f0';
            document.querySelectorAll('.q-header, .q-footer').forEach(el => {
                el.style.setProperty('background-color', '#fafafa', 'important');
                el.style.setProperty('color', '#333333', 'important');
            });
        """)


def create_theme_toggle() -> ui.button:
    """Create a dark/light mode toggle button."""
    async def toggle():
        storage = app.storage.user
        is_dark = storage.get("nm_dark_mode", True)
        storage["nm_dark_mode"] = not is_dark
        ui.navigate.reload()

    btn = ui.button(icon="dark_mode", on_click=toggle).props("flat round dense")
    btn.tooltip("Toggle dark/light mode")
    return btn
