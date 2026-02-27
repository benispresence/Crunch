"""
Folder service for organizing queries and dashboards.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from nicemeta.core.models import Dashboard, Folder, Query


class FolderService:
    """
    Service for managing folders.
    
    Provides hierarchical organization for queries and dashboards.
    """

    def __init__(self, session: AsyncSession):
        """
        Initialize the folder service.
        
        Args:
            session: Database session
        """
        self.session = session

    async def create_folder(
        self,
        name: str,
        owner_id: str | None = None,
        parent_id: str | None = None,
        description: str | None = None,
        is_public: bool = False,
    ) -> Folder:
        """
        Create a new folder.
        
        Args:
            name: Folder name
            owner_id: Owner user ID
            parent_id: Parent folder ID (None for root)
            description: Folder description
            is_public: Whether folder is publicly visible
            
        Returns:
            Created Folder object
        """
        folder = Folder(
            name=name,
            description=description,
            parent_id=parent_id,
            owner_id=owner_id,
            is_public=is_public,
        )
        
        self.session.add(folder)
        await self.session.flush()
        
        return folder

    async def get_folder(self, folder_id: str) -> Folder | None:
        """Get a folder by ID with children."""
        result = await self.session.execute(
            select(Folder)
            .options(
                selectinload(Folder.children),
                selectinload(Folder.queries),
                selectinload(Folder.dashboards),
            )
            .where(Folder.id == folder_id)
        )
        return result.scalar_one_or_none()

    async def get_root_folders(self, owner_id: str | None = None) -> list[Folder]:
        """Get all root folders, optionally filtered by owner."""
        stmt = select(Folder).where(Folder.parent_id.is_(None))
        if owner_id is not None:
            stmt = stmt.where(Folder.owner_id == owner_id)
        result = await self.session.execute(stmt.order_by(Folder.name))
        return list(result.scalars().all())

    async def get_folder_tree(self, owner_id: str | None = None) -> list[dict]:
        """
        Get the complete folder tree, optionally filtered by owner.

        Returns a nested structure with folders, queries, and dashboards.
        """
        stmt = (
            select(Folder)
            .options(
                selectinload(Folder.queries),
                selectinload(Folder.dashboards),
            )
        )
        if owner_id is not None:
            stmt = stmt.where(Folder.owner_id == owner_id)
        result = await self.session.execute(stmt.order_by(Folder.name))
        folders = list(result.scalars().all())
        
        # Build tree structure
        folder_map = {f.id: f for f in folders}
        tree = []
        
        for folder in folders:
            if folder.parent_id is None:
                tree.append(self._build_folder_node(folder, folder_map))
        
        return tree

    def _build_folder_node(self, folder: Folder, folder_map: dict) -> dict:
        """Build a folder node for the tree."""
        node = {
            "id": folder.id,
            "name": folder.name,
            "type": "folder",
            "children": [],
            "items": [],
        }
        
        # Add child folders
        for child_folder in folder.children:
            if child_folder.id in folder_map:
                node["children"].append(
                    self._build_folder_node(folder_map[child_folder.id], folder_map)
                )
        
        # Add queries
        for query in folder.queries:
            node["items"].append({
                "id": query.id,
                "name": query.name,
                "type": "query",
            })
        
        # Add dashboards
        for dashboard in folder.dashboards:
            node["items"].append({
                "id": dashboard.id,
                "name": dashboard.name,
                "type": "dashboard",
            })
        
        return node

    async def update_folder(
        self,
        folder_id: str,
        **updates,
    ) -> Folder | None:
        """
        Update a folder.
        
        Args:
            folder_id: Folder ID
            **updates: Fields to update
            
        Returns:
            Updated Folder or None if not found
        """
        folder = await self.get_folder(folder_id)
        if not folder:
            return None
        
        for key, value in updates.items():
            if hasattr(folder, key):
                setattr(folder, key, value)
        
        await self.session.flush()
        return folder

    async def delete_folder(self, folder_id: str, recursive: bool = False) -> bool:
        """
        Delete a folder.
        
        Args:
            folder_id: Folder ID
            recursive: If True, delete contents. If False, fail if not empty.
            
        Returns:
            True if deleted, False if not found or not empty
        """
        folder = await self.get_folder(folder_id)
        if not folder:
            return False
        
        # Check if folder has contents
        has_contents = (
            folder.children or folder.queries or folder.dashboards
        )
        
        if has_contents and not recursive:
            return False
        
        # Delete folder (cascade will handle children if recursive)
        await self.session.delete(folder)
        await self.session.flush()
        return True

    async def move_item(
        self,
        item_id: str,
        item_type: str,
        target_folder_id: str | None,
    ) -> bool:
        """
        Move an item to a different folder.
        
        Args:
            item_id: Item ID (query or dashboard)
            item_type: "query" or "dashboard"
            target_folder_id: Target folder ID (None for root)
            
        Returns:
            True if moved successfully
        """
        if item_type == "query":
            result = await self.session.execute(
                select(Query).where(Query.id == item_id)
            )
            item = result.scalar_one_or_none()
        elif item_type == "dashboard":
            result = await self.session.execute(
                select(Dashboard).where(Dashboard.id == item_id)
            )
            item = result.scalar_one_or_none()
        else:
            return False
        
        if not item:
            return False
        
        item.folder_id = target_folder_id
        await self.session.flush()
        return True

    async def search(
        self,
        owner_id: str,
        query: str,
    ) -> dict:
        """
        Search for folders, queries, and dashboards.
        
        Args:
            owner_id: Owner user ID
            query: Search query
            
        Returns:
            Dict with folders, queries, dashboards lists
        """
        search_pattern = f"%{query}%"
        
        # Search folders
        folder_result = await self.session.execute(
            select(Folder)
            .where(Folder.owner_id == owner_id)
            .where(Folder.name.ilike(search_pattern))
        )
        folders = list(folder_result.scalars().all())
        
        # Search queries
        query_result = await self.session.execute(
            select(Query)
            .where(Query.owner_id == owner_id)
            .where(Query.name.ilike(search_pattern))
        )
        queries = list(query_result.scalars().all())
        
        # Search dashboards
        dashboard_result = await self.session.execute(
            select(Dashboard)
            .where(Dashboard.owner_id == owner_id)
            .where(Dashboard.name.ilike(search_pattern))
        )
        dashboards = list(dashboard_result.scalars().all())
        
        return {
            "folders": [{"id": f.id, "name": f.name} for f in folders],
            "queries": [{"id": q.id, "name": q.name} for q in queries],
            "dashboards": [{"id": d.id, "name": d.name} for d in dashboards],
        }

