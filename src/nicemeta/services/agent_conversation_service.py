"""
Service for persisting AI agent conversations.
"""

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from nicemeta.core.database import get_session_context
from nicemeta.core.models import AgentConversation, generate_uuid


async def list_conversations() -> list[dict]:
    """Return all conversations ordered by most recent first."""
    async with get_session_context() as session:
        result = await session.execute(
            select(AgentConversation).order_by(AgentConversation.updated_at.desc())
        )
        return [_to_dict(c) for c in result.scalars().all()]


async def get_conversation(conversation_id: str) -> dict | None:
    """Get a single conversation by ID."""
    async with get_session_context() as session:
        result = await session.execute(
            select(AgentConversation).where(AgentConversation.id == conversation_id)
        )
        conv = result.scalar_one_or_none()
        return _to_dict(conv) if conv else None


async def create_conversation(
    title: str = "New Chat",
    provider: str | None = None,
    model: str | None = None,
) -> dict:
    """Create a new conversation and return it."""
    async with get_session_context() as session:
        conv = AgentConversation(
            id=generate_uuid(),
            title=title,
            messages=[],
            provider=provider,
            model=model,
        )
        session.add(conv)
        await session.flush()
        return _to_dict(conv)


async def update_messages(conversation_id: str, messages: list[dict]) -> None:
    """Replace the messages list for a conversation."""
    async with get_session_context() as session:
        result = await session.execute(
            select(AgentConversation).where(AgentConversation.id == conversation_id)
        )
        conv = result.scalar_one_or_none()
        if conv:
            conv.messages = messages
            conv.updated_at = datetime.utcnow()
            await session.flush()


async def update_title(conversation_id: str, title: str) -> None:
    """Update the title of a conversation."""
    async with get_session_context() as session:
        result = await session.execute(
            select(AgentConversation).where(AgentConversation.id == conversation_id)
        )
        conv = result.scalar_one_or_none()
        if conv:
            conv.title = title
            await session.flush()


async def delete_conversation(conversation_id: str) -> bool:
    """Delete a conversation. Returns True if found and deleted."""
    async with get_session_context() as session:
        result = await session.execute(
            select(AgentConversation).where(AgentConversation.id == conversation_id)
        )
        conv = result.scalar_one_or_none()
        if not conv:
            return False
        await session.delete(conv)
        await session.flush()
        return True


def _to_dict(conv: AgentConversation) -> dict:
    return {
        "id": conv.id,
        "title": conv.title,
        "messages": conv.messages or [],
        "provider": conv.provider,
        "model": conv.model,
        "created_at": str(conv.created_at) if conv.created_at else None,
        "updated_at": str(conv.updated_at) if conv.updated_at else None,
    }
