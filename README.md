# NiceMeta

**Open-source Business Intelligence Platform** - A powerful Metabase alternative built entirely in Python.

NiceMeta provides a modern, intuitive interface for querying databases, building visualizations, and creating interactive dashboards. Built with NiceGUI, SQLAlchemy, and comprehensive Python visualization libraries.

## Features

- **SQL Editor** - Write and execute SQL queries with syntax highlighting
- **Visual Query Builder** - Build queries without writing SQL
- **30+ Visualization Types** - Powered by Plotly, Matplotlib, Seaborn, Altair, and Bokeh
- **Dashboard Builder** - Create interactive dashboards with drag-and-drop
- **Multi-Database Support** - PostgreSQL, MySQL, SQLite, SQL Server
- **User Management** - Role-based access control with JWT authentication
- **Folder Organization** - Organize queries and dashboards hierarchically
- **Docker Ready** - Easy deployment with Docker Compose

## Quick Start

### Prerequisites

- Python 3.11+
- PostgreSQL (recommended) or SQLite for internal database

### Installation

```bash
# Clone the repository
git clone https://github.com/nicemeta/nicemeta.git
cd nicemeta

# Create virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -e .

# Copy example configuration
cp config/settings.example.toml config/settings.toml
cp config/connections.example.yaml config/connections.yaml

# Edit configuration files with your settings
# Then run the application
nicemeta
```

### Docker

```bash
# Build and run with Docker Compose
docker-compose -f docker/docker-compose.yml up -d

# Access the application
open http://localhost:8080
```

## Configuration

### Application Settings (`config/settings.toml`)

```toml
[app]
title = "NiceMeta"
host = "0.0.0.0"
port = 8080
debug = false
secret_key = "your-secret-key-change-in-production"

[database]
driver = "postgresql"
host = "localhost"
port = 5432
name = "nicemeta"
user = "nicemeta"
password = "your-password"

[auth]
jwt_lifetime_seconds = 3600
allow_registration = true
```

### Data Connections (`config/connections.yaml`)

```yaml
connections:
  - name: "My PostgreSQL"
    type: postgresql
    host: localhost
    port: 5432
    database: mydata
    user: analyst
    password: secret
    
  - name: "Analytics MySQL"
    type: mysql
    host: mysql.example.com
    port: 3306
    database: analytics
    user: readonly
    password: secret
```

## Project Structure

```
nicemeta/
├── pyproject.toml           # Project dependencies
├── config/
│   ├── settings.toml        # Application settings
│   └── connections.yaml     # Database connections
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
├── src/nicemeta/
│   ├── main.py              # Entry point
│   ├── config/              # Configuration management
│   ├── core/                # Domain models
│   ├── connections/         # Database adapters
│   ├── query/               # Query execution
│   ├── visualization/       # Chart renderers
│   ├── auth/                # User management
│   ├── ui/                  # NiceGUI components
│   └── services/            # Business logic
└── tests/
```

## Visualization Types

### Plotly (Interactive)
Line, Bar, Scatter, Pie, Donut, Funnel, Treemap, Sunburst, Sankey, Gauge, Choropleth Map, 3D Surface, 3D Scatter, Waterfall, Candlestick, OHLC, Box, Violin, Histogram, Heatmap, Contour

### Matplotlib/Seaborn (Statistical)
Distribution plots, Regression plots, Pair plots, Joint plots, Swarm plots, Strip plots, KDE plots, Rug plots, Cluster maps

### Altair (Declarative)
Faceted charts, Interactive selections, Layered views, Concatenated charts

### Bokeh (Dashboards)
Interactive plots with linked brushing, Streaming data support

## Development

```bash
# Install with dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Format code
black src tests
ruff check src tests --fix

# Type checking
mypy src
```

## Architecture

NiceMeta follows modern software design patterns:

- **Repository Pattern** - Data access abstraction
- **Strategy Pattern** - Swappable visualization renderers
- **Factory Pattern** - Chart and connection creation
- **Adapter Pattern** - Database-specific adapters
- **Dependency Injection** - Via FastAPI's dependency system

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

Contributions are welcome! Please read our contributing guidelines before submitting PRs.

## Acknowledgments

Inspired by [Metabase](https://www.metabase.com/), built with:
- [NiceGUI](https://nicegui.io/) - Python UI framework
- [FastAPI](https://fastapi.tiangolo.com/) - Modern Python web framework
- [SQLAlchemy](https://www.sqlalchemy.org/) - Python SQL toolkit
- [Plotly](https://plotly.com/python/) - Interactive visualizations

