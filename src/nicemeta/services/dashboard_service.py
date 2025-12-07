"""
Dashboard service for managing dashboards and widgets.
"""

from datetime import datetime
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from nicemeta.core.models import Dashboard, DashboardWidget, Visualization


class DashboardService:
    """
    Service for managing dashboards.
    
    Provides CRUD operations for dashboards and their widgets.
    """

    def __init__(self, session: AsyncSession):
        """
        Initialize the dashboard service.
        
        Args:
            session: Database session
        """
        self.session = session

    async def create_dashboard(
        self,
        name: str,
        owner_id: str,
        description: str | None = None,
        folder_id: str | None = None,
        layout_config: dict | None = None,
    ) -> Dashboard:
        """
        Create a new dashboard.
        
        Args:
            name: Dashboard name
            owner_id: Owner user ID
            description: Dashboard description
            folder_id: Parent folder ID
            layout_config: Grid layout configuration
            
        Returns:
            Created Dashboard object
        """
        dashboard = Dashboard(
            name=name,
            description=description,
            folder_id=folder_id,
            owner_id=owner_id,
            layout_config=layout_config or {"columns": 12},
        )
        
        self.session.add(dashboard)
        await self.session.flush()
        
        return dashboard

    async def get_dashboard(self, dashboard_id: str) -> Dashboard | None:
        """Get a dashboard by ID with its widgets."""
        result = await self.session.execute(
            select(Dashboard)
            .options(selectinload(Dashboard.widgets))
            .where(Dashboard.id == dashboard_id)
        )
        return result.scalar_one_or_none()

    async def get_dashboards_by_owner(
        self,
        owner_id: str,
        folder_id: str | None = None,
    ) -> list[Dashboard]:
        """Get all dashboards owned by a user."""
        stmt = select(Dashboard).where(Dashboard.owner_id == owner_id)
        
        if folder_id is not None:
            stmt = stmt.where(Dashboard.folder_id == folder_id)
        
        result = await self.session.execute(stmt.order_by(Dashboard.updated_at.desc()))
        return list(result.scalars().all())

    async def update_dashboard(
        self,
        dashboard_id: str,
        **updates,
    ) -> Dashboard | None:
        """
        Update a dashboard.
        
        Args:
            dashboard_id: Dashboard ID
            **updates: Fields to update
            
        Returns:
            Updated Dashboard or None if not found
        """
        dashboard = await self.get_dashboard(dashboard_id)
        if not dashboard:
            return None
        
        for key, value in updates.items():
            if hasattr(dashboard, key):
                setattr(dashboard, key, value)
        
        await self.session.flush()
        return dashboard

    async def delete_dashboard(self, dashboard_id: str) -> bool:
        """
        Delete a dashboard.
        
        Args:
            dashboard_id: Dashboard ID
            
        Returns:
            True if deleted, False if not found
        """
        dashboard = await self.get_dashboard(dashboard_id)
        if not dashboard:
            return False
        
        await self.session.delete(dashboard)
        await self.session.flush()
        return True

    async def add_widget(
        self,
        dashboard_id: str,
        visualization_id: str,
        position_x: int = 0,
        position_y: int = 0,
        width: int = 6,
        height: int = 4,
        title_override: str | None = None,
    ) -> DashboardWidget | None:
        """
        Add a widget to a dashboard.
        
        Args:
            dashboard_id: Dashboard ID
            visualization_id: Visualization ID
            position_x: X position in grid
            position_y: Y position in grid
            width: Widget width in grid units
            height: Widget height in grid units
            title_override: Custom title for widget
            
        Returns:
            Created DashboardWidget or None if dashboard not found
        """
        dashboard = await self.get_dashboard(dashboard_id)
        if not dashboard:
            return None
        
        widget = DashboardWidget(
            dashboard_id=dashboard_id,
            visualization_id=visualization_id,
            position_x=position_x,
            position_y=position_y,
            width=width,
            height=height,
            title_override=title_override,
        )
        
        self.session.add(widget)
        await self.session.flush()
        
        return widget

    async def update_widget(
        self,
        widget_id: str,
        **updates,
    ) -> DashboardWidget | None:
        """
        Update a dashboard widget.
        
        Args:
            widget_id: Widget ID
            **updates: Fields to update (position, size, etc.)
            
        Returns:
            Updated widget or None if not found
        """
        result = await self.session.execute(
            select(DashboardWidget).where(DashboardWidget.id == widget_id)
        )
        widget = result.scalar_one_or_none()
        
        if not widget:
            return None
        
        for key, value in updates.items():
            if hasattr(widget, key):
                setattr(widget, key, value)
        
        await self.session.flush()
        return widget

    async def remove_widget(self, widget_id: str) -> bool:
        """
        Remove a widget from its dashboard.
        
        Args:
            widget_id: Widget ID
            
        Returns:
            True if removed, False if not found
        """
        result = await self.session.execute(
            select(DashboardWidget).where(DashboardWidget.id == widget_id)
        )
        widget = result.scalar_one_or_none()
        
        if not widget:
            return False
        
        await self.session.delete(widget)
        await self.session.flush()
        return True

    async def update_layout(
        self,
        dashboard_id: str,
        widgets: list[dict],
    ) -> bool:
        """
        Update the layout of all widgets on a dashboard.
        
        Args:
            dashboard_id: Dashboard ID
            widgets: List of widget updates with id, position_x, position_y, width, height
            
        Returns:
            True if updated successfully
        """
        dashboard = await self.get_dashboard(dashboard_id)
        if not dashboard:
            return False
        
        for widget_update in widgets:
            widget_id = widget_update.get("id")
            if not widget_id:
                continue
            
            await self.update_widget(
                widget_id,
                position_x=widget_update.get("position_x", 0),
                position_y=widget_update.get("position_y", 0),
                width=widget_update.get("width", 6),
                height=widget_update.get("height", 4),
            )
        
        return True

    async def duplicate_dashboard(
        self,
        dashboard_id: str,
        new_name: str | None = None,
        new_owner_id: str | None = None,
    ) -> Dashboard | None:
        """
        Duplicate a dashboard with all its widgets.
        
        Args:
            dashboard_id: Dashboard ID to duplicate
            new_name: Name for the copy
            new_owner_id: Owner for the copy
            
        Returns:
            New Dashboard or None if original not found
        """
        original = await self.get_dashboard(dashboard_id)
        if not original:
            return None
        
        # Create dashboard copy
        copy = Dashboard(
            name=new_name or f"{original.name} (Copy)",
            description=original.description,
            folder_id=original.folder_id,
            owner_id=new_owner_id or original.owner_id,
            layout_config=original.layout_config,
            refresh_interval=original.refresh_interval,
        )
        
        self.session.add(copy)
        await self.session.flush()
        
        # Copy widgets
        for widget in original.widgets:
            widget_copy = DashboardWidget(
                dashboard_id=copy.id,
                visualization_id=widget.visualization_id,
                position_x=widget.position_x,
                position_y=widget.position_y,
                width=widget.width,
                height=widget.height,
                title_override=widget.title_override,
            )
            self.session.add(widget_copy)
        
        await self.session.flush()
        
        return copy

