"""Add python_code field to visualizations

Revision ID: 002
Revises: 001
Create Date: 2026-01-18

Adds a python_code column to store custom visualization code.
This allows users to write custom Python/Plotly code for charts.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "002"
down_revision: Union[str, None] = "001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add python_code column to visualizations table."""
    op.add_column(
        "visualizations",
        sa.Column("python_code", sa.Text(), nullable=True)
    )


def downgrade() -> None:
    """Remove python_code column from visualizations table."""
    op.drop_column("visualizations", "python_code")

