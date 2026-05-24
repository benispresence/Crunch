"""
Package management service for the visualization sandbox.

Manages the whitelist of allowed Python packages and handles
installation/uninstallation via pip subprocess.
"""

import asyncio
import importlib.metadata
import logging
import subprocess
import sys
from datetime import datetime

from sqlalchemy import select

from crunch.core.database import get_session_context
from crunch.core.models import AllowedPackage, generate_uuid

logger = logging.getLogger(__name__)

# Default packages seeded on first run.
DEFAULT_PACKAGES = [
    {"package_name": "pandas", "import_name": "pandas"},
    {"package_name": "numpy", "import_name": "numpy"},
    {"package_name": "plotly", "import_name": "plotly"},
    {"package_name": "matplotlib", "import_name": "matplotlib"},
    {"package_name": "seaborn", "import_name": "seaborn"},
    {"package_name": "altair", "import_name": "altair"},
    {"package_name": "bokeh", "import_name": "bokeh"},
    {"package_name": "scipy", "import_name": "scipy"},
]

# Stdlib modules that don't need pip but should be importable.
STDLIB_PACKAGES = [
    {"package_name": "datetime", "import_name": "datetime"},
    {"package_name": "math", "import_name": "math"},
    {"package_name": "json", "import_name": "json"},
    {"package_name": "re", "import_name": "re"},
    {"package_name": "collections", "import_name": "collections"},
    {"package_name": "itertools", "import_name": "itertools"},
    {"package_name": "functools", "import_name": "functools"},
    {"package_name": "statistics", "import_name": "statistics"},
    {"package_name": "textwrap", "import_name": "textwrap"},
    {"package_name": "decimal", "import_name": "decimal"},
]


def _check_version(package_name: str) -> str | None:
    """Check installed version using importlib.metadata."""
    try:
        return importlib.metadata.version(package_name)
    except importlib.metadata.PackageNotFoundError:
        return None


def _is_importable(name: str) -> bool:
    """Check if a module can be imported."""
    try:
        __import__(name)
        return True
    except ImportError:
        return False


async def seed_defaults() -> None:
    """Seed default packages on first run. Idempotent."""
    async with get_session_context() as session:
        result = await session.execute(select(AllowedPackage))
        existing = {p.package_name for p in result.scalars().all()}

        for pkg_info in DEFAULT_PACKAGES:
            if pkg_info["package_name"] in existing:
                continue
            version = _check_version(pkg_info["package_name"])
            session.add(AllowedPackage(
                id=generate_uuid(),
                package_name=pkg_info["package_name"],
                import_name=pkg_info["import_name"],
                status="installed" if version else "pending",
                installed_version=version,
                is_default=True,
                is_enabled=True,
            ))

        for pkg_info in STDLIB_PACKAGES:
            if pkg_info["package_name"] in existing:
                continue
            session.add(AllowedPackage(
                id=generate_uuid(),
                package_name=pkg_info["package_name"],
                import_name=pkg_info["import_name"],
                status="installed" if _is_importable(pkg_info["import_name"]) else "pending",
                installed_version="stdlib",
                is_default=True,
                is_enabled=True,
            ))

        await session.flush()


async def list_all() -> list[dict]:
    """Return all packages sorted by name."""
    async with get_session_context() as session:
        result = await session.execute(
            select(AllowedPackage).order_by(AllowedPackage.package_name)
        )
        return [_to_dict(p) for p in result.scalars().all()]


async def get_whitelist() -> dict[str, str]:
    """
    Return {import_name: package_name} for all enabled+installed packages.
    Used by CodeExecutor for the controlled import function.
    """
    async with get_session_context() as session:
        result = await session.execute(
            select(AllowedPackage).where(
                AllowedPackage.is_enabled == True,  # noqa: E712
                AllowedPackage.status == "installed",
            )
        )
        packages = result.scalars().all()
        return {
            (p.import_name or p.package_name): p.package_name
            for p in packages
        }


