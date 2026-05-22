"""
Pydantic schemas for user management.

Defines request/response schemas for FastAPI Users.
"""

from uuid import UUID

from fastapi_users import schemas
from pydantic import Field


class UserRead(schemas.BaseUser[UUID]):
    """
    Schema for reading user data (responses).
    
    Inherits from BaseUser:
    - id: UUID
    - email: str
    - is_active: bool
    - is_verified: bool
    - is_superuser: bool
    """

    first_name: str | None = None
    last_name: str | None = None
    display_name: str | None = None
    role: str = "viewer"


class UserCreate(schemas.BaseUserCreate):
    """
    Schema for creating a new user (registration).
    
    Inherits from BaseUserCreate:
    - email: str (required)
    - password: str (required)
    - is_active: bool (optional, default True)
    - is_verified: bool (optional, default False)
    - is_superuser: bool (optional, default False)
    """

    first_name: str | None = None
    last_name: str | None = None
    display_name: str | None = None


class UserUpdate(schemas.BaseUserUpdate):
    """
    Schema for updating user data.
    
    All fields are optional. Inherits from BaseUserUpdate:
    - password: str (optional)
    - email: str (optional)
    - is_active: bool (optional)
    - is_verified: bool (optional)
    - is_superuser: bool (optional)
    """

    first_name: str | None = None
    last_name: str | None = None
    display_name: str | None = None
    role: str | None = None
    preferences: str | None = None

