"""
Alembic migration environment for NiceMeta.

Supports both synchronous and asynchronous migrations.
This is similar to Flyway's environment configuration.
"""

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config, create_async_engine

# Import the SQLAlchemy models
from nicemeta.core.models import Base
from nicemeta.config.settings import get_settings

# Alembic Config object
config = context.config

# Configure logging
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Set the target metadata for autogenerate
target_metadata = Base.metadata


def get_url() -> str:
    """Get the database URL from settings."""
    settings = get_settings()
    return settings.database.url


def run_migrations_offline() -> None:
    """
    Run migrations in 'offline' mode.
    
    This generates SQL scripts without connecting to the database.
    Useful for generating migration scripts to apply manually.
    """
    url = get_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    """Run migrations with a database connection."""
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
        compare_server_default=True,
    )

    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    """
    Run migrations in 'online' mode using async engine.
    
    Creates an async Engine and associates a connection with the context.
    """
    settings = get_settings()
    
    # Create async engine with appropriate settings
    if settings.database.driver == "sqlite":
        connectable = create_async_engine(
            settings.database.url,
            poolclass=pool.NullPool,
            connect_args={"check_same_thread": False},
        )
    else:
        connectable = create_async_engine(
            settings.database.url,
            poolclass=pool.NullPool,
        )

    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)

    await connectable.dispose()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode."""
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()

