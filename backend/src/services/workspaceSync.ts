/**
 * DB <-> file mirror for the NiceMeta workspace.
 *
 * Layout produced under config.workspaceDir:
 *
 *   queries/
 *     <folder-path>/<query-name>.sql       (SQL body)
 *     <folder-path>/<query-name>.meta.json (connection name, folder path)
 *   visualizations/
 *     <folder-path>/<viz-name>.json        (chart_type, renderer, config, sql)
 *     <folder-path>/<viz-name>.py          (only if python_code is set)
 *   dashboards/
 *     <folder-path>/<dashboard-name>.json  (description, layout, widget refs)
 *
 * The folder hierarchy follows the user's `folders` table, with the
 * top three categories (queries/, visualizations/, dashboards/) as the
 * forced top-level groupings. The mirror is one-way (DB → files) for
 * `exportToWorkspace`; `importFromWorkspace` reads the same layout
 * back into the DB and is intended for a freshly cloned repo.
 *
 * Item names are slugified for the filesystem; the canonical name
 * lives in the .meta.json sidecar (or the SQL header) so renames
 * round-trip safely.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { db } from "../db/index.js";

interface FolderRow {
  id: number;
  parent_id: number | null;
  name: string;
}
interface QueryRow {
  id: number;
  name: string;
  sql: string;
  folder_id: number | null;
  connection_id: number | null;
}
interface VizRow {
  id: number;
  name: string;
  sql: string;
  chart_type: string;
  renderer: string;
  config_json: string;
  python_code: string | null;
  folder_id: number | null;
  connection_id: number | null;
}
interface DashRow {
  id: number;
  name: string;
  description: string | null;
  layout_json: string;
  folder_id: number | null;
}
interface ConnRow {
  id: number;
  name: string;
}

function slug(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[^\w\s.-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 80) || "untitled";
}

function buildFolderPath(folderId: number | null, byId: Map<number, FolderRow>): string[] {
  if (folderId == null) return [];
  const out: string[] = [];
  let cur: FolderRow | undefined = byId.get(folderId);
  const seen = new Set<number>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(slug(cur.name));
    cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined;
  }
  return out;
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

async function writeFile(p: string, body: string): Promise<void> {
  await ensureDir(path.dirname(p));
  await fs.writeFile(p, body, "utf8");
}

async function rmrf(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true });
}

export interface ExportSummary {
  workspaceDir: string;
  queries: number;
  visualizations: number;
  dashboards: number;
}

/**
 * Materialize the user's workspace into config.workspaceDir.
 * Wipes the three top-level folders first to keep the tree tidy.
 */
export async function exportToWorkspace(
  userId: number,
  workspaceDir: string,
): Promise<ExportSummary> {
  await ensureDir(workspaceDir);

  // Reset content folders (preserve .git, README, etc.).
  for (const sub of ["queries", "visualizations", "dashboards"]) {
    await rmrf(path.join(workspaceDir, sub));
  }

  const folders = db
    .prepare("SELECT id, parent_id, name FROM folders WHERE user_id = ?")
    .all(userId) as FolderRow[];
  const byFolderId = new Map<number, FolderRow>();
  for (const f of folders) byFolderId.set(f.id, f);

  const conns = db
    .prepare("SELECT id, name FROM connections WHERE user_id = ?")
    .all(userId) as ConnRow[];
  const connNameById = new Map<number, string>();
  for (const c of conns) connNameById.set(c.id, c.name);

  // Queries
  const queries = db
    .prepare(
      "SELECT id, name, sql, folder_id, connection_id FROM queries WHERE user_id = ?",
    )
    .all(userId) as QueryRow[];
  for (const q of queries) {
    const dir = path.join(
      workspaceDir,
      "queries",
      ...buildFolderPath(q.folder_id, byFolderId),
    );
    const stem = slug(q.name);
    const meta = {
      name: q.name,
      connection: q.connection_id != null ? connNameById.get(q.connection_id) ?? null : null,
      folder_path: buildFolderPath(q.folder_id, byFolderId).join("/") || null,
    };
    await writeFile(path.join(dir, `${stem}.sql`), q.sql);
    await writeFile(
      path.join(dir, `${stem}.meta.json`),
      `${JSON.stringify(meta, null, 2)}\n`,
    );
  }

  // Visualizations
  const vizes = db
    .prepare(
      "SELECT id, name, sql, chart_type, renderer, config_json, python_code, folder_id, connection_id FROM visualizations WHERE user_id = ?",
    )
    .all(userId) as VizRow[];
  for (const v of vizes) {
    const dir = path.join(
      workspaceDir,
      "visualizations",
      ...buildFolderPath(v.folder_id, byFolderId),
    );
    const stem = slug(v.name);
    const body = {
      name: v.name,
      connection: v.connection_id != null ? connNameById.get(v.connection_id) ?? null : null,
      folder_path: buildFolderPath(v.folder_id, byFolderId).join("/") || null,
      chart_type: v.chart_type,
      renderer: v.renderer,
      config: JSON.parse(v.config_json),
      sql: v.sql,
      has_python: v.python_code != null,
    };
    await writeFile(path.join(dir, `${stem}.json`), `${JSON.stringify(body, null, 2)}\n`);
    if (v.python_code) {
      await writeFile(path.join(dir, `${stem}.py`), v.python_code);
    }
  }

  // Dashboards
  const dashes = db
    .prepare(
      "SELECT id, name, description, layout_json, folder_id FROM dashboards WHERE user_id = ?",
    )
    .all(userId) as DashRow[];
  for (const d of dashes) {
    const dir = path.join(
      workspaceDir,
      "dashboards",
      ...buildFolderPath(d.folder_id, byFolderId),
    );
    const widgets = db
      .prepare(
        "SELECT w.id, w.position_x, w.position_y, w.width, w.height, w.title_override, v.name AS viz_name FROM dashboard_widgets w JOIN visualizations v ON v.id = w.visualization_id WHERE w.dashboard_id = ?",
      )
      .all(d.id);
    const body = {
      name: d.name,
      description: d.description,
      folder_path: buildFolderPath(d.folder_id, byFolderId).join("/") || null,
      layout: JSON.parse(d.layout_json),
      widgets,
    };
    const stem = slug(d.name);
    await writeFile(path.join(dir, `${stem}.json`), `${JSON.stringify(body, null, 2)}\n`);
  }

  // README so a freshly cloned repo is self-explanatory.
  const readme = `# NiceMeta workspace

This directory mirrors your saved queries, visualizations and dashboards
from the NiceMeta app. It's safe to commit and share.

- \`queries/<collection>/<name>.sql\` — SQL body. Sidecar
  \`<name>.meta.json\` records the connection it was last bound to.
- \`visualizations/<collection>/<name>.json\` — chart type, renderer,
  config and SQL. \`<name>.py\` (if present) is the sandboxed Python
  visualization code.
- \`dashboards/<collection>/<name>.json\` — description, layout, and
  the visualizations referenced by each widget (by name).

Push this repo to GitHub to back up your collections, or clone it
into another NiceMeta instance and run *Import* from the admin Git
panel to restore.
`;
  await writeFile(path.join(workspaceDir, "README.md"), readme);

  return {
    workspaceDir,
    queries: queries.length,
    visualizations: vizes.length,
    dashboards: dashes.length,
  };
}

