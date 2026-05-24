"""
Visualization service for database CRUD operations.

Handles persistence of visualization configurations to the internal database.
"""

from sqlalchemy import select, delete as sql_delete
from sqlalchemy.orm import selectinload

from crunch.core.database import get_session_context
from crunch.core.models import Visualization, Query


class VisualizationService:
    """Service for managing visualizations in the database."""

    @staticmethod
    async def get_by_id(visualization_id: str) -> dict | None:
        """Get a visualization by ID."""
        async with get_session_context() as session:
            result = await session.execute(
                select(Visualization).where(Visualization.id == visualization_id)
            )
            viz = result.scalar_one_or_none()
            return VisualizationService._to_dict(viz) if viz else None

    @staticmethod
    async def get_by_query_id(query_id: str) -> dict | None:
        """
        Get the primary visualization for a query.
        
        Returns the most recently updated visualization for the query,
        or None if no visualization exists.
        """
        async with get_session_context() as session:
            result = await session.execute(
                select(Visualization)
                .where(Visualization.query_id == query_id)
                .order_by(Visualization.updated_at.desc())
                .limit(1)
            )
            viz = result.scalar_one_or_none()
            return VisualizationService._to_dict(viz) if viz else None

    @staticmethod
    async def get_all_by_query_id(query_id: str) -> list[dict]:
        """Get all visualizations for a query."""
        async with get_session_context() as session:
            result = await session.execute(
                select(Visualization)
                .where(Visualization.query_id == query_id)
                .order_by(Visualization.updated_at.desc())
            )
            visualizations = result.scalars().all()
            return [VisualizationService._to_dict(v) for v in visualizations]

    @staticmethod
    async def save(
        query_id: str,
        chart_type: str,
        config: dict | None = None,
        python_code: str | None = None,
        name: str | None = None,
        renderer: str = "plotly",
    ) -> dict:
        """
        Save a visualization for a query (create or update).
        
        If a visualization with the same query_id and chart_type exists,
        it will be updated. Otherwise, a new visualization is created.
        
        Args:
            query_id: ID of the query this visualization belongs to
            chart_type: Type of chart (bar, line, pie, etc.)
            config: Chart configuration as JSON dict
            python_code: Custom Python code for visualization (optional)
            name: Name for the visualization (auto-generated if not provided)
            renderer: Rendering library to use (default: plotly)
            
        Returns:
            Dictionary representation of the saved visualization
        """
        async with get_session_context() as session:
            # Check if a visualization already exists for this query
            result = await session.execute(
                select(Visualization)
                .where(Visualization.query_id == query_id)
                .order_by(Visualization.updated_at.desc())
                .limit(1)
            )
            viz = result.scalar_one_or_none()
            
            if viz:
                # Update existing visualization
                viz.chart_type = chart_type
                viz.config = config or {}
                # Only overwrite python_code if a new value is provided;
                # passing None means "keep existing code"
                if python_code is not None:
                    viz.python_code = python_code
                viz.renderer = renderer
                if name:
                    viz.name = name
            else:
                # Get query name for auto-generated visualization name
                if not name:
                    query_result = await session.execute(
                        select(Query).where(Query.id == query_id)
                    )
                    query = query_result.scalar_one_or_none()
                    name = f"{query.name} - {chart_type}" if query else f"Visualization - {chart_type}"
                
                # Create new visualization
                viz = Visualization(
                    query_id=query_id,
                    name=name,
                    chart_type=chart_type,
                    config=config or {},
                    python_code=python_code,
                    renderer=renderer,
                )
                session.add(viz)
            
            await session.flush()
            await session.refresh(viz)
            return VisualizationService._to_dict(viz)

    @staticmethod
    async def update(
        visualization_id: str,
        chart_type: str | None = None,
        config: dict | None = None,
        python_code: str | None = None,
        name: str | None = None,
        renderer: str | None = None,
    ) -> dict | None:
        """Update an existing visualization."""
        async with get_session_context() as session:
            result = await session.execute(
                select(Visualization).where(Visualization.id == visualization_id)
            )
            viz = result.scalar_one_or_none()
            
            if not viz:
                return None
            
            if chart_type is not None:
                viz.chart_type = chart_type
            if config is not None:
                viz.config = config
            if python_code is not None:
                viz.python_code = python_code
            if name is not None:
                viz.name = name
            if renderer is not None:
                viz.renderer = renderer
            
            await session.flush()
            await session.refresh(viz)
            return VisualizationService._to_dict(viz)

    @staticmethod
    async def delete(visualization_id: str) -> bool:
        """Delete a visualization by ID."""
        async with get_session_context() as session:
            result = await session.execute(
                sql_delete(Visualization).where(Visualization.id == visualization_id)
            )
            return result.rowcount > 0

    @staticmethod
    def _to_dict(viz: Visualization) -> dict:
        """Convert a Visualization model to a dictionary."""
        return {
            "id": viz.id,
            "name": viz.name,
            "description": viz.description,
            "chart_type": viz.chart_type,
            "renderer": viz.renderer,
            "config": viz.config,
            "python_code": viz.python_code,
            "query_id": viz.query_id,
            "owner_id": viz.owner_id,
            "created_at": viz.created_at.isoformat() if viz.created_at else None,
            "updated_at": viz.updated_at.isoformat() if viz.updated_at else None,
        }


# Convenience functions for direct import
async def get_visualization_by_query_id(query_id: str) -> dict | None:
    """Get the primary visualization for a query."""
    return await VisualizationService.get_by_query_id(query_id)


async def save_visualization(
    query_id: str,
    chart_type: str,
    config: dict | None = None,
    python_code: str | None = None,
) -> dict:
    """Save a visualization for a query."""
    return await VisualizationService.save(
        query_id=query_id,
        chart_type=chart_type,
        config=config,
        python_code=python_code,
    )

