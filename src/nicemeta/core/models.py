"""
SQLAlchemy models for NiceMeta internal database.

These models store application data: queries, dashboards, folders,
data source connections, and visualizations.
"""

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

if TYPE_CHECKING:
    from nicemeta.auth.models import User


class Base(DeclarativeBase):
    """Base class for all SQLAlchemy models."""

    pass


def generate_uuid() -> str:
    """Generate a UUID string."""
    return str(uuid.uuid4())


class TimestampMixin:
    """Mixin that adds created_at and updated_at timestamps."""

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class Folder(Base, TimestampMixin):
    """
    Folder for organizing queries, dashboards, and other items.
    
    Supports hierarchical structure with parent-child relationships.
    """

    __tablename__ = "folders"

    id: Mapped[str] = mapped_column(
        String(36),
        primary_key=True,
        default=generate_uuid,
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    parent_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("folders.id", ondelete="CASCADE"),
        nullable=True,
    )
    owner_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    is_public: Mapped[bool] = mapped_column(Boolean, default=False)

    # Relationships
    parent: Mapped["Folder | None"] = relationship(
        "Folder",
        remote_side=[id],
        back_populates="children",
    )
    children: Mapped[list["Folder"]] = relationship(
        "Folder",
        back_populates="parent",
        cascade="all, delete-orphan",
    )
    queries: Mapped[list["Query"]] = relationship(
        "Query",
        back_populates="folder",
        cascade="all, delete-orphan",
    )
    dashboards: Mapped[list["Dashboard"]] = relationship(
        "Dashboard",
        back_populates="folder",
        cascade="all, delete-orphan",
    )


class Connection(Base, TimestampMixin):
    """
    External data source connection configuration.
    
    Stores connection details for PostgreSQL, MySQL, SQLite, SQL Server.
    """

    __tablename__ = "connections"

    id: Mapped[str] = mapped_column(
        String(36),
        primary_key=True,
        default=generate_uuid,
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    db_type: Mapped[str] = mapped_column(
        String(50),
        nullable=False,
    )  # postgresql, mysql, sqlite, sqlserver
    host: Mapped[str] = mapped_column(String(255), default="localhost")
    port: Mapped[int | None] = mapped_column(Integer, nullable=True)
    database: Mapped[str] = mapped_column(String(255), nullable=False)
    username: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # In production, passwords should be encrypted
    password: Mapped[str | None] = mapped_column(String(255), nullable=True)
    
    # Additional connection options stored as JSON
    options: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    
    owner_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    # Relationships
    queries: Mapped[list["Query"]] = relationship(
        "Query",
        back_populates="connection",
    )


class Query(Base, TimestampMixin):
    """
    Saved query (SQL or visual query definition).
    
    Can be either raw SQL or a visual query builder definition stored as JSON.
    """

    __tablename__ = "queries"

    id: Mapped[str] = mapped_column(
        String(36),
        primary_key=True,
        default=generate_uuid,
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    
    # Query type: 'sql' for raw SQL, 'visual' for query builder
    query_type: Mapped[str] = mapped_column(String(20), default="sql")
    
    # Raw SQL query (for sql type)
    sql: Mapped[str | None] = mapped_column(Text, nullable=True)
    
    # Visual query definition as JSON (for visual type)
    # Contains table, columns, filters, joins, aggregations, etc.
    visual_query: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    
    # Connection to execute query against
    connection_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("connections.id", ondelete="SET NULL"),
        nullable=True,
    )
    
    # Organization
    folder_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("folders.id", ondelete="SET NULL"),
        nullable=True,
    )
    owner_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    
    is_public: Mapped[bool] = mapped_column(Boolean, default=False)
    
    # Cached result metadata
    last_run_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    last_run_row_count: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Relationships
    connection: Mapped["Connection | None"] = relationship(
        "Connection",
        back_populates="queries",
    )
    folder: Mapped["Folder | None"] = relationship(
        "Folder",
        back_populates="queries",
    )
    visualizations: Mapped[list["Visualization"]] = relationship(
        "Visualization",
        back_populates="query",
        cascade="all, delete-orphan",
    )


class Visualization(Base, TimestampMixin):
    """
    Chart/visualization configuration linked to a query.
    
    Stores chart type and configuration for rendering with various libraries.
    """

    __tablename__ = "visualizations"

    id: Mapped[str] = mapped_column(
        String(36),
        primary_key=True,
        default=generate_uuid,
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    
    # Chart configuration
    chart_type: Mapped[str] = mapped_column(String(50), nullable=False)  # line, bar, pie, etc.
    renderer: Mapped[str] = mapped_column(String(50), default="plotly")  # plotly, matplotlib, etc.
    
    # Full chart configuration as JSON
    # Contains axis mappings, colors, labels, aggregations, etc.
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    
    # Source query
    query_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("queries.id", ondelete="CASCADE"),
        nullable=False,
    )
    owner_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )

    # Relationships
    query: Mapped["Query"] = relationship(
        "Query",
        back_populates="visualizations",
    )
    dashboard_widgets: Mapped[list["DashboardWidget"]] = relationship(
        "DashboardWidget",
        back_populates="visualization",
        cascade="all, delete-orphan",
    )


class Dashboard(Base, TimestampMixin):
    """
    Dashboard containing multiple visualization widgets.
    """

    __tablename__ = "dashboards"

    id: Mapped[str] = mapped_column(
        String(36),
        primary_key=True,
        default=generate_uuid,
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    
    # Layout configuration (grid size, etc.)
    layout_config: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    
    # Organization
    folder_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("folders.id", ondelete="SET NULL"),
        nullable=True,
    )
    owner_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    
    is_public: Mapped[bool] = mapped_column(Boolean, default=False)
    
    # Auto-refresh interval in seconds (0 = disabled)
    refresh_interval: Mapped[int] = mapped_column(Integer, default=0)

    # Relationships
    folder: Mapped["Folder | None"] = relationship(
        "Folder",
        back_populates="dashboards",
    )
    widgets: Mapped[list["DashboardWidget"]] = relationship(
        "DashboardWidget",
        back_populates="dashboard",
        cascade="all, delete-orphan",
        order_by="DashboardWidget.position_y, DashboardWidget.position_x",
    )


class DashboardWidget(Base, TimestampMixin):
    """
    Widget placement on a dashboard.
    
    Links a visualization to a dashboard with position and size information.
    """

    __tablename__ = "dashboard_widgets"

    id: Mapped[str] = mapped_column(
        String(36),
        primary_key=True,
        default=generate_uuid,
    )
    
    dashboard_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("dashboards.id", ondelete="CASCADE"),
        nullable=False,
    )
    visualization_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("visualizations.id", ondelete="CASCADE"),
        nullable=False,
    )
    
    # Grid position (x, y coordinates)
    position_x: Mapped[int] = mapped_column(Integer, default=0)
    position_y: Mapped[int] = mapped_column(Integer, default=0)
    
    # Size (width and height in grid units)
    width: Mapped[int] = mapped_column(Integer, default=6)
    height: Mapped[int] = mapped_column(Integer, default=4)
    
    # Widget-specific title override
    title_override: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Relationships
    dashboard: Mapped["Dashboard"] = relationship(
        "Dashboard",
        back_populates="widgets",
    )
    visualization: Mapped["Visualization"] = relationship(
        "Visualization",
        back_populates="dashboard_widgets",
    )

