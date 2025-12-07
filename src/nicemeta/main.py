"""
NiceMeta application entry point.

Starts the NiceGUI web application.
"""

import sys
from pathlib import Path

import uvicorn

from nicemeta.config.settings import get_settings


def run() -> None:
    """Run the NiceMeta application."""
    settings = get_settings()
    
    print(f"""
╔═══════════════════════════════════════════════════════════════════════════╗
║                                                                           ║
║   ███╗   ██╗██╗ ██████╗███████╗███╗   ███╗███████╗████████╗ █████╗        ║
║   ████╗  ██║██║██╔════╝██╔════╝████╗ ████║██╔════╝╚══██╔══╝██╔══██╗       ║
║   ██╔██╗ ██║██║██║     █████╗  ██╔████╔██║█████╗     ██║   ███████║       ║
║   ██║╚██╗██║██║██║     ██╔══╝  ██║╚██╔╝██║██╔══╝     ██║   ██╔══██║       ║
║   ██║ ╚████║██║╚██████╗███████╗██║ ╚═╝ ██║███████╗   ██║   ██║  ██║       ║
║   ╚═╝  ╚═══╝╚═╝ ╚═════╝╚══════╝╚═╝     ╚═╝╚══════╝   ╚═╝   ╚═╝  ╚═╝       ║
║                                                                           ║
║   Open-Source Business Intelligence Platform                              ║
║                                                                           ║
╚═══════════════════════════════════════════════════════════════════════════╝

Starting NiceMeta...
  Host: {settings.app.host}
  Port: {settings.app.port}
  Debug: {settings.app.debug}
  Database: {settings.database.driver}

Open http://{settings.app.host}:{settings.app.port} in your browser.
    """)
    
    # Import here to avoid circular imports
    from nicemeta.ui.app import create_app
    
    # Create the application
    app = create_app()
    
    # Run with uvicorn (disable reload for direct app object)
    uvicorn.run(
        app,
        host=settings.app.host,
        port=settings.app.port,
        reload=False,  # reload requires import string
    )


def main() -> None:
    """CLI entry point."""
    run()


if __name__ == "__main__":
    main()

