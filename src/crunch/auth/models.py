"""
User model for FastAPI Users integration.

Extends the base SQLAlchemy User model with additional fields.
"""

from fastapi_users.db import SQLAlchemyBaseUserTableUUID
from sqlalchemy import Boolean, String
from sqlalchemy.orm import Mapped, mapped_column

from crunch.core.models import Base


class User(SQLAlchemyBaseUserTableUUID, Base):
    """
    User model with FastAPI Users integration.
    
    Inherits standard fields from SQLAlchemyBaseUserTableUUID:
    - id: UUID primary key
    - email: unique email address
    - hashed_password: bcrypt hashed password
    - is_active: account active status
    - is_verified: email verification status
    - is_superuser: admin privileges
    """

    __tablename__ = "users"

    # Additional user profile fields
    first_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    last_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    display_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    
    # Role for simple RBAC (admin, editor, viewer)
    role: Mapped[str] = mapped_column(String(50), default="viewer")
    
    # User preferences stored as string (can be JSON)
    preferences: Mapped[str | None] = mapped_column(String(2000), nullable=True)

    @property
    def full_name(self) -> str:
        """Get user's full name."""
        if self.first_name and self.last_name:
            return f"{self.first_name} {self.last_name}"
        elif self.first_name:
            return self.first_name
        elif self.display_name:
            return self.display_name
        return self.email.split("@")[0]

    @property
    def is_admin(self) -> bool:
        """Check if user has admin role."""
        return self.is_superuser or self.role == "admin"

    @property
    def can_edit(self) -> bool:
        """Check if user can create/edit content."""
        return self.is_admin or self.role in ("admin", "editor")

