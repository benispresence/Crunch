"""Add allowed_packages table

Revision ID: 004
Revises: 003
Create Date: 2026-02-27

Admin-managed whitelist of Python packages available in the visualization sandbox.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "004"
down_revision: Union[str, None] = "003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create allowed_packages table."""
    op.create_table(
        "allowed_packages",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("package_name", sa.String(255), nullable=False, unique=True, index=True),
        sa.Column("import_name", sa.String(255), nullable=True),
        sa.Column("version_spec", sa.String(255), nullable=True),
        sa.Column("installed_version", sa.String(100), nullable=True),
        sa.Column("status", sa.String(50), nullable=False, server_default="pending"),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        sa.Column("is_enabled", sa.Boolean(), nullable=False, server_default=sa.text("1")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    """Drop allowed_packages table."""
    op.drop_table("allowed_packages")
