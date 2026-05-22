"""
Dashboard service for database CRUD operations.

Handles persistence of dashboards and widgets to the internal database.
"""

from sqlalchemy import select, delete as sql_delete
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from crunch.core.database import get_session_context
from crunch.core.models import Dashboard, DashboardWidget, Query, Visualization


class DashboardService:
    """Service for managing dashboards in the database."""

    @staticmethod
    async def get_all() -> list[dict]:
        """Get all dashboards."""
        async with get_session_context() as session:
            result = await session.execute(
                select(Dashboard)
                .options(selectinload(Dashboard.widgets))
                .order_by(Dashboard.updated_at.desc())
            )
            dashboards = result.scalars().all()
            return [DashboardService._to_dict(d) for d in dashboards]

    @staticmethod
    async def get_by_id(dashboard_id: str) -> dict | None:
        """Get a dashboard by ID with all widgets."""
        async with get_session_context() as session:
            result = await session.execute(
                select(Dashboard)
                .options(
                    selectinload(Dashboard.widgets)
                    .selectinload(DashboardWidget.visualization)
                    .selectinload(Visualization.query)
                )
                .where(Dashboard.id == dashboard_id)
            )
            dashboard = result.scalar_one_or_none()
            return DashboardService._to_dict_full(dashboard) if dashboard else None

    @staticmethod
    async def create(
        name: str,
        description: str | None = None,
        folder_id: str | None = None,
    ) -> dict:
        """Create a new dashboard."""
        async with get_session_context() as session:
            dashboard = Dashboard(
                name=name,
                description=description,
                folder_id=folder_id,
            )
            session.add(dashboard)
            await session.flush()
            await session.refresh(dashboard)
            # Don't try to access widgets for newly created dashboard
            return DashboardService._to_dict(dashboard, include_widget_count=False)

    @staticmethod
    async def update(
        dashboard_id: str,
        name: str | None = None,
        description: str | None = None,
        layout_config: dict | None = None,
    ) -> dict | None:
        """Update a dashboard."""
        async with get_session_context() as session:
            result = await session.execute(
                select(Dashboard)
                .options(selectinload(Dashboard.widgets))
                .where(Dashboard.id == dashboard_id)
            )
            dashboard = result.scalar_one_or_none()
            
            if not dashboard:
                return None
            
            if name is not None:
                dashboard.name = name
            if description is not None:
                dashboard.description = description
            if layout_config is not None:
                dashboard.layout_config = layout_config
            
            await session.flush()
            await session.refresh(dashboard)
            return DashboardService._to_dict(dashboard)

    @staticmethod
    async def delete(dashboard_id: str) -> bool:
        """Delete a dashboard."""
        async with get_session_context() as session:
            result = await session.execute(
                sql_delete(Dashboard).where(Dashboard.id == dashboard_id)
            )
            return result.rowcount > 0

    @staticmethod
    async def add_widget(
        dashboard_id: str,
        query_id: str,
        chart_type: str = "table",
        chart_config: dict | None = None,
        position_x: int = 0,
        position_y: int = 0,
        width: int = 6,
        height: int = 4,
        title_override: str | None = None,
    ) -> dict | None:
        """Add a widget to a dashboard."""
        async with get_session_context() as session:
            # First, get or create a visualization for this query
            viz_result = await session.execute(
                select(Visualization).where(
                    Visualization.query_id == query_id,
                    Visualization.chart_type == chart_type,
                )
            )
            visualization = viz_result.scalar_one_or_none()
            
            if not visualization:
                # Get query name for visualization name
                query_result = await session.execute(
                    select(Query).where(Query.id == query_id)
                )
                query = query_result.scalar_one_or_none()
                if not query:
                    return None
                
                # Create visualization
                visualization = Visualization(
                    name=f"{query.name} - {chart_type}",
                    query_id=query_id,
                    chart_type=chart_type,
                    config=chart_config or {},
                )
                session.add(visualization)
                await session.flush()
            
            # Create widget
            widget = DashboardWidget(
                dashboard_id=dashboard_id,
                visualization_id=visualization.id,
                position_x=position_x,
                position_y=position_y,
                width=width,
                height=height,
                title_override=title_override,
            )
            session.add(widget)
            await session.flush()
            await session.refresh(widget)
            
            return {
                "id": widget.id,
                "dashboard_id": dashboard_id,
                "visualization_id": visualization.id,
                "query_id": query_id,
                "chart_type": chart_type,
                "position_x": position_x,
                "position_y": position_y,
                "width": width,
                "height": height,
                "title_override": title_override,
            }

    @staticmethod
    async def update_widget(
        widget_id: str,
        position_x: int | None = None,
        position_y: int | None = None,
        width: int | None = None,
        height: int | None = None,
        title_override: str | None = None,
    ) -> dict | None:
        """Update a widget's position/size."""
        async with get_session_context() as session:
            result = await session.execute(
                select(DashboardWidget).where(DashboardWidget.id == widget_id)
            )
            widget = result.scalar_one_or_none()
            
            if not widget:
                return None
            
            if position_x is not None:
                widget.position_x = position_x
            if position_y is not None:
                widget.position_y = position_y
            if width is not None:
                widget.width = width
            if height is not None:
                widget.height = height
            if title_override is not None:
                widget.title_override = title_override
            
            await session.flush()
            return {
                "id": widget.id,
                "position_x": widget.position_x,
                "position_y": widget.position_y,
                "width": widget.width,
                "height": widget.height,
            }

    @staticmethod
    async def remove_widget(widget_id: str) -> bool:
        """Remove a widget from a dashboard."""
        async with get_session_context() as session:
            result = await session.execute(
                sql_delete(DashboardWidget).where(DashboardWidget.id == widget_id)
            )
            return result.rowcount > 0

    @staticmethod
    async def update_widgets_positions(widgets: list[dict]) -> bool:
        """Batch update widget positions."""
        async with get_session_context() as session:
            for widget_data in widgets:
                result = await session.execute(
                    select(DashboardWidget).where(
                        DashboardWidget.id == widget_data["id"]
                    )
                )
                widget = result.scalar_one_or_none()
                if widget:
                    widget.position_x = widget_data.get("position_x", widget.position_x)
                    widget.position_y = widget_data.get("position_y", widget.position_y)
                    widget.width = widget_data.get("width", widget.width)
                    widget.height = widget_data.get("height", widget.height)
            
            await session.flush()
            return True

    @staticmethod
    def _to_dict(dashboard: Dashboard, include_widget_count: bool = True) -> dict:
        """Convert a Dashboard model to a dictionary."""
        result = {
            "id": dashboard.id,
            "name": dashboard.name,
            "description": dashboard.description,
            "layout_config": dashboard.layout_config,
            "folder_id": dashboard.folder_id,
            "is_public": dashboard.is_public,
            "created_at": dashboard.created_at.isoformat() if dashboard.created_at else None,
            "updated_at": dashboard.updated_at.isoformat() if dashboard.updated_at else None,
        }
        # Only access widgets if they were eagerly loaded (avoid lazy load outside async)
        if include_widget_count:
            try:
                result["widget_count"] = len(dashboard.widgets) if dashboard.widgets else 0
            except Exception:
                result["widget_count"] = 0
        else:
            result["widget_count"] = 0
        return result

    @staticmethod
    def _to_dict_full(dashboard: Dashboard) -> dict:
        """Convert a Dashboard with widgets to a full dictionary."""
        result = DashboardService._to_dict(dashboard, include_widget_count=True)
        result["widgets"] = []
        
        try:
            widgets = dashboard.widgets
        except Exception:
            widgets = []
        
        if widgets:
            for widget in widgets:
                widget_dict = {
                    "id": widget.id,
                    "position_x": widget.position_x,
                    "position_y": widget.position_y,
                    "width": widget.width,
                    "height": widget.height,
                    "title_override": widget.title_override,
                }
                
                if widget.visualization:
                    widget_dict["visualization"] = {
                        "id": widget.visualization.id,
                        "name": widget.visualization.name,
                        "chart_type": widget.visualization.chart_type,
                        "config": widget.visualization.config,
                    }
                    
                    if widget.visualization.query:
                        widget_dict["query"] = {
                            "id": widget.visualization.query.id,
                            "name": widget.visualization.query.name,
                            "sql": widget.visualization.query.sql,
                            "connection_id": widget.visualization.query.connection_id,
                        }
                
                result["widgets"].append(widget_dict)
        
        return result


