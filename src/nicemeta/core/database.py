"""
Database session management for NiceMeta internal database.

Provides async SQLAlchemy session management for the internal database
that stores users, queries, dashboards, and other application data.
"""

import logging
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from nicemeta.config.settings import get_settings
from nicemeta.core.models import Base

logger = logging.getLogger(__name__)

# Global engine and session factory (initialized lazily)
_engine = None
_async_session_factory = None


def get_database_url() -> str:
    """Get the database URL from settings."""
    settings = get_settings()
    return settings.database.url


def get_engine():
    """Get or create the async database engine."""
    global _engine
    
    if _engine is None:
        settings = get_settings()
        url = settings.database.url
        
        # SQLite requires special handling for async
        if settings.database.driver == "sqlite":
            _engine = create_async_engine(
                url,
                echo=settings.app.debug,
                connect_args={"check_same_thread": False},
                poolclass=StaticPool,
            )
        else:
            _engine = create_async_engine(
                url,
                echo=settings.app.debug,
                pool_pre_ping=True,
                pool_size=5,
                max_overflow=10,
            )
    
    return _engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    """Get or create the async session factory."""
    global _async_session_factory
    
    if _async_session_factory is None:
        engine = get_engine()
        _async_session_factory = async_sessionmaker(
            engine,
            class_=AsyncSession,
            expire_on_commit=False,
            autoflush=False,
        )
    
    return _async_session_factory


async def get_async_session() -> AsyncGenerator[AsyncSession, None]:
    """
    Dependency that yields an async database session.
    
    Usage with FastAPI:
        @app.get("/items")
        async def get_items(session: AsyncSession = Depends(get_async_session)):
            ...
    """
    session_factory = get_session_factory()
    async with session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


@asynccontextmanager
async def get_session_context() -> AsyncGenerator[AsyncSession, None]:
    """
    Context manager for getting a database session.
    
    Usage:
        async with get_session_context() as session:
            result = await session.execute(...)
    """
    session_factory = get_session_factory()
    async with session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def init_db() -> None:
    """
    Initialize the database using Alembic migrations.
    
    This handles three scenarios:
    1. New database: Runs all migrations from scratch
    2. Existing database without alembic_version: Stamps with head (baseline)
    3. Existing database with alembic_version: Runs pending migrations
    
    Should be called once at application startup.
    """
    engine = get_engine()
    
    # Check if alembic_version table exists
    async with engine.connect() as conn:
        has_alembic = await conn.run_sync(_check_alembic_version_exists)
        has_tables = await conn.run_sync(_check_tables_exist)
    
    if has_tables and not has_alembic:
        # Existing database without migrations tracking
        # Stamp it with head to establish baseline
        logger.info("Existing database detected. Stamping with current migration version...")
        await _stamp_database("head")
    
    # Run any pending migrations
    logger.info("Running database migrations...")
    await _run_migrations()
    logger.info("Database initialization complete.")


def _check_alembic_version_exists(conn) -> bool:
    """Check if the alembic_version table exists (sync function for run_sync)."""
    from sqlalchemy import inspect
    inspector = inspect(conn)
    return "alembic_version" in inspector.get_table_names()


def _check_tables_exist(conn) -> bool:
    """Check if any application tables exist (sync function for run_sync)."""
    from sqlalchemy import inspect
    inspector = inspect(conn)
    tables = inspector.get_table_names()
    # Check for known application tables
    app_tables = {"users", "queries", "dashboards", "connections"}
    return bool(app_tables & set(tables))


async def _run_migrations() -> None:
    """Run Alembic migrations programmatically."""
    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    
    def run_upgrade():
        from alembic import command
        from alembic.config import Config
        
        # Find alembic.ini
        alembic_ini = _find_alembic_ini()
        if alembic_ini is None:
            logger.warning("alembic.ini not found. Falling back to create_all().")
            _fallback_create_all()
            return
        
        config = Config(str(alembic_ini))
        command.upgrade(config, "head")
    
    # Run in thread pool to avoid blocking
    loop = asyncio.get_event_loop()
    with ThreadPoolExecutor() as pool:
        await loop.run_in_executor(pool, run_upgrade)


async def _stamp_database(revision: str) -> None:
    """Stamp the database with a revision without running migrations."""
    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    
    def run_stamp():
        from alembic import command
        from alembic.config import Config
        
        alembic_ini = _find_alembic_ini()
        if alembic_ini is None:
            return
        
        config = Config(str(alembic_ini))
        command.stamp(config, revision)
    
    loop = asyncio.get_event_loop()
    with ThreadPoolExecutor() as pool:
        await loop.run_in_executor(pool, run_stamp)


def _find_alembic_ini() -> Path | None:
    """Find the alembic.ini configuration file."""
    # Try common locations
    candidates = [
        Path.cwd() / "alembic.ini",
        Path(__file__).parent.parent.parent.parent / "alembic.ini",
    ]
    
    for candidate in candidates:
        if candidate.exists():
            return candidate
    
    return None


def _fallback_create_all() -> None:
    """Fallback to create_all if Alembic is not configured."""
    import asyncio
    
    async def create():
        engine = get_engine()
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    
    asyncio.run(create())


async def close_db() -> None:
    """
    Close the database engine and cleanup connections.
    
    Should be called at application shutdown.
    """
    global _engine, _async_session_factory
    
    if _engine is not None:
        await _engine.dispose()
        _engine = None
        _async_session_factory = None

