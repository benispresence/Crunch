/**
 * Pipeline tables + upgrades. Extracted so tests can install the same
 * schema on an isolated SQLite without opening the app database.
 */

import type Database from "better-sqlite3";

export function ensureColumn(
  database: Database.Database,
  table: string,
  column: string,
  ddl: string,
): void {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.find((c) => c.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

/** Minimal app tables the pipeline runtime joins against (tests). */
export function installMinimalAppSchema(database: Database.Database): void {
  database.exec(`
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
      visualization_id INTEGER,
      query_id INTEGER REFERENCES queries(id) ON DELETE CASCADE,
      position_x INTEGER NOT NULL DEFAULT 0,
      position_y INTEGER NOT NULL DEFAULT 0,
      width INTEGER NOT NULL DEFAULT 6,
      height INTEGER NOT NULL DEFAULT 4,
      title_override TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
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
  `);
  installPipelineTables(database);
}

export function installPipelineTables(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS pipelines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      description TEXT,
      source_type TEXT NOT NULL DEFAULT 'custom',
      source_config_json TEXT NOT NULL DEFAULT '{}',
      destination_connection_id INTEGER REFERENCES connections(id) ON DELETE SET NULL,
      destination_dataset TEXT,
      load_mode TEXT NOT NULL DEFAULT 'replace',
      primary_key TEXT,
      cursor_field TEXT,
      python_code TEXT NOT NULL DEFAULT '',
      code_mode TEXT NOT NULL DEFAULT 'template',
      schedule TEXT,
      schedule_enabled INTEGER NOT NULL DEFAULT 0,
      stream_max_seconds INTEGER NOT NULL DEFAULT 60,
      stream_max_messages INTEGER NOT NULL DEFAULT 10000,
      last_run_id INTEGER,
      last_run_status TEXT,
      last_run_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pipelines_user ON pipelines(user_id);
    CREATE INDEX IF NOT EXISTS idx_pipelines_schedule
      ON pipelines(schedule_enabled, schedule);

    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pipeline_id INTEGER NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      finished_at INTEGER,
      rows_loaded INTEGER,
      log TEXT NOT NULL DEFAULT '',
      error_message TEXT,
      triggered_by TEXT NOT NULL DEFAULT 'manual'
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pipeline
      ON pipeline_runs(pipeline_id, id DESC);
  `);
  upgradePipelineTables(database);
}

export function upgradePipelineTables(database: Database.Database): void {
  const upgradingLoad = !(database.prepare("PRAGMA table_info(pipelines)").all() as {name: string}[]).some(c => c.name === "extract_strategy");
  const p = (col: string, ddl: string) => ensureColumn(database, "pipelines", col, ddl);
  p("tags_json", "tags_json TEXT NOT NULL DEFAULT '[]'");
  p("timezone", "timezone TEXT NOT NULL DEFAULT 'UTC'");
  p("extract_strategy", "extract_strategy TEXT NOT NULL DEFAULT 'full'");
  p("write_behavior", "write_behavior TEXT NOT NULL DEFAULT 'replace'");
  if (upgradingLoad) database.exec(`UPDATE pipelines SET
    extract_strategy = CASE load_mode WHEN 'incremental' THEN 'incremental' WHEN 'streaming' THEN 'streaming' ELSE 'full' END,
    write_behavior = CASE load_mode WHEN 'merge' THEN 'merge' WHEN 'replace' THEN 'replace' ELSE 'append' END`);
  p("freshness_threshold_seconds", "freshness_threshold_seconds INTEGER");
  p("quality_checks_json", "quality_checks_json TEXT NOT NULL DEFAULT '[]'");
  p("source_connection_id", "source_connection_id INTEGER REFERENCES connections(id) ON DELETE SET NULL");
  p("scratch_destination_connection_id", "scratch_destination_connection_id INTEGER REFERENCES connections(id) ON DELETE SET NULL");
  p("scratch_destination_dataset", "scratch_destination_dataset TEXT");
  p("published_version_id", "published_version_id INTEGER");
  p("paused", "paused INTEGER NOT NULL DEFAULT 0");
  p("processing_interval", "processing_interval TEXT");
  p("last_successful_update", "last_successful_update INTEGER");
  // Encrypted JSON map of source_config secret refs → plaintext. Never
  // copied into versions, AI payloads, or source_config_json.
  p("source_secrets_json", "source_secrets_json TEXT NOT NULL DEFAULT ''");

  p("environment_sealed", "environment_sealed TEXT NOT NULL DEFAULT ''");

  const r = (col: string, ddl: string) => ensureColumn(database, "pipeline_runs", col, ddl);
  r("version_id", "version_id INTEGER");
  r("queued_at", "queued_at INTEGER");
  r("attempt_number", "attempt_number INTEGER NOT NULL DEFAULT 1");
  r("max_attempts", "max_attempts INTEGER NOT NULL DEFAULT 3");
  r("pid", "pid INTEGER");
  r("cancel_requested", "cancel_requested INTEGER NOT NULL DEFAULT 0");
  r("is_test", "is_test INTEGER NOT NULL DEFAULT 0");
  r("retry_of_run_id", "retry_of_run_id INTEGER");
  r("processing_interval_start", "processing_interval_start INTEGER");
  r("processing_interval_end", "processing_interval_end INTEGER");
  r("backfill_warning", "backfill_warning TEXT");
  r("check_results_json", "check_results_json TEXT NOT NULL DEFAULT '[]'");
  r("output_tables_json", "output_tables_json TEXT NOT NULL DEFAULT '[]'");
  r("steps_json", "steps_json TEXT NOT NULL DEFAULT '[]'");
  r("next_retry_at", "next_retry_at INTEGER");
  r("snapshot_json", "snapshot_json TEXT");
  r("engine_job_id", "engine_job_id TEXT");
  r("job_dir", "job_dir TEXT");

  database.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pipeline_id INTEGER NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
      version_number INTEGER NOT NULL,
      python_code TEXT NOT NULL,
      config_json TEXT NOT NULL,
      schedule TEXT,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      extract_strategy TEXT NOT NULL,
      write_behavior TEXT NOT NULL,
      quality_checks_json TEXT NOT NULL DEFAULT '[]',
      author_user_id INTEGER,
      change_summary TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      UNIQUE(pipeline_id, version_number)
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_versions_pipe
      ON pipeline_versions(pipeline_id, version_number DESC);

    CREATE TABLE IF NOT EXISTS pipeline_run_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
      attempt_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      log TEXT NOT NULL DEFAULT '',
      error_message TEXT,
      pid INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_attempts_run
      ON pipeline_run_attempts(run_id, attempt_number);

    CREATE TABLE IF NOT EXISTS pipeline_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pipeline_id INTEGER NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
      run_id INTEGER,
      version_id INTEGER,
      actor_user_id INTEGER,
      action TEXT NOT NULL,
      detail_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_activity_pipe
      ON pipeline_activity(pipeline_id, id DESC);

    CREATE TABLE IF NOT EXISTS pipeline_lineage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pipeline_id INTEGER NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
      query_id INTEGER REFERENCES queries(id) ON DELETE CASCADE,
      dashboard_id INTEGER REFERENCES dashboards(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
  `);
}
