"""
Git integration service for NiceMeta.

Every saved query, visualization, dashboard and connection config (without
credentials) is written as files in a local git workspace and auto-committed.
The workspace can be pushed to / pulled from any remote git origin, enabling:

  - Full version history of all queries
  - Cross-instance sharing (clone the repo → import into another NiceMeta)
  - Human-readable files editable outside NiceMeta

Workspace layout
----------------
nicemeta-workspace/
├── .nicemeta.json          metadata (version, created)
├── README.md
├── .gitignore
├── queries/
│   ├── <slug>.sql          SQL text
│   └── <slug>.json         metadata  {id, name, connection, folder, ...}
├── visualizations/
│   ├── <viz-id>.py         Python visualization code (optional)
│   └── <viz-id>.json       chart config + mapping
├── dashboards/
│   └── <slug>.json         dashboard layout + widget refs
└── connections/
    └── <slug>.json         host/port/db/user  (NO password)
"""

from __future__ import annotations

import asyncio
import json
import re
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

# ── Constants ─────────────────────────────────────────────────────────────────

DEFAULT_WORKSPACE = Path("nicemeta-workspace")

_GITIGNORE = """\
# NiceMeta workspace
*.pyc
__pycache__/
.DS_Store
.env
*.credentials.json
"""

_README = """\
# NiceMeta Workspace

This repository contains queries, visualizations, dashboards and connection
configurations exported from a [NiceMeta](https://github.com/nicemeta/nicemeta)
instance.

## Structure

| Directory        | Contents                                   |
|------------------|--------------------------------------------|
| `queries/`       | SQL files + JSON metadata                  |
| `visualizations/`| Python visualization code + chart config   |
| `dashboards/`    | Dashboard layout JSON                      |
| `connections/`   | DB connection config (no credentials)      |

## Import into NiceMeta

Admin → Git → **Pull & Import** (if synced to a remote), or
Admin → Git → **Import from URL** to clone a fresh copy.

---
*Auto-managed by NiceMeta*
"""

_NICEMETA_JSON = {
    "version": "1.0",
    "format": "nicemeta-workspace",
}


# ── Helpers ───────────────────────────────────────────────────────────────────


def _slugify(name: str) -> str:
    slug = name.lower()
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    return slug.strip("-")[:64] or "unnamed"


def _safe_json(data: dict) -> str:
    return json.dumps(data, indent=2, default=str) + "\n"


# ── GitService ────────────────────────────────────────────────────────────────


