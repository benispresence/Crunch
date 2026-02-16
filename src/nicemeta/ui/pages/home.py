"""
Home page for NiceMeta - Metabase-style landing page.
"""

from nicegui import ui

from nicemeta.ui.components.sidebar import (
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

    header = MetabaseHeader(sidebar=sidebar, title="")
    header.create()

    with ui.column().classes("w-full min-h-screen bg-gray-50 dark:bg-[#252526] p-8"):
        # Welcome section
        with ui.column().classes("max-w-4xl mx-auto gap-8"):
            # Hero
            with ui.column().classes("items-center text-center gap-4 py-8"):
                ui.icon("hexagon", size="xl").classes("text-gray-500 dark:text-gray-400")
                ui.label("Welcome to NiceMeta").classes("text-3xl font-bold text-gray-800 dark:text-gray-100")
                ui.label("Open-source Business Intelligence Platform").classes(
                    "text-lg text-gray-500 dark:text-gray-400"
                )

            # Quick start cards
            ui.label("Start exploring your data").classes("text-lg font-semibold text-gray-700 dark:text-gray-200")

            with ui.row().classes("gap-4 flex-wrap justify-center"):
                quick_action_card(
                    "New Question",
                    "Start a new query with the visual builder",
                    "construction",
                    "/query-builder",
                    "border-l-4 border-l-amber-400/50",
                )
                quick_action_card(
                    "SQL Query",
                    "Write SQL to explore your data",
                    "terminal",
                    "/sql",
                    "border-l-4 border-l-blue-400/50",
                )
                quick_action_card(
                    "New Dashboard",
                    "Create a dashboard with multiple charts",
                    "space_dashboard",
                    "/dashboards",
                    "border-l-4 border-l-emerald-400/50",
                )

            # Recent items section
            with ui.row().classes("w-full gap-8 mt-8"):
                # Recent Queries
                with ui.column().classes("flex-1"):
                    ui.label("Recent Questions").classes("text-lg font-semibold text-gray-700 dark:text-gray-200 mb-4")

                    queries = get_saved_queries()
                    if queries:
                        with ui.column().classes("gap-2"):
                            for query in queries[-5:]:  # Last 5
                                with ui.card().classes(
                                    "w-full cursor-pointer hover:bg-gray-50 dark:hover:bg-[#2d2d2d]"
                                ).on("click", lambda q=query: ui.navigate.to(f"/sql?query_id={q['id']}")):
                                    with ui.row().classes("items-center gap-3 p-2"):
                                        ui.icon("terminal", size="sm").classes("text-gray-500 dark:text-gray-400")
                                        with ui.column().classes("gap-0"):
                                            ui.label(query["name"]).classes("font-medium text-gray-800 dark:text-gray-100")
                                            updated = query.get('updated_at', 'recently')
                                            if updated and len(updated) >= 10:
                                                updated = updated[:10]
                                            ui.label(f"Updated {updated}").classes(
                                                "text-xs text-gray-400 dark:text-gray-500"
                                            )
                    else:
                        with ui.card().classes("w-full"):
                            with ui.row().classes("items-center justify-center p-6 text-gray-400 dark:text-gray-500"):
                                ui.icon("article", size="md")
                                ui.label("No saved questions yet")

                # Recent Dashboards
                with ui.column().classes("flex-1"):
                    ui.label("Recent Dashboards").classes("text-lg font-semibold text-gray-700 dark:text-gray-200 mb-4")

                    dashboards = get_saved_dashboards()
                    if dashboards:
                        with ui.column().classes("gap-2"):
                            for dashboard in dashboards[-5:]:
                                with ui.card().classes(
                                    "w-full cursor-pointer hover:bg-gray-50 dark:hover:bg-[#2d2d2d]"
                                ).on("click", lambda d=dashboard: ui.navigate.to(f"/dashboards/{d['id']}")):
                                    with ui.row().classes("items-center gap-3 p-2"):
                                        ui.icon("space_dashboard", size="sm").classes("text-gray-500 dark:text-gray-400")
                                        ui.label(dashboard["name"]).classes("font-medium text-gray-800 dark:text-gray-100")
                    else:
                        with ui.card().classes("w-full"):
                            with ui.row().classes("items-center justify-center p-6 text-gray-400 dark:text-gray-500"):
                                ui.icon("space_dashboard", size="md")
                                ui.label("No dashboards yet")

            # Stats
            connections = get_connections()
            with ui.row().classes("gap-4 flex-wrap justify-center mt-8"):
                stat_card("Questions", str(len(get_saved_queries())), "article", "text-blue-500")
                stat_card("Dashboards", str(len(get_saved_dashboards())), "space_dashboard", "text-green-500")
                stat_card("Connections", str(len(connections)), "storage", "text-purple-500")

            # Connection status
            if not connections:
                with ui.card().classes("w-full bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800"):
                    with ui.row().classes("items-center gap-4 p-4"):
                        ui.icon("warning", size="md").classes("text-orange-500 dark:text-orange-400")
                        with ui.column().classes("flex-grow"):
                            ui.label("No data connections yet").classes("font-semibold text-orange-700 dark:text-orange-300")
                            ui.label("Add a database connection to start exploring your data").classes(
                                "text-sm text-orange-600 dark:text-orange-400"
                            )
                        ui.button(
                            "Add Connection",
                            icon="add",
                            on_click=lambda: ui.navigate.to("/connections"),
                        ).props("color=orange")


def quick_action_card(
    title: str, description: str, icon: str, link: str, border_class: str = ""
) -> ui.element:
    """Create a quick action card."""
    with ui.card().classes(
        f"cursor-pointer hover:shadow-lg transition-all hover:-translate-y-1 w-72 {border_class}"
    ) as card:
        card.on("click", lambda: ui.navigate.to(link))

        with ui.column().classes("gap-3 p-4"):
            with ui.row().classes(
                "items-center justify-center w-12 h-12 rounded-lg bg-gray-200 dark:bg-[#2d2d2d]"
            ):
                ui.icon(icon, size="md").classes("text-gray-700 dark:text-gray-200")
            ui.label(title).classes("text-lg font-semibold text-gray-800 dark:text-gray-100")
            ui.label(description).classes("text-sm text-gray-500 dark:text-gray-400")

    return card


def stat_card(
    label: str, value: str, icon: str, icon_class: str
) -> ui.element:
    """Create a statistics card."""
    with ui.card().classes("w-40"):
        with ui.column().classes("items-center gap-2 p-4"):
            ui.icon(icon, size="lg").classes("text-gray-500 dark:text-gray-400")
            ui.label(value).classes("text-3xl font-bold text-gray-800 dark:text-gray-100")
            ui.label(label).classes("text-sm text-gray-500 dark:text-gray-400")

    return None
