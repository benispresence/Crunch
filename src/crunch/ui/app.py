"""
Main NiceGUI application setup.

Creates and configures the NiceGUI web application.
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from nicegui import app, ui

from crunch.config.settings import get_settings
from crunch.core.database import close_db, init_db


@asynccontextmanager
async def lifespan(fastapi_app: FastAPI):
    """Application lifespan manager."""
    # Startup
    await init_db()
    # Seed default allowed packages for the visualization sandbox
    from crunch.services.package_service import seed_defaults
    await seed_defaults()
    yield
    # Shutdown
    await close_db()


def setup_auth_routes(fastapi_app: FastAPI) -> None:
    """Setup authentication API routes."""
    from crunch.auth.users import (
        get_auth_router,
        get_register_router,
        get_reset_password_router,
        get_users_router,
    )

    # Auth routes
    fastapi_app.include_router(
        get_auth_router(),
        prefix="/api/auth/jwt",
        tags=["auth"],
    )
    fastapi_app.include_router(
        get_register_router(),
        prefix="/api/auth",
        tags=["auth"],
    )
    fastapi_app.include_router(
        get_reset_password_router(),
        prefix="/api/auth",
        tags=["auth"],
    )
    fastapi_app.include_router(
        get_users_router(),
        prefix="/api/users",
        tags=["users"],
    )


def create_app() -> FastAPI:
    """
    Create and configure the NiceGUI/FastAPI application.
    
    Returns:
        Configured FastAPI application
    """
    settings = get_settings()

    # Create FastAPI app with lifespan
    fastapi_app = FastAPI(
        title=settings.app.title,
        lifespan=lifespan,
    )

    # Setup auth routes
    setup_auth_routes(fastapi_app)

    # Initialize NiceGUI with the FastAPI app
    ui.run_with(
        fastapi_app,
        title=settings.app.title,
        favicon="🔷",
        dark=None,  # Controlled via theme.py (Quasar.Dark.set)
        storage_secret=settings.app.secret_key,
    )

    # Setup pages
    setup_pages()

    return fastapi_app


def setup_pages() -> None:
    """Setup all NiceGUI pages/routes."""
    from crunch.ui.pages.admin import admin_page
    from crunch.ui.pages.connections import connections_page
    from crunch.ui.pages.dashboard import dashboard_page
    from crunch.ui.pages.home import home_page
    from crunch.ui.pages.query_builder import query_builder_page
    from crunch.ui.pages.sql_editor import sql_editor_page

    # Register pages
    ui.page("/")(home_page)
    ui.page("/sql")(sql_editor_page)
    ui.page("/query-builder")(query_builder_page)
    ui.page("/dashboards")(dashboard_page)
    ui.page("/dashboards/{dashboard_id}")(dashboard_page)
    ui.page("/connections")(connections_page)
    ui.page("/admin")(admin_page)