class GitService:
    """
    Manages a git-backed workspace for NiceMeta content.

    All write operations are fire-and-forget friendly: call them with
    ``asyncio.ensure_future(git.sync_query(q))`` to avoid blocking the UI.
    """

    def __init__(self, workspace: str | Path | None = None) -> None:
        self.workspace = Path(workspace or DEFAULT_WORKSPACE).resolve()
        self.queries_dir = self.workspace / "queries"
        self.visualizations_dir = self.workspace / "visualizations"
        self.dashboards_dir = self.workspace / "dashboards"
        self.connections_dir = self.workspace / "connections"

    # ── Initialization ────────────────────────────────────────────────────────

    def initialize(self) -> tuple[bool, str]:
        """
        Create workspace directories and init git repo if needed.
        Returns (was_new_repo, message).
        """
        for d in (
            self.workspace,
            self.queries_dir,
            self.visualizations_dir,
            self.dashboards_dir,
            self.connections_dir,
        ):
            d.mkdir(parents=True, exist_ok=True)

        if (self.workspace / ".git").exists():
            return False, f"Repo already exists at {self.workspace}"

        r = self._git("init")
        if r.returncode != 0:
            return False, f"git init failed: {r.stderr}"

        self._git("config", "user.email", "nicemeta@localhost")
        self._git("config", "user.name", "NiceMeta")

        (self.workspace / ".gitignore").write_text(_GITIGNORE)
        (self.workspace / "README.md").write_text(_README)
        (self.workspace / ".nicemeta.json").write_text(
            json.dumps({**_NICEMETA_JSON, "created": datetime.now().isoformat()}, indent=2)
        )

        self._git("add", ".")
        self._git("commit", "-m", "chore: initialize NiceMeta workspace")
        return True, f"Initialized new git repo at {self.workspace}"

    def is_initialized(self) -> bool:
        return (self.workspace / ".git").exists()

    def ensure_initialized(self) -> None:
        if not self.is_initialized():
            self.initialize()

    # ── File writers ──────────────────────────────────────────────────────────

    def _query_slug(self, query: dict) -> str:
        slug = _slugify(query.get("name", "unnamed"))
        # Resolve slug collisions: if meta file exists with a different id, prefix with short id
        meta = self.queries_dir / f"{slug}.json"
        if meta.exists():
            existing = _read_json(meta)
            if existing.get("id") != query.get("id"):
                slug = f"{query['id'][:8]}-{slug}"
        return slug

    def _write_query(self, query: dict) -> list[Path]:
        slug = self._query_slug(query)
        sql_path = self.queries_dir / f"{slug}.sql"
        meta_path = self.queries_dir / f"{slug}.json"

        written: list[Path] = []
        if sql := query.get("sql"):
            sql_path.write_text(sql.rstrip() + "\n")
            written.append(sql_path)

        meta_path.write_text(_safe_json({
            "id": query.get("id", ""),
            "name": query.get("name", slug),
            "connection": query.get("connection_name") or query.get("connection_id", ""),
            "folder": query.get("folder_id") or "",
            "description": query.get("description") or "",
            "updated_at": query.get("updated_at") or datetime.now().isoformat(),
        }))
        written.append(meta_path)
        return written

    def _write_visualization(self, viz: dict) -> list[Path]:
        vid = viz.get("id", "unknown")
        written: list[Path] = []

        json_path = self.visualizations_dir / f"{vid}.json"
        json_path.write_text(_safe_json({
            "id": vid,
            "query_id": viz.get("query_id", ""),
            "name": viz.get("name", ""),
            "chart_type": viz.get("chart_type", ""),
            "renderer": viz.get("renderer", "plotly"),
            "config": viz.get("config") or {},
        }))
        written.append(json_path)

        if code := viz.get("python_code"):
            py_path = self.visualizations_dir / f"{vid}.py"
            py_path.write_text(code.rstrip() + "\n")
            written.append(py_path)

        return written

    def _write_dashboard(self, dashboard: dict) -> list[Path]:
        slug = _slugify(dashboard.get("name", "unnamed"))
        path = self.dashboards_dir / f"{slug}.json"
        if path.exists() and _read_json(path).get("id") != dashboard.get("id"):
            slug = f"{dashboard['id'][:8]}-{slug}"
            path = self.dashboards_dir / f"{slug}.json"

        path.write_text(_safe_json({
            "id": dashboard.get("id", ""),
            "name": dashboard.get("name", slug),
            "description": dashboard.get("description") or "",
            "layout_config": dashboard.get("layout_config") or {},
            "widgets": dashboard.get("widgets") or [],
            "updated_at": dashboard.get("updated_at") or datetime.now().isoformat(),
        }))
        return [path]

    def _write_connection(self, conn: dict) -> list[Path]:
        """Write connection config WITHOUT any credential fields."""
        slug = _slugify(conn.get("name", "unnamed"))
        path = self.connections_dir / f"{slug}.json"
        if path.exists() and _read_json(path).get("id") != conn.get("id"):
            slug = f"{conn['id'][:8]}-{slug}"
            path = self.connections_dir / f"{slug}.json"

        path.write_text(_safe_json({
            "id": conn.get("id", ""),
            "name": conn.get("name", slug),
            "type": conn.get("db_type") or conn.get("type", ""),
            "host": conn.get("host", ""),
            "port": conn.get("port"),
            "database": conn.get("database", ""),
            "username": conn.get("username") or conn.get("user", ""),
            # password intentionally omitted
        }))
        return [path]

    def _delete_files_by_id(self, directory: Path, item_id: str) -> None:
        for jf in directory.glob("*.json"):
            try:
                if _read_json(jf).get("id") == item_id:
                    stem = jf.stem
                    for f in directory.glob(f"{stem}.*"):
                        f.unlink(missing_ok=True)
                    return
            except Exception:
                continue

    # ── Git helpers ───────────────────────────────────────────────────────────

    def _git(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["git", *args],
            cwd=self.workspace,
            capture_output=True,
            text=True,
        )

    async def _git_async(self, *args: str) -> tuple[int, str, str]:
        proc = await asyncio.create_subprocess_exec(
            "git", *args,
            cwd=str(self.workspace),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, err = await proc.communicate()
        return proc.returncode, out.decode(), err.decode()

    def _commit(self, message: str) -> bool:
        self._git("add", ".")
        if not self._git("status", "--porcelain").stdout.strip():
            return False  # nothing to commit
        return self._git("commit", "-m", message).returncode == 0

    # ── Sync public API ───────────────────────────────────────────────────────

    async def sync_query(self, query: dict, deleted: bool = False) -> None:
        """Write (or remove) a query's files and commit. Safe to fire-and-forget."""
        try:
            self.ensure_initialized()
            if deleted:
                self._delete_files_by_id(self.queries_dir, query.get("id", ""))
                msg = f"remove query: {query.get('name', 'unknown')}"
            else:
                self._write_query(query)
                msg = f"save query: {query.get('name', 'unknown')}"
            self._commit(msg)
        except Exception as exc:
            print(f"[git] sync_query error: {exc}")

    async def sync_visualization(self, viz: dict) -> None:
        try:
            self.ensure_initialized()
            self._write_visualization(viz)
            self._commit(f"save visualization: {viz.get('name', viz.get('id', ''))}")
        except Exception as exc:
            print(f"[git] sync_visualization error: {exc}")

    async def sync_dashboard(self, dashboard: dict, deleted: bool = False) -> None:
        try:
            self.ensure_initialized()
            if deleted:
                self._delete_files_by_id(self.dashboards_dir, dashboard.get("id", ""))
                msg = f"remove dashboard: {dashboard.get('name', 'unknown')}"
            else:
                self._write_dashboard(dashboard)
                msg = f"save dashboard: {dashboard.get('name', 'unknown')}"
            self._commit(msg)
        except Exception as exc:
            print(f"[git] sync_dashboard error: {exc}")

    async def sync_connection(self, conn: dict) -> None:
        try:
            self.ensure_initialized()
            self._write_connection(conn)
            self._commit(f"save connection: {conn.get('name', 'unknown')}")
        except Exception as exc:
            print(f"[git] sync_connection error: {exc}")

    async def sync_all(self) -> str:
        """Full export: write every DB object to files and commit."""
        from nicemeta.services.query_service import get_saved_queries
        from nicemeta.services.dashboard_service import get_dashboards
        from nicemeta.services.connection_service import get_connections
        from nicemeta.services.visualization_service import get_visualization_by_query_id

        self.ensure_initialized()

        queries = await get_saved_queries()
        for q in queries:
            self._write_query(q)
            viz = await get_visualization_by_query_id(q["id"])
            if viz:
                self._write_visualization(viz)

        dashboards = await get_dashboards()
        for d in dashboards:
            self._write_dashboard(d)

        connections = await get_connections()
        for c in connections:
            self._write_connection(c)

        committed = self._commit(
            f"sync: {len(queries)} queries, {len(dashboards)} dashboards, "
            f"{len(connections)} connections"
        )
        return (
            f"Synced {len(queries)} queries, {len(dashboards)} dashboards, "
            f"{len(connections)} connections" + (" — committed" if committed else " — nothing changed")
        )

    # ── Remote operations ─────────────────────────────────────────────────────

    async def set_remote(self, url: str) -> tuple[bool, str]:
        self.ensure_initialized()
        rc, _, _ = await self._git_async("remote", "get-url", "origin")
        if rc == 0:
            rc, out, err = await self._git_async("remote", "set-url", "origin", url)
        else:
            rc, out, err = await self._git_async("remote", "add", "origin", url)
        if rc == 0:
            return True, f"Remote set to: {url}"
        return False, err.strip()

    async def push(self, branch: str = "") -> tuple[bool, str]:
        self.ensure_initialized()
        branch = branch or self.get_current_branch()
        rc, out, err = await self._git_async("push", "-u", "origin", branch)
        return rc == 0, (out + err).strip()

    async def fetch(self) -> tuple[bool, str]:
        self.ensure_initialized()
        rc, out, err = await self._git_async("fetch", "origin")
        return rc == 0, (out + err).strip()

    async def pull(self) -> tuple[bool, str]:
        """Pull from remote then import any new/changed files into the DB."""
        self.ensure_initialized()
        rc, out, err = await self._git_async("pull", "--rebase", "origin",
                                              self.get_current_branch())
        if rc != 0:
            rc, out, err = await self._git_async("pull", "origin",
                                                  self.get_current_branch())
        if rc != 0:
            return False, (out + err).strip()

        summary = await self.import_from_workspace()
        return True, f"Pulled OK\n{summary}"

    # ── Import (files → DB) ───────────────────────────────────────────────────

    async def import_from_workspace(self) -> str:
        """Read workspace files and upsert into the NiceMeta DB."""
        from nicemeta.services.query_service import save_query as db_save_query
        from nicemeta.services.connection_service import get_connections

        counts: dict[str, int] = {"queries": 0, "dashboards": 0, "errors": 0}

        # Build connection lookup (id or name → id)
        conns = await get_connections()
        conn_lookup: dict[str, str] = {}
        for c in conns:
            conn_lookup[c["id"]] = c["id"]
            conn_lookup[c["name"]] = c["id"]

        # Import queries
        for meta_file in sorted(self.queries_dir.glob("*.json")):
            try:
                meta = _read_json(meta_file)
                stem = meta_file.stem
                sql_file = self.queries_dir / f"{stem}.sql"
                sql = sql_file.read_text() if sql_file.exists() else ""

                connection_ref = meta.get("connection", "")
                connection_id = conn_lookup.get(connection_ref, connection_ref)

                await db_save_query(
                    name=meta.get("name", stem),
                    sql=sql,
                    connection_id=connection_id,
                    folder_id=meta.get("folder") or None,
                    query_id=meta.get("id") or None,
                )
                counts["queries"] += 1
            except Exception as exc:
                counts["errors"] += 1
                print(f"[git] import query {meta_file.name}: {exc}")

        # Import dashboards (metadata only — widgets require separate wiring)
        for dash_file in sorted(self.dashboards_dir.glob("*.json")):
            try:
                from nicemeta.services.dashboard_service import get_dashboard_by_id, create_dashboard as db_create_dashboard
                data = _read_json(dash_file)
                existing = await get_dashboard_by_id(data.get("id", ""))
                if not existing:
                    await db_create_dashboard(
                        name=data.get("name", dash_file.stem),
                        description=data.get("description") or "",
                    )
                counts["dashboards"] += 1
            except Exception as exc:
                counts["errors"] += 1
                print(f"[git] import dashboard {dash_file.name}: {exc}")

        return (
            f"Imported {counts['queries']} queries, {counts['dashboards']} dashboards"
            + (f" ({counts['errors']} errors)" if counts["errors"] else "")
        )

    async def clone_and_import(self, url: str) -> tuple[bool, str]:
        """Clone a remote repo, copy files into workspace, import to DB."""
        import shutil
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            proc = await asyncio.create_subprocess_exec(
                "git", "clone", "--depth=1", url, tmp,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, err = await proc.communicate()
            if proc.returncode != 0:
                return False, f"Clone failed: {err.decode()}"

            self.ensure_initialized()

            # Copy content dirs from clone into workspace (merge)
            for subdir in ("queries", "visualizations", "dashboards", "connections"):
                src = Path(tmp) / subdir
                dst = getattr(self, f"{subdir}_dir")
                if src.exists():
                    shutil.copytree(src, dst, dirs_exist_ok=True)

            await self.set_remote(url)
            summary = await self.import_from_workspace()
            self._commit("import: cloned from remote repository")
            return True, f"Cloned {url}\n{summary}"

    # ── Status & introspection ────────────────────────────────────────────────

    def get_status(self) -> str:
        if not self.is_initialized():
            return "No git repository. Use 'Initialize' to create one."
        return self._git("status").stdout

    def get_log(self, limit: int = 30) -> list[dict]:
        if not self.is_initialized():
            return []
        r = self._git("log", f"-{limit}", "--pretty=format:%h|%s|%an|%ar")
        commits = []
        for line in r.stdout.strip().splitlines():
            parts = line.split("|", 3)
            if len(parts) >= 4:
                commits.append({
                    "hash": parts[0],
                    "message": parts[1],
                    "author": parts[2],
                    "when": parts[3],
                })
        return commits

    def get_remote(self) -> str:
        if not self.is_initialized():
            return ""
        r = self._git("remote", "get-url", "origin")
        return r.stdout.strip() if r.returncode == 0 else ""

    def get_current_branch(self) -> str:
        r = self._git("branch", "--show-current")
        return r.stdout.strip() or "main"

    def get_short_status(self) -> str:
        """One-line summary for UI display."""
        if not self.is_initialized():
            return "Not initialized"
        branch = self.get_current_branch()
        porcelain = self._git("status", "--porcelain").stdout.strip()
        dirty = f" · {len(porcelain.splitlines())} change(s)" if porcelain else " · clean"
        remote = self.get_remote()
        remote_label = f" → {remote.split('/')[-1].removesuffix('.git')}" if remote else " (local only)"
        return f"branch: {branch}{dirty}{remote_label}"


# ── Singleton ─────────────────────────────────────────────────────────────────

_instance: GitService | None = None


def get_git_service() -> GitService:
    """Return the server-wide GitService singleton."""
    global _instance
    if _instance is None:
        try:
            from nicegui import app as _app
            workspace = _app.storage.general.get("git_workspace_path",
                                                  str(DEFAULT_WORKSPACE))
        except Exception:
            workspace = str(DEFAULT_WORKSPACE)
        _instance = GitService(workspace)
    return _instance


def reset_git_service(workspace: str | None = None) -> GitService:
    """Re-create the singleton (call after changing workspace path)."""
    global _instance
    _instance = GitService(workspace or str(DEFAULT_WORKSPACE))
    return _instance


# ── Utility ───────────────────────────────────────────────────────────────────

def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}
