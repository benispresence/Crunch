"""
Pending state tracker for AI agent actions.

Tracks items created by the agent that are awaiting user acceptance:
- SQL/Python edits (pending in editor)
- Saved queries (pending in sidebar)
- Dashboards (pending in sidebar)
"""

from dataclasses import dataclass, field
from datetime import datetime
from uuid import uuid4


@dataclass
class PendingItem:
    """A single pending agent action."""

    id: str
    item_type: str  # "sql_edit", "python_edit", "query", "dashboard", "widget"
    entity_id: str | None  # DB id of created entity (query_id, dashboard_id)
    status: str  # "pending", "accepted", "rejected"
    data: dict  # type-specific data (old_code, new_code, name, ...)
    created_at: datetime = field(default_factory=datetime.utcnow)


class PendingState:
    """Session-scoped pending state for agent actions."""

    def __init__(self) -> None:
        self._items: list[PendingItem] = []

    def add(self, item: PendingItem) -> None:
        self._items.append(item)

    def get_pending(self) -> list[PendingItem]:
        return [i for i in self._items if i.status == "pending"]

    def get_pending_entity_ids(self) -> set[str]:
        """Return entity IDs of all pending items (for sidebar highlighting)."""
        return {
            i.entity_id
            for i in self._items
            if i.status == "pending" and i.entity_id
        }

    def accept(self, item_id: str) -> PendingItem | None:
        for item in self._items:
            if item.id == item_id and item.status == "pending":
                item.status = "accepted"
                return item
        return None

    def reject(self, item_id: str) -> PendingItem | None:
        for item in self._items:
            if item.id == item_id and item.status == "pending":
                item.status = "rejected"
                return item
        return None

    def accept_all(self) -> list[PendingItem]:
        accepted = []
        for item in self._items:
            if item.status == "pending":
                item.status = "accepted"
                accepted.append(item)
        return accepted

    def reject_all(self) -> list[PendingItem]:
        rejected = []
        for item in self._items:
            if item.status == "pending":
                item.status = "rejected"
                rejected.append(item)
        return rejected

    def clear(self) -> None:
        self._items.clear()
