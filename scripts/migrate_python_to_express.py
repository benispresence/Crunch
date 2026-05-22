"""
Migrate connections + queries from the legacy Python/NiceGUI SQLite
database (nicemeta.db, SQLAlchemy-shaped) into the new TypeScript/Express
SQLite database (backend/nicemeta.sqlite, better-sqlite3-shaped).

Run AFTER the Express backend has started at least once (so its schema
and the seeded admin user exist).

Usage:
    python scripts/migrate_python_to_express.py \
        [--source nicemeta.db] \
        [--target backend/nicemeta.sqlite] \
        [--user-id 1] \
        [--dry-run]

What gets copied:
- connections (skipping any whose `name` already exists for the target user)
- queries     (re-pointed to the matching new connection by name)

What does NOT get copied:
- dashboards / visualizations / dashboard widgets (different shapes; the
  new stack stores layouts/configs differently — re-create from the UI)
- folders, agent_conversations
- users (the new stack seeds an admin on first launch)
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

# Old db_type → new type. Backend zod enum is
# ["postgres","mysql","sqlite","sqlserver","file"]; the legacy DB used
# "postgresql" everywhere else.
TYPE_MAP = {
    "postgresql": "postgres",
    "postgres": "postgres",
    "mysql": "mysql",
    "sqlite": "sqlite",
    "sqlserver": "sqlserver",
    "file": "file",
}


def parse_options(raw: object) -> dict:
    if not raw:
        return {}
    if isinstance(raw, dict):
        return raw
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return {}


def build_config(row: sqlite3.Row) -> dict:
    options = parse_options(row["options"])
    cfg: dict = {"database": row["database"] or ""}
    if (row["db_type"] or "").lower() not in {"sqlite", "file"}:
        cfg["host"] = row["host"] or "localhost"
        cfg["port"] = int(row["port"]) if row["port"] is not None else 0
        cfg["user"] = row["username"] or ""
        cfg["password"] = row["password"] or ""
    if options:
        cfg["options"] = options
    return cfg


def migrate(source: Path, target: Path, user_id: int, dry_run: bool) -> None:
    if not source.exists():
        sys.exit(f"source not found: {source}")
    if not target.exists():
        sys.exit(
            f"target not found: {target}\n"
            "Start the Express backend once so the schema is created."
        )

    src = sqlite3.connect(source)
    src.row_factory = sqlite3.Row
    dst = sqlite3.connect(target)
    dst.execute("PRAGMA foreign_keys = ON")

    # Verify target user exists.
    user = dst.execute("SELECT id, email FROM users WHERE id = ?", (user_id,)).fetchone()
    if user is None:
        sys.exit(
            f"user_id={user_id} does not exist in {target}.\n"
            "Sign in to the Express app once so the default admin (id=1) is created."
        )
    print(f"Target user: id={user[0]} email={user[1]}")

    # ---- connections ----
    src_conns = list(src.execute("SELECT * FROM connections WHERE is_active IN (1, NULL, '')"))
    print(f"\n{len(src_conns)} active connection(s) in source")

    existing_names = {
        row[0]
        for row in dst.execute(
            "SELECT name FROM connections WHERE user_id = ?", (user_id,)
        )
    }

    # Map from OLD connection UUID → NEW connection int id (so we can
    # re-point queries afterward).
    id_map: dict[str, int] = {}
    inserted = skipped = 0

    for row in src_conns:
        old_id = row["id"]
        name = row["name"]
        old_type = (row["db_type"] or "").lower()
        new_type = TYPE_MAP.get(old_type)
        if new_type is None:
            print(f"  SKIP {name!r}: unknown db_type {old_type!r}")
            continue
        if name in existing_names:
            existing = dst.execute(
                "SELECT id FROM connections WHERE user_id = ? AND name = ?",
                (user_id, name),
            ).fetchone()
            id_map[old_id] = int(existing[0])
            print(f"  SKIP {name!r}: already exists (id={existing[0]})")
            skipped += 1
            continue

        cfg = build_config(row)
        if dry_run:
            print(f"  WOULD ADD {name!r} ({new_type})")
            inserted += 1
            continue
        cur = dst.execute(
            "INSERT INTO connections (user_id, name, type, config_json) VALUES (?, ?, ?, ?)",
            (user_id, name, new_type, json.dumps(cfg)),
        )
        id_map[old_id] = int(cur.lastrowid)
        existing_names.add(name)
        print(f"  ADDED {name!r} ({new_type}) -> id={cur.lastrowid}")
        inserted += 1

    # ---- queries ----
    src_queries = list(
        src.execute(
            "SELECT * FROM queries WHERE sql IS NOT NULL AND sql != '' "
            "AND query_type IN ('sql', 'SQL', NULL, '')"
        )
    )
    print(f"\n{len(src_queries)} sql-bearing query(ies) in source")

    existing_qnames = {
        row[0]
        for row in dst.execute(
            "SELECT name FROM queries WHERE user_id = ?", (user_id,)
        )
    }
    q_inserted = q_skipped = q_orphaned = 0

    for row in src_queries:
        name = row["name"]
        old_conn_id = row["connection_id"]
        new_conn_id = id_map.get(old_conn_id)
        if old_conn_id and new_conn_id is None:
            print(f"  ORPHAN query {name!r}: source connection {old_conn_id} not migrated")
            q_orphaned += 1
            continue
        if name in existing_qnames:
            print(f"  SKIP query {name!r}: already exists")
            q_skipped += 1
            continue
        if dry_run:
            print(f"  WOULD ADD query {name!r} (conn={new_conn_id})")
            q_inserted += 1
            continue
        dst.execute(
            "INSERT INTO queries (user_id, connection_id, name, sql) VALUES (?, ?, ?, ?)",
            (user_id, new_conn_id, name, row["sql"]),
        )
        existing_qnames.add(name)
        print(f"  ADDED query {name!r} (conn={new_conn_id})")
        q_inserted += 1

    if dry_run:
        print("\n[dry-run] no rows written")
    else:
        dst.commit()
        print("\nCommitted.")
    print(
        f"Connections: {inserted} added, {skipped} skipped\n"
        f"Queries:     {q_inserted} added, {q_skipped} skipped, {q_orphaned} orphaned"
    )


def main() -> None:
    here = Path(__file__).resolve().parent.parent
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--source", type=Path, default=here / "crunch.db")
    p.add_argument("--target", type=Path, default=here / "backend" / "crunch.sqlite")
    p.add_argument("--user-id", type=int, default=1)
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()
    migrate(args.source, args.target, args.user_id, args.dry_run)


if __name__ == "__main__":
    main()