# Convenience functions
async def get_dashboards() -> list[dict]:
    """Get all dashboards."""
    return await DashboardService.get_all()


async def get_dashboard_by_id(dashboard_id: str) -> dict | None:
    """Get a dashboard by ID."""
    return await DashboardService.get_by_id(dashboard_id)


async def create_dashboard(name: str, description: str | None = None) -> dict:
    """Create a new dashboard."""
    return await DashboardService.create(name=name, description=description)


async def delete_dashboard(dashboard_id: str) -> bool:
    """Delete a dashboard."""
    return await DashboardService.delete(dashboard_id)


async def add_widget_to_dashboard(
    dashboard_id: str,
    query_id: str,
    chart_type: str = "table",
    chart_config: dict | None = None,
    position_x: int = 0,
    position_y: int = 0,
    width: int = 6,
    height: int = 4,
) -> dict | None:
    """Add a widget to a dashboard."""
    return await DashboardService.add_widget(
        dashboard_id=dashboard_id,
        query_id=query_id,
        chart_type=chart_type,
        chart_config=chart_config,
        position_x=position_x,
        position_y=position_y,
        width=width,
        height=height,
    )


async def update_widget_position(
    widget_id: str,
    position_x: int,
    position_y: int,
    width: int,
    height: int,
) -> dict | None:
    """Update a widget's position."""
    return await DashboardService.update_widget(
        widget_id=widget_id,
        position_x=position_x,
        position_y=position_y,
        width=width,
        height=height,
    )


async def remove_widget(widget_id: str) -> bool:
    """Remove a widget."""
    return await DashboardService.remove_widget(widget_id)
