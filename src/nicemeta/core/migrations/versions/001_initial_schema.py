"""Initial schema baseline

Revision ID: 001
Revises: 
Create Date: 2026-01-18

This migration represents the initial database schema.
For existing databases, this is stamped as already applied (baseline).
For new databases, this creates all tables.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create all initial tables."""
    # Users table (from FastAPI Users)
    op.create_table(
        "users",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("email", sa.String(320), nullable=False, unique=True, index=True),
        sa.Column("hashed_password", sa.String(1024), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, default=True),
        sa.Column("is_superuser", sa.Boolean(), nullable=False, default=False),
        sa.Column("is_verified", sa.Boolean(), nullable=False, default=False),
        sa.Column("first_name", sa.String(100), nullable=True),
        sa.Column("last_name", sa.String(100), nullable=True),
        sa.Column("display_name", sa.String(200), nullable=True),
        sa.Column("role", sa.String(50), nullable=False, default="viewer"),
        sa.Column("preferences", sa.String(2000), nullable=True),
    )

    # Folders table
    op.create_table(
        "folders",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("parent_id", sa.String(36), sa.ForeignKey("folders.id", ondelete="CASCADE"), nullable=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
        sa.Column("is_public", sa.Boolean(), nullable=False, default=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), onupdate=sa.func.now(), nullable=False),
    )

    # Connections table
    op.create_table(
        "connections",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("db_type", sa.String(50), nullable=False),
        sa.Column("host", sa.String(255), nullable=False, default="localhost"),
        sa.Column("port", sa.Integer(), nullable=True),
        sa.Column("database", sa.String(255), nullable=False),
        sa.Column("username", sa.String(255), nullable=True),
        sa.Column("password", sa.String(255), nullable=True),
        sa.Column("options", sa.JSON(), nullable=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, default=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), onupdate=sa.func.now(), nullable=False),
    )

    # Queries table
    op.create_table(
        "queries",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("query_type", sa.String(20), nullable=False, default="sql"),
        sa.Column("sql", sa.Text(), nullable=True),
        sa.Column("visual_query", sa.JSON(), nullable=True),
        sa.Column("connection_id", sa.String(36), sa.ForeignKey("connections.id", ondelete="SET NULL"), nullable=True),
        sa.Column("folder_id", sa.String(36), sa.ForeignKey("folders.id", ondelete="SET NULL"), nullable=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
        sa.Column("is_public", sa.Boolean(), nullable=False, default=False),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_run_row_count", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), onupdate=sa.func.now(), nullable=False),
    )

    # Visualizations table
    op.create_table(
        "visualizations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("chart_type", sa.String(50), nullable=False),
        sa.Column("renderer", sa.String(50), nullable=False, default="plotly"),
        sa.Column("config", sa.JSON(), nullable=False, default=dict),
        sa.Column("query_id", sa.String(36), sa.ForeignKey("queries.id", ondelete="CASCADE"), nullable=False),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), onupdate=sa.func.now(), nullable=False),
    )

    # Dashboards table
    op.create_table(
        "dashboards",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("layout_config", sa.JSON(), nullable=True),
        sa.Column("folder_id", sa.String(36), sa.ForeignKey("folders.id", ondelete="SET NULL"), nullable=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
        sa.Column("is_public", sa.Boolean(), nullable=False, default=False),
        sa.Column("refresh_interval", sa.Integer(), nullable=False, default=0),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), onupdate=sa.func.now(), nullable=False),
    )

    # Dashboard Widgets table
    op.create_table(
        "dashboard_widgets",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("dashboard_id", sa.String(36), sa.ForeignKey("dashboards.id", ondelete="CASCADE"), nullable=False),
        sa.Column("visualization_id", sa.String(36), sa.ForeignKey("visualizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("position_x", sa.Integer(), nullable=False, default=0),
        sa.Column("position_y", sa.Integer(), nullable=False, default=0),
        sa.Column("width", sa.Integer(), nullable=False, default=6),
        sa.Column("height", sa.Integer(), nullable=False, default=4),
        sa.Column("title_override", sa.String(255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), onupdate=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    """Drop all tables (reverse order due to foreign keys)."""
    op.drop_table("dashboard_widgets")
    op.drop_table("dashboards")
    op.drop_table("visualizations")
    op.drop_table("queries")
    op.drop_table("connections")
    op.drop_table("folders")
    op.drop_table("users")

