"""
Basic tests for NiceMeta.
"""

import pytest


def test_import():
    """Test that the package can be imported."""
    import nicemeta
    assert nicemeta.__version__ == "0.1.0"


def test_settings_import():
    """Test that settings can be imported."""
    from nicemeta.config.settings import Settings, get_settings
    
    settings = Settings()
    assert settings.app.title == "NiceMeta"
    assert settings.app.port == 8080


def test_query_builder():
    """Test the visual query builder."""
    from nicemeta.query.builder import (
        Column,
        Filter,
        FilterOperator,
        QueryBuilder,
        VisualQuery,
    )
    
    builder = QueryBuilder()
    
    query = VisualQuery(
        table="users",
        columns=[
            Column(name="id"),
            Column(name="email"),
        ],
        filters=[
            Filter(column="active", operator=FilterOperator.EQUALS, value=True),
        ],
        limit=100,
    )
    
    sql = builder.build(query)
    
    assert "SELECT" in sql
    assert '"users"' in sql
    assert '"id"' in sql
    assert '"email"' in sql
    assert "LIMIT 100" in sql


def test_query_validator():
    """Test SQL query validation."""
    from nicemeta.query.validator import QueryValidator, QueryType
    
    validator = QueryValidator()
    
    # Test SELECT detection
    result = validator.validate("SELECT * FROM users")
    assert result.is_valid
    assert result.query_type == QueryType.SELECT
    assert result.is_read_only
    
    # Test INSERT detection
    result = validator.validate("INSERT INTO users VALUES (1)")
    assert not result.is_valid  # Writes not allowed by default
    assert result.query_type == QueryType.INSERT
    
    # Test with writes allowed
    validator_with_writes = QueryValidator(allow_writes=True)
    result = validator_with_writes.validate("INSERT INTO users VALUES (1)")
    assert result.is_valid


def test_chart_types():
    """Test chart type definitions."""
    from nicemeta.visualization.chart_types import (
        CHART_TYPES,
        ChartCategory,
        get_chart_type,
        get_chart_types_by_category,
    )
    
    # Test getting chart type
    line_chart = get_chart_type("line")
    assert line_chart is not None
    assert line_chart.name == "Line Chart"
    assert "plotly" in line_chart.supported_renderers
    
    # Test category filtering
    basic_charts = get_chart_types_by_category(ChartCategory.BASIC)
    assert len(basic_charts) > 0
    assert all(ct.category == ChartCategory.BASIC for ct in basic_charts)


def test_chart_factory():
    """Test chart factory."""
    from nicemeta.visualization.factory import ChartFactory
    
    # Test renderer listing
    renderers = ChartFactory.get_available_renderers()
    assert "plotly" in renderers
    assert "matplotlib" in renderers
    assert "seaborn" in renderers
    
    # Test getting renderer
    plotly = ChartFactory.get_renderer("plotly")
    assert plotly.name == "plotly"
    
    # Test chart types listing
    chart_types = ChartFactory.get_chart_types()
    assert len(chart_types) > 0
    assert any(ct["id"] == "line" for ct in chart_types)


@pytest.mark.asyncio
async def test_connection_manager():
    """Test connection manager."""
    from nicemeta.connections.manager import ConnectionManager
    from nicemeta.config.connections import ConnectionConfig
    
    manager = ConnectionManager()
    
    # Test supported types
    types = manager.get_supported_types()
    assert "postgresql" in types
    assert "mysql" in types
    assert "sqlite" in types
    
    # Test creating SQLite adapter
    config = ConnectionConfig(
        name="Test SQLite",
        type="sqlite",
        database=":memory:",
    )
    
    adapter = manager.create_adapter(config)
    assert adapter.db_type == "sqlite"

