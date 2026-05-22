"""
Command-line interface for NiceMeta.

Provides commands for running the application and managing database migrations.
Similar to Flyway's CLI but for Python/Alembic.
"""

import argparse
import os
import sys
from pathlib import Path


def get_alembic_config():
    """Get the Alembic configuration object."""
    from alembic.config import Config
    
    # Find the alembic.ini file
    # Start from current directory and look up
    current = Path.cwd()
    alembic_ini = current / "alembic.ini"
    
    if not alembic_ini.exists():
        # Try relative to this file's package
        package_root = Path(__file__).parent.parent.parent
        alembic_ini = package_root / "alembic.ini"
    
    if not alembic_ini.exists():
        print("Error: alembic.ini not found. Run from project root or set ALEMBIC_CONFIG.")
        sys.exit(1)
    
    config = Config(str(alembic_ini))
    return config


def cmd_db_upgrade(args):
    """Run database migrations to the latest version (like flyway migrate)."""
    from alembic import command
    
    config = get_alembic_config()
    revision = args.revision if args.revision else "head"
    
    print(f"Upgrading database to: {revision}")
    command.upgrade(config, revision)
    print("Database upgrade complete.")


def cmd_db_downgrade(args):
    """Rollback database migrations (like flyway undo)."""
    from alembic import command
    
    config = get_alembic_config()
    revision = args.revision if args.revision else "-1"
    
    print(f"Downgrading database to: {revision}")
    command.downgrade(config, revision)
    print("Database downgrade complete.")


def cmd_db_revision(args):
    """Create a new migration revision."""
    from alembic import command
    
    config = get_alembic_config()
    
    print(f"Creating new migration: {args.message}")
    command.revision(
        config,
        message=args.message,
        autogenerate=args.autogenerate,
    )
    print("Migration created. Review the generated file before applying.")


def cmd_db_current(args):
    """Show the current database revision."""
    from alembic import command
    
    config = get_alembic_config()
    command.current(config, verbose=True)


def cmd_db_history(args):
    """Show migration history."""
    from alembic import command
    
    config = get_alembic_config()
    command.history(config, verbose=True)


def cmd_db_stamp(args):
    """Stamp database with a specific revision without running migrations."""
    from alembic import command
    
    config = get_alembic_config()
    revision = args.revision if args.revision else "head"
    
    print(f"Stamping database with revision: {revision}")
    command.stamp(config, revision)
    print("Database stamped.")


def cmd_db_heads(args):
    """Show available migration heads."""
    from alembic import command
    
    config = get_alembic_config()
    command.heads(config, verbose=True)


def cmd_run(args):
    """Run the NiceMeta application."""
    from crunch.main import run
    run()


def main():
    """Main CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Crunch - Open-Source Business Intelligence Platform",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  crunch                      Run the application
  crunch db upgrade           Apply all pending migrations
  crunch db upgrade head      Apply all pending migrations
  crunch db downgrade -1      Rollback one migration
  crunch db revision -m "Add new table"  Create a new migration
  crunch db current           Show current database version
  crunch db history           Show migration history
        """
    )
    
    subparsers = parser.add_subparsers(dest="command", help="Available commands")
    
    # Run command (default when no subcommand is given)
    run_parser = subparsers.add_parser("run", help="Run the NiceMeta application")
    run_parser.set_defaults(func=cmd_run)
    
    # Database commands
    db_parser = subparsers.add_parser("db", help="Database migration commands")
    db_subparsers = db_parser.add_subparsers(dest="db_command", help="Database commands")
    
    # db upgrade
    upgrade_parser = db_subparsers.add_parser(
        "upgrade", 
        help="Apply migrations (like flyway migrate)"
    )
    upgrade_parser.add_argument(
        "revision",
        nargs="?",
        default="head",
        help="Target revision (default: head)"
    )
    upgrade_parser.set_defaults(func=cmd_db_upgrade)
    
    # db downgrade
    downgrade_parser = db_subparsers.add_parser(
        "downgrade",
        help="Rollback migrations (like flyway undo)"
    )
    downgrade_parser.add_argument(
        "revision",
        nargs="?",
        default="-1",
        help="Target revision (default: -1, one step back)"
    )
    downgrade_parser.set_defaults(func=cmd_db_downgrade)
    
    # db revision
    revision_parser = db_subparsers.add_parser(
        "revision",
        help="Create a new migration"
    )
    revision_parser.add_argument(
        "-m", "--message",
        required=True,
        help="Migration message/description"
    )
    revision_parser.add_argument(
        "--autogenerate", "-a",
        action="store_true",
        help="Autogenerate migration from model changes"
    )
    revision_parser.set_defaults(func=cmd_db_revision)
    
    # db current
    current_parser = db_subparsers.add_parser(
        "current",
        help="Show current database revision"
    )
    current_parser.set_defaults(func=cmd_db_current)
    
    # db history
    history_parser = db_subparsers.add_parser(
        "history",
        help="Show migration history"
    )
    history_parser.set_defaults(func=cmd_db_history)
    
    # db stamp
    stamp_parser = db_subparsers.add_parser(
        "stamp",
        help="Stamp database with revision (like flyway baseline)"
    )
    stamp_parser.add_argument(
        "revision",
        nargs="?",
        default="head",
        help="Revision to stamp (default: head)"
    )
    stamp_parser.set_defaults(func=cmd_db_stamp)
    
    # db heads
    heads_parser = db_subparsers.add_parser(
        "heads",
        help="Show available migration heads"
    )
    heads_parser.set_defaults(func=cmd_db_heads)
    
    # Parse arguments
    args = parser.parse_args()
    
    # If no command given, run the app
    if args.command is None:
        cmd_run(args)
    elif args.command == "db" and args.db_command is None:
        db_parser.print_help()
    elif hasattr(args, "func"):
        args.func(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()

