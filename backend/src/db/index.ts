import Database from "better-sqlite3";
import { config } from "../config.js";

export const db = new Database(config.databaseFile);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer',
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );

  CREATE TABLE IF NOT EXISTS connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    config_json TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );

  CREATE TABLE IF NOT EXISTS queries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    connection_id INTEGER REFERENCES connections(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    sql TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    messages_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );

  CREATE TABLE IF NOT EXISTS visualizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    connection_id INTEGER REFERENCES connections(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    sql TEXT NOT NULL,
    chart_type TEXT NOT NULL DEFAULT 'bar',
    renderer TEXT NOT NULL DEFAULT 'plotly',
    config_json TEXT NOT NULL DEFAULT '{}',
    python_code TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );

  CREATE TABLE IF NOT EXISTS dashboards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    layout_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );

  CREATE TABLE IF NOT EXISTS dashboard_widgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dashboard_id INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
    visualization_id INTEGER REFERENCES visualizations(id) ON DELETE CASCADE,
    position_x INTEGER NOT NULL DEFAULT 0,
    position_y INTEGER NOT NULL DEFAULT 0,
    width INTEGER NOT NULL DEFAULT 6,
    height INTEGER NOT NULL DEFAULT 4,
    title_override TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );

  CREATE TABLE IF NOT EXISTS allowed_packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    package_name TEXT UNIQUE NOT NULL,
    import_name TEXT,
    version_spec TEXT,
    installed_version TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );

  CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );
`);

// Idempotent column add (older DBs).
function ensureColumn(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.find((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn("users", "role", "role TEXT NOT NULL DEFAULT 'viewer'");
ensureColumn("queries", "folder_id", "folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL");
ensureColumn("visualizations", "folder_id", "folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL");
ensureColumn("dashboards", "folder_id", "folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL");
// Chart settings live on the query itself — one chart per saved query, so
// the sidebar can render the chart automatically when the query is opened.
ensureColumn("queries", "chart_type", "chart_type TEXT NOT NULL DEFAULT 'bar'");
ensureColumn("queries", "chart_renderer", "chart_renderer TEXT NOT NULL DEFAULT 'plotly'");
ensureColumn("queries", "chart_config_json", "chart_config_json TEXT NOT NULL DEFAULT '{}'");
ensureColumn("queries", "chart_python_code", "chart_python_code TEXT");
ensureColumn("queries", "chart_mode", "chart_mode TEXT NOT NULL DEFAULT 'picker'");
// Dashboard widgets can target either a (legacy) visualization or a saved
// query. New ones use query_id; visualization_id stays for back-compat.
ensureColumn(
  "dashboard_widgets",
  "query_id",
  "query_id INTEGER REFERENCES queries(id) ON DELETE CASCADE",
);

// One-time rebuild: older databases were created with
// `visualization_id INTEGER NOT NULL`, which now blocks query-only widgets.
// SQLite can't drop a NOT NULL constraint via ALTER, so we copy through a
// fresh table when we detect the legacy schema.
{
  const cols = db.prepare("PRAGMA table_info(dashboard_widgets)").all() as Array<{
    name: string; notnull: number;
  }>;
  const vizCol = cols.find((c) => c.name === "visualization_id");
  if (vizCol && vizCol.notnull === 1) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN TRANSACTION;
      ALTER TABLE dashboard_widgets RENAME TO dashboard_widgets__old;
      CREATE TABLE dashboard_widgets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dashboard_id INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
        visualization_id INTEGER REFERENCES visualizations(id) ON DELETE CASCADE,
        query_id INTEGER REFERENCES queries(id) ON DELETE CASCADE,
        position_x INTEGER NOT NULL DEFAULT 0,
        position_y INTEGER NOT NULL DEFAULT 0,
        width INTEGER NOT NULL DEFAULT 6,
        height INTEGER NOT NULL DEFAULT 4,
        title_override TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );
      INSERT INTO dashboard_widgets
        (id, dashboard_id, visualization_id, query_id, position_x, position_y, width, height, title_override, created_at)
      SELECT id, dashboard_id, visualization_id, query_id, position_x, position_y, width, height, title_override, created_at
      FROM dashboard_widgets__old;
      DROP TABLE dashboard_widgets__old;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
    console.log("[db] migrated dashboard_widgets: visualization_id is now nullable");
  }
}

const DEFAULT_PACKAGES = [
  { name: "pandas", importName: "pandas" },
  { name: "numpy", importName: "numpy" },
  { name: "plotly", importName: "plotly" },
  { name: "matplotlib", importName: "matplotlib" },
  { name: "seaborn", importName: "seaborn" },
  { name: "scipy", importName: "scipy" },
  { name: "altair", importName: "altair" },
];

const insertPkg = db.prepare(
  "INSERT OR IGNORE INTO allowed_packages (package_name, import_name, is_default, is_enabled, status) VALUES (?, ?, 1, 1, 'installed')",
);
for (const p of DEFAULT_PACKAGES) insertPkg.run(p.name, p.importName);

// First registered user becomes admin.
const userCount = db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number };
if (userCount.c === 0) {
  // No-op now; role assignment handled in auth route on first signup.
}
