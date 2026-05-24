"""
Home page for NiceMeta - Metabase-style landing page.
"""

from nicegui import ui

from crunch.ui.components.agent_panel import AgentPanel
from crunch.ui.components.sidebar import (
    MetabaseHeader,
    MetabaseSidebar,
    get_saved_queries,
    get_saved_dashboards,
    get_connections,
    refresh_cache,
)


async def home_page() -> None:
    """Render the home/dashboard overview page."""
    
    # Refresh cache to ensure we have latest data
    await refresh_cache()
    
    # Create Metabase-style layout
    sidebar = MetabaseSidebar()
    sidebar.create()

    agent = AgentPanel()
    agent.create()

    header = MetabaseHeader(sidebar=sidebar, title="", agent=agent)
    header.create()
    
    with ui.column().classes("w-full min-h-screen p-8"):
        # Welcome section
        with ui.column().classes("max-w-4xl mx-auto gap-8"):
            # Hero
            with ui.column().classes("items-center text-center gap-4 py-8"):
                ui.icon("analytics", size="xl").classes("text-primary")
                ui.label("Welcome to NiceMeta").classes("text-3xl font-bold text-weight-medium")
                ui.label("Open-source Business Intelligence Platform").classes(
                    "text-lg text-grey-6"
                )
            
            # Quick start cards
            ui.label("Start exploring your data").classes("text-lg font-semibold text-weight-medium")
            
            with ui.row().classes("gap-4 flex-wrap justify-center"):
                quick_action_card(
                    "New Question",
                    "Start a new query with the visual builder",
                    "build",
                    "/query-builder",
                    "bg-primary",
                )
                quick_action_card(
                    "SQL Query",
                    "Write SQL to explore your data",
                    "code",
                    "/sql",
                    "bg-accent",
                )
                quick_action_card(
                    "New Dashboard",
                    "Create a dashboard with multiple charts",
                    "dashboard",
                    "/dashboards",
                    "bg-positive",
                )
            
            # Recent items section
            with ui.row().classes("w-full gap-8 mt-8"):
                # Recent Queries
                with ui.column().classes("flex-1"):
                    ui.label("Recent Questions").classes("text-lg font-semibold text-weight-medium mb-4")
                    
                    queries = get_saved_queries()
                    if queries:
                        with ui.column().classes("gap-2"):
                            for query in queries[-5:]:  # Last 5
                                with ui.card().classes(
                                    "w-full cursor-pointer"
                                ).on("click", lambda q=query: ui.navigate.to(f"/sql?query_id={q['id']}")):
                                    with ui.row().classes("items-center gap-3 p-2"):
                                        ui.icon("code", size="sm").classes("text-primary")
                                        with ui.column().classes("gap-0"):
                                            ui.label(query["name"]).classes("font-medium text-weight-medium")
                                            updated = query.get('updated_at', 'recently')
                                            if updated and len(updated) >= 10:
                                                updated = updated[:10]
                                            ui.label(f"Updated {updated}").classes(
                                                "text-xs text-grey-5"
                                            )
                    else:
                        with ui.card().classes("w-full"):
                            with ui.row().classes("items-center justify-center p-6 text-grey-5"):
                                ui.icon("description", size="md")
                                ui.label("No saved questions yet")
                
                # Recent Dashboards
                with ui.column().classes("flex-1"):
                    ui.label("Recent Dashboards").classes("text-lg font-semibold text-weight-medium mb-4")
                    
                    dashboards = get_saved_dashboards()
                    if dashboards:
                        with ui.column().classes("gap-2"):
                            for dashboard in dashboards[-5:]:
                                with ui.card().classes(
                                    "w-full cursor-pointer"
                                ).on("click", lambda d=dashboard: ui.navigate.to(f"/dashboards/{d['id']}")):
                                    with ui.row().classes("items-center gap-3 p-2"):
                                        ui.icon("dashboard", size="sm").classes("text-positive")
                                        ui.label(dashboard["name"]).classes("font-medium text-weight-medium")
                    else:
                        with ui.card().classes("w-full"):
                            with ui.row().classes("items-center justify-center p-6 text-grey-5"):
                                ui.icon("dashboard", size="md")
                                ui.label("No dashboards yet")
            
            # Stats
            connections = get_connections()
            with ui.row().classes("gap-4 flex-wrap justify-center mt-8"):
                stat_card("Questions", str(len(get_saved_queries())), "description", "text-primary")
                stat_card("Dashboards", str(len(get_saved_dashboards())), "dashboard", "text-positive")
                stat_card("Connections", str(len(connections)), "storage", "text-accent")
            
            # Connection status
            if not connections:
                with ui.card().classes("w-full border"):
                    with ui.row().classes("items-center gap-4 p-4"):
                        ui.icon("warning", size="md").classes("text-warning")
                        with ui.column().classes("flex-grow"):
                            ui.label("No data connections yet").classes("font-semibold text-warning")
                            ui.label("Add a database connection to start exploring your data").classes(
                                "text-sm text-warning"
                            )
                        ui.button(
                            "Add Connection",
                            icon="add",
                            on_click=lambda: ui.navigate.to("/connections"),
                        ).props("color=orange")


def quick_action_card(
    title: str, description: str, icon: str, link: str, bg_class: str = "bg-primary"
) -> ui.element:
    """Create a quick action card."""
    with ui.card().classes(
        "cursor-pointer transition-all hover:-translate-y-1 w-72"
    ) as card:
        card.on("click", lambda: ui.navigate.to(link))
        
        with ui.column().classes("gap-3 p-4"):
            with ui.row().classes(
                f"items-center justify-center w-12 h-12 rounded-lg {bg_class}"
            ):
                ui.icon(icon, size="md").classes("text-white")
            ui.label(title).classes("text-lg font-semibold text-weight-medium")
            ui.label(description).classes("text-sm text-grey-6")
    
    return card


def stat_card(
    label: str, value: str, icon: str, icon_class: str
) -> ui.element:
    """Create a statistics card."""
    with ui.card().classes("w-40"):
        with ui.column().classes("items-center gap-2 p-4"):
            ui.icon(icon, size="lg").classes(icon_class)
            ui.label(value).classes("text-3xl font-bold text-weight-medium")
            ui.label(label).classes("text-sm text-grey-6")
    
    return None