async def add_package(
    package_name: str,
    import_name: str | None = None,
    version_spec: str | None = None,
    auto_install: bool = True,
) -> dict:
    """Add a package to the whitelist. Optionally trigger install."""
    async with get_session_context() as session:
        # Check if already exists
        result = await session.execute(
            select(AllowedPackage).where(AllowedPackage.package_name == package_name)
        )
        existing = result.scalar_one_or_none()
        if existing:
            return _to_dict(existing)

        pkg = AllowedPackage(
            id=generate_uuid(),
            package_name=package_name,
            import_name=import_name,
            version_spec=version_spec,
            status="pending",
            is_default=False,
            is_enabled=True,
        )
        session.add(pkg)
        await session.flush()
        pkg_dict = _to_dict(pkg)

    if auto_install:
        await install_package(pkg_dict["id"])
        # Re-read to get updated status
        async with get_session_context() as session:
            result = await session.execute(
                select(AllowedPackage).where(AllowedPackage.id == pkg_dict["id"])
            )
            updated = result.scalar_one_or_none()
            if updated:
                return _to_dict(updated)

    return pkg_dict


async def remove_package(package_id: str) -> bool:
    """Remove a non-default package."""
    async with get_session_context() as session:
        result = await session.execute(
            select(AllowedPackage).where(AllowedPackage.id == package_id)
        )
        pkg = result.scalar_one_or_none()
        if not pkg or pkg.is_default:
            return False
        await session.delete(pkg)
        await session.flush()
        return True


async def toggle_enabled(package_id: str, enabled: bool) -> dict | None:
    """Enable or disable a package."""
    async with get_session_context() as session:
        result = await session.execute(
            select(AllowedPackage).where(AllowedPackage.id == package_id)
        )
        pkg = result.scalar_one_or_none()
        if not pkg:
            return None
        pkg.is_enabled = enabled
        pkg.updated_at = datetime.utcnow()
        await session.flush()
        return _to_dict(pkg)


async def install_package(package_id: str) -> dict:
    """Install a package via pip in a background thread."""
    async with get_session_context() as session:
        result = await session.execute(
            select(AllowedPackage).where(AllowedPackage.id == package_id)
        )
        pkg = result.scalar_one_or_none()
        if not pkg:
            return {"success": False, "error": "Package not found"}

        # Stdlib packages don't need pip
        if pkg.installed_version == "stdlib":
            pkg.status = "installed"
            await session.flush()
            return {"success": True, "version": "stdlib"}

        pkg.status = "installing"
        pkg.error_message = None
        await session.flush()
        pkg_name = pkg.package_name
        version_spec = pkg.version_spec

    spec = pkg_name
    if version_spec:
        spec += version_spec

    def _run_pip():
        return subprocess.run(
            [sys.executable, "-m", "pip", "install", spec, "--quiet"],
            capture_output=True,
            text=True,
            timeout=300,
        )

    try:
        proc = await asyncio.to_thread(_run_pip)
        if proc.returncode == 0:
            version = _check_version(pkg_name)
            async with get_session_context() as session:
                result = await session.execute(
                    select(AllowedPackage).where(AllowedPackage.id == package_id)
                )
                pkg = result.scalar_one_or_none()
                if pkg:
                    pkg.status = "installed"
                    pkg.installed_version = version
                    pkg.error_message = None
                    pkg.updated_at = datetime.utcnow()
                    await session.flush()
            return {"success": True, "version": version}
        else:
            error = (proc.stderr or proc.stdout or "Unknown error")[:500]
            async with get_session_context() as session:
                result = await session.execute(
                    select(AllowedPackage).where(AllowedPackage.id == package_id)
                )
                pkg = result.scalar_one_or_none()
                if pkg:
                    pkg.status = "failed"
                    pkg.error_message = error
                    pkg.updated_at = datetime.utcnow()
                    await session.flush()
            return {"success": False, "error": error}
    except subprocess.TimeoutExpired:
        async with get_session_context() as session:
            result = await session.execute(
                select(AllowedPackage).where(AllowedPackage.id == package_id)
            )
            pkg = result.scalar_one_or_none()
            if pkg:
                pkg.status = "failed"
                pkg.error_message = "Installation timed out (300s)"
                pkg.updated_at = datetime.utcnow()
                await session.flush()
        return {"success": False, "error": "Timeout"}


