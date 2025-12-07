"""
FastAPI Users setup and configuration.

Provides user management with JWT authentication.
"""

from collections.abc import AsyncGenerator
from typing import Annotated
from uuid import UUID

from fastapi import Depends, Request
from fastapi_users import BaseUserManager, FastAPIUsers, UUIDIDMixin
from fastapi_users.authentication import (
    AuthenticationBackend,
    BearerTransport,
    JWTStrategy,
)
from fastapi_users.db import SQLAlchemyUserDatabase
from sqlalchemy.ext.asyncio import AsyncSession

from nicemeta.auth.models import User
from nicemeta.config.settings import get_settings
from nicemeta.core.database import get_async_session


async def get_user_db(
    session: Annotated[AsyncSession, Depends(get_async_session)],
) -> AsyncGenerator[SQLAlchemyUserDatabase, None]:
    """Dependency that yields a SQLAlchemy user database."""
    yield SQLAlchemyUserDatabase(session, User)


class UserManager(UUIDIDMixin, BaseUserManager[User, UUID]):
    """
    User manager handling user lifecycle events.
    
    Customize password hashing, verification, and event callbacks here.
    """

    reset_password_token_secret = get_settings().app.secret_key
    verification_token_secret = get_settings().app.secret_key

    async def on_after_register(
        self, user: User, request: Request | None = None
    ) -> None:
        """Called after successful registration."""
        print(f"User {user.id} ({user.email}) has registered.")

    async def on_after_forgot_password(
        self, user: User, token: str, request: Request | None = None
    ) -> None:
        """Called after password reset request."""
        print(f"User {user.id} requested password reset. Token: {token}")
        # TODO: Send email with reset link

    async def on_after_request_verify(
        self, user: User, token: str, request: Request | None = None
    ) -> None:
        """Called after email verification request."""
        print(f"Verification requested for user {user.id}. Token: {token}")
        # TODO: Send verification email


async def get_user_manager(
    user_db: Annotated[SQLAlchemyUserDatabase, Depends(get_user_db)],
) -> AsyncGenerator[UserManager, None]:
    """Dependency that yields a user manager."""
    yield UserManager(user_db)


# JWT Authentication setup
bearer_transport = BearerTransport(tokenUrl="api/auth/jwt/login")


def get_jwt_strategy() -> JWTStrategy:
    """Get JWT strategy with settings from config."""
    settings = get_settings()
    return JWTStrategy(
        secret=settings.app.secret_key,
        lifetime_seconds=settings.auth.jwt_lifetime_seconds,
    )


auth_backend = AuthenticationBackend(
    name="jwt",
    transport=bearer_transport,
    get_strategy=get_jwt_strategy,
)

# FastAPI Users instance
fastapi_users = FastAPIUsers[User, UUID](
    get_user_manager,
    [auth_backend],
)

# Dependency for getting current active user
current_active_user = fastapi_users.current_user(active=True)
current_superuser = fastapi_users.current_user(active=True, superuser=True)


# Optional dependency - returns None if not authenticated
current_user_optional = fastapi_users.current_user(active=True, optional=True)


def get_auth_router():
    """Get the authentication router for JWT login/logout."""
    return fastapi_users.get_auth_router(auth_backend)


def get_register_router():
    """Get the registration router."""
    from nicemeta.auth.schemas import UserCreate, UserRead
    return fastapi_users.get_register_router(UserRead, UserCreate)


def get_users_router():
    """Get the users management router."""
    from nicemeta.auth.schemas import UserRead, UserUpdate
    return fastapi_users.get_users_router(UserRead, UserUpdate)


def get_reset_password_router():
    """Get the password reset router."""
    return fastapi_users.get_reset_password_router()


def get_verify_router():
    """Get the email verification router."""
    from nicemeta.auth.schemas import UserRead
    return fastapi_users.get_verify_router(UserRead)

