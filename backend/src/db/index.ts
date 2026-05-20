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
ensureColumn("users", "must_change_password", "must_change_password INTEGER NOT NULL DEFAULT 0");
ensureColumn("users", "token_version", "token_version INTEGER NOT NULL DEFAULT 0");
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
// Metabase-style query parameters. JSON array of
// {name, display_name, type, default, required, widget}. The same
// shape is used for {{var}} substitution and to drive the UI inputs.
ensureColumn("queries", "parameters_json", "parameters_json TEXT NOT NULL DEFAULT '[]'");
// Dashboard-level filters, plus a per-widget mapping so one filter
// can drive multiple charts. ``filters_json`` is an array of filter
// definitions (id, name, type, default, …); each widget keeps a
// {dashboard_filter_id: query_param_name} object.
ensureColumn("dashboards", "filters_json", "filters_json TEXT NOT NULL DEFAULT '[]'");
// Dashboard widgets can target either a (legacy) visualization or a saved
// query. New ones use query_id; visualization_id stays for back-compat.
ensureColumn(
  "dashboard_widgets",
  "query_id",
  "query_id INTEGER REFERENCES queries(id) ON DELETE CASCADE",
);
ensureColumn(
  "dashboard_widgets",
  "parameter_mappings_json",
  "parameter_mappings_json TEXT NOT NULL DEFAULT '{}'",
);

// Version history: every meaningful save of a query or a dashboard
// snapshots its full state into a *_revisions row. The UI surfaces
// these and lets the user revert with one click; reverts themselves
// are new revisions on top (never history rewrites) so the trail is
// monotonic and matches the git history we mirror alongside it.
db.exec(`
  CREATE TABLE IF NOT EXISTS query_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query_id INTEGER NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sql TEXT NOT NULL,
    chart_type TEXT NOT NULL DEFAULT 'bar',
    chart_renderer TEXT NOT NULL DEFAULT 'plotly',
    chart_config_json TEXT NOT NULL DEFAULT '{}',
    chart_python_code TEXT,
    chart_mode TEXT NOT NULL DEFAULT 'picker',
    parameters_json TEXT NOT NULL DEFAULT '[]',
    snapshot_hash TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'save',
    source_revision_id INTEGER REFERENCES query_revisions(id) ON DELETE SET NULL,
    message TEXT,
    git_sha TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_query_revisions_query
    ON query_revisions(query_id, id DESC);

  CREATE TABLE IF NOT EXISTS dashboard_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dashboard_id INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    layout_json TEXT NOT NULL DEFAULT '{}',
    filters_json TEXT NOT NULL DEFAULT '[]',
    widgets_json TEXT NOT NULL DEFAULT '[]',
    snapshot_hash TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'save',
    source_revision_id INTEGER REFERENCES dashboard_revisions(id) ON DELETE SET NULL,
    message TEXT,
    git_sha TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_dashboard_revisions_dash
    ON dashboard_revisions(dashboard_id, id DESC);

  -- Auth provider definitions: one row per configured SSO/LDAP/SAML
  -- entry. Config lives in JSON so each kind keeps its own fields
  -- without schema migrations every time we add a knob.
  CREATE TABLE IF NOT EXISTS auth_providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,                  -- 'oidc' | 'saml' | 'ldap'
    name TEXT NOT NULL,                  -- shown on the login button
    is_enabled INTEGER NOT NULL DEFAULT 1,
    default_role TEXT NOT NULL DEFAULT 'viewer',
    config_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );

  -- API keys are long-lived bearer tokens issued to users for
  -- programmatic access. We store a hash of the secret, never the
  -- plaintext — the API only returns the plaintext at creation time.
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,                -- first 12 chars of the plaintext, for display
    key_hash TEXT NOT NULL,              -- sha256(secret)
    last_used_at INTEGER,
    expires_at INTEGER,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
  CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
`);

// Track the external identity behind an SSO-provisioned user so we
// can re-bind safely (same external_id always returns the same Crunch
// user even if the email changes downstream).
ensureColumn(
  "users",
  "auth_provider_id",
  "auth_provider_id INTEGER REFERENCES auth_providers(id) ON DELETE SET NULL",
);
ensureColumn("users", "external_id", "external_id TEXT");

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