async def uninstall_package(package_id: str) -> dict:
    """Uninstall a non-default package via pip."""
    async with get_session_context() as session:
        result = await session.execute(
            select(AllowedPackage).where(AllowedPackage.id == package_id)
        )
        pkg = result.scalar_one_or_none()
        if not pkg:
            return {"success": False, "error": "Package not found"}
        if pkg.is_default:
            return {"success": False, "error": "Cannot uninstall default packages"}
        pkg_name = pkg.package_name

    def _run_pip():
        return subprocess.run(
            [sys.executable, "-m", "pip", "uninstall", "-y", pkg_name, "--quiet"],
            capture_output=True,
            text=True,
            timeout=60,
        )

    try:
        proc = await asyncio.to_thread(_run_pip)
        async with get_session_context() as session:
            result = await session.execute(
                select(AllowedPackage).where(AllowedPackage.id == package_id)
            )
            pkg = result.scalar_one_or_none()
            if pkg:
                if proc.returncode == 0:
                    pkg.status = "pending"
                    pkg.installed_version = None
                else:
                    pkg.error_message = (proc.stderr or "")[:500]
                pkg.updated_at = datetime.utcnow()
                await session.flush()
        return {"success": proc.returncode == 0}
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "Timeout"}


async def update_package(package_id: str) -> dict:
    """Update a package to the latest version."""
    async with get_session_context() as session:
        result = await session.execute(
            select(AllowedPackage).where(AllowedPackage.id == package_id)
        )
        pkg = result.scalar_one_or_none()
        if not pkg:
            return {"success": False, "error": "Package not found"}
        if pkg.installed_version == "stdlib":
            return {"success": True, "version": "stdlib"}
        pkg_name = pkg.package_name
        version_spec = pkg.version_spec

    spec = pkg_name
    if version_spec:
        spec += version_spec

    def _run_pip():
        return subprocess.run(
            [sys.executable, "-m", "pip", "install", "--upgrade", spec, "--quiet"],
            capture_output=True,
            text=True,
            timeout=300,
        )

    try:
        proc = await asyncio.to_thread(_run_pip)
        if proc.returncode == 0:
            version = _check_version(pkg_name)
            async with get_session_context() as session:
                result = await session.execute(
                    select(AllowedPackage).where(AllowedPackage.id == package_id)
                )
                pkg = result.scalar_one_or_none()
                if pkg:
                    pkg.installed_version = version
                    pkg.status = "installed"
                    pkg.updated_at = datetime.utcnow()
                    await session.flush()
            return {"success": True, "version": version}
        else:
            return {"success": False, "error": (proc.stderr or "")[:500]}
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "Timeout"}


async def refresh_all_versions() -> None:
    """Scan all packages and update installed_version fields."""
    async with get_session_context() as session:
        result = await session.execute(select(AllowedPackage))
        for pkg in result.scalars().all():
            if pkg.installed_version == "stdlib":
                if _is_importable(pkg.import_name or pkg.package_name):
                    pkg.status = "installed"
                continue
            version = _check_version(pkg.package_name)
            if version:
                pkg.installed_version = version
                pkg.status = "installed"
            elif pkg.status == "installed":
                pkg.status = "pending"
                pkg.installed_version = None
        await session.flush()


def _to_dict(pkg: AllowedPackage) -> dict:
    return {
        "id": pkg.id,
        "package_name": pkg.package_name,
        "import_name": pkg.import_name,
        "version_spec": pkg.version_spec,
        "installed_version": pkg.installed_version,
        "status": pkg.status,
        "error_message": pkg.error_message,
        "is_default": pkg.is_default,
        "is_enabled": pkg.is_enabled,
        "created_at": str(pkg.created_at) if pkg.created_at else None,
        "updated_at": str(pkg.updated_at) if pkg.updated_at else None,
    }