interface FileScan<T> {
  filePath: string;
  folderSegments: string[];
  payload: T;
}

async function walkJson<T>(
  root: string,
  onFile: (entry: FileScan<T>) => Promise<void> | void,
): Promise<void> {
  const exists = await fs
    .stat(root)
    .then(() => true)
    .catch(() => false);
  if (!exists) return;
  async function visit(dir: string, segs: string[]): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await visit(full, [...segs, e.name]);
      } else if (e.isFile() && e.name.endsWith(".json") && !e.name.endsWith(".meta.json")) {
        const text = await fs.readFile(full, "utf8");
        let payload: T;
        try {
          payload = JSON.parse(text) as T;
        } catch {
          continue;
        }
        await onFile({ filePath: full, folderSegments: segs, payload });
      }
    }
  }
  await visit(root, []);
}

export interface ImportSummary {
  folders: number;
  queries: number;
  visualizations: number;
  dashboards: number;
  skipped: number;
}

/**
 * Read the workspace directory back into the DB for the given user.
 * Idempotent — items keyed by (folder_path, name) on the same user are
 * skipped if already present.
 */
export async function importFromWorkspace(
  userId: number,
  workspaceDir: string,
): Promise<ImportSummary> {
  const folderIdByPath = new Map<string, number>();
  let folderCount = 0;

  function ensureFolderChain(segs: string[]): number | null {
    if (segs.length === 0) return null;
    const key = segs.join("/");
    const cached = folderIdByPath.get(key);
    if (cached != null) return cached;
    let parentId: number | null = null;
    for (let i = 0; i < segs.length; i++) {
      const partKey = segs.slice(0, i + 1).join("/");
      let id = folderIdByPath.get(partKey);
      if (id == null) {
        const existing = db
          .prepare(
            "SELECT id FROM folders WHERE user_id = ? AND name = ? AND ((parent_id IS NULL AND ? IS NULL) OR parent_id = ?)",
          )
          .get(userId, segs[i], parentId, parentId) as { id: number } | undefined;
        if (existing) {
          id = existing.id;
        } else {
          const r = db
            .prepare("INSERT INTO folders (user_id, parent_id, name) VALUES (?, ?, ?)")
            .run(userId, parentId, segs[i]);
          id = Number(r.lastInsertRowid);
          folderCount++;
        }
        folderIdByPath.set(partKey, id);
      }
      parentId = id;
    }
    return parentId;
  }

  // Connections by name (so queries/viz can be re-bound)
  const connByName = new Map<string, number>();
  for (const c of db
    .prepare("SELECT id, name FROM connections WHERE user_id = ?")
    .all(userId) as ConnRow[]) {
    connByName.set(c.name, c.id);
  }

  let queryCount = 0;
  let vizCount = 0;
  let dashCount = 0;
  let skipped = 0;

  // Queries — read .meta.json + paired .sql
  const queriesRoot = path.join(workspaceDir, "queries");
  if (
    await fs
      .stat(queriesRoot)
      .then(() => true)
      .catch(() => false)
  ) {
    async function visitQ(dir: string, segs: string[]): Promise<void> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          await visitQ(full, [...segs, e.name]);
        } else if (e.isFile() && e.name.endsWith(".meta.json")) {
          const stem = e.name.slice(0, -".meta.json".length);
          const sqlPath = path.join(dir, `${stem}.sql`);
          const metaText = await fs.readFile(full, "utf8");
          let meta: { name?: string; connection?: string | null };
          try {
            meta = JSON.parse(metaText);
          } catch {
            continue;
          }
          let sql = "";
          try {
            sql = await fs.readFile(sqlPath, "utf8");
          } catch {
            continue;
          }
          const folderId = ensureFolderChain(segs);
          const name = meta.name ?? stem;
          const existing = db
            .prepare(
              "SELECT id FROM queries WHERE user_id = ? AND name = ? AND ((folder_id IS NULL AND ? IS NULL) OR folder_id = ?)",
            )
            .get(userId, name, folderId, folderId);
          if (existing) {
            skipped++;
            continue;
          }
          const connId = meta.connection ? connByName.get(meta.connection) ?? null : null;
          db.prepare(
            "INSERT INTO queries (user_id, connection_id, folder_id, name, sql) VALUES (?, ?, ?, ?, ?)",
          ).run(userId, connId, folderId, name, sql);
          queryCount++;
        }
      }
    }
    await visitQ(queriesRoot, []);
  }

  // Visualizations
  await walkJson<{
    name?: string;
    connection?: string | null;
    chart_type?: string;
    renderer?: string;
    config?: Record<string, unknown>;
    sql?: string;
    has_python?: boolean;
  }>(path.join(workspaceDir, "visualizations"), async ({ filePath, folderSegments, payload }) => {
    if (!payload.name || !payload.sql || !payload.chart_type) return;
    const folderId = ensureFolderChain(folderSegments);
    const existing = db
      .prepare(
        "SELECT id FROM visualizations WHERE user_id = ? AND name = ? AND ((folder_id IS NULL AND ? IS NULL) OR folder_id = ?)",
      )
      .get(userId, payload.name, folderId, folderId);
    if (existing) {
      skipped++;
      return;
    }
    let pyCode: string | null = null;
    if (payload.has_python) {
      const pyPath = filePath.replace(/\.json$/, ".py");
      pyCode = await fs.readFile(pyPath, "utf8").catch(() => null);
    }
    const connId = payload.connection ? connByName.get(payload.connection) ?? null : null;
    db.prepare(
      "INSERT INTO visualizations (user_id, connection_id, folder_id, name, sql, chart_type, renderer, config_json, python_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      userId,
      connId,
      folderId,
      payload.name,
      payload.sql,
      payload.chart_type,
      payload.renderer ?? "plotly",
      JSON.stringify(payload.config ?? {}),
      pyCode,
    );
    vizCount++;
  });

  // Dashboards (widgets are restored without ids — they re-bind by viz name).
  await walkJson<{
    name?: string;
    description?: string | null;
    layout?: Record<string, unknown>;
    widgets?: Array<{
      viz_name?: string;
      position_x?: number;
      position_y?: number;
      width?: number;
      height?: number;
      title_override?: string | null;
    }>;
  }>(path.join(workspaceDir, "dashboards"), async ({ folderSegments, payload }) => {
    if (!payload.name) return;
    const folderId = ensureFolderChain(folderSegments);
    const existing = db
      .prepare(
        "SELECT id FROM dashboards WHERE user_id = ? AND name = ? AND ((folder_id IS NULL AND ? IS NULL) OR folder_id = ?)",
      )
      .get(userId, payload.name, folderId, folderId);
    if (existing) {
      skipped++;
      return;
    }
    const r = db
      .prepare(
        "INSERT INTO dashboards (user_id, name, description, folder_id, layout_json) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        userId,
        payload.name,
        payload.description ?? null,
        folderId,
        JSON.stringify(payload.layout ?? {}),
      );
    const dashId = Number(r.lastInsertRowid);
    for (const w of payload.widgets ?? []) {
      if (!w.viz_name) continue;
      const viz = db
        .prepare("SELECT id FROM visualizations WHERE user_id = ? AND name = ?")
        .get(userId, w.viz_name) as { id: number } | undefined;
      if (!viz) continue;
      db.prepare(
        "INSERT INTO dashboard_widgets (dashboard_id, visualization_id, position_x, position_y, width, height, title_override) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        dashId,
        viz.id,
        w.position_x ?? 0,
        w.position_y ?? 0,
        w.width ?? 6,
        w.height ?? 4,
        w.title_override ?? null,
      );
    }
    dashCount++;
  });

  return {
    folders: folderCount,
    queries: queryCount,
    visualizations: vizCount,
    dashboards: dashCount,
    skipped,
  };
}
