/**
 * Version history for queries and dashboards.
 *
 * Every meaningful save snapshots the full state into a `*_revisions`
 * row. The UI surfaces this history and lets the user revert with one
 * click; revert creates a NEW revision with `source='revert'`, so the
 * timeline is monotonic and matches the git history that mirrors it.
 *
 * Two snapshots of the same state are deduped via a content hash —
 * hitting Save with no real change doesn't pollute the timeline.
 *
 * If the user's workspace is git-initialized, each snapshot also kicks
 * off a `git add -A && git commit` so the same history exists on disk
 * and can be pushed to a remote. Commits are serialised through one
 * promise chain to avoid races between concurrent saves; failures are
 * logged but never block the in-app save.
 */

import { createHash } from "node:crypto";
import { config } from "../config.js";
import { db } from "../db/index.js";
import {
  commitAll,
  isInitialized as gitIsInitialized,
} from "./gitOps.js";
import { exportToWorkspace } from "./workspaceSync.js";

export type RevisionSource = "save" | "revert" | "agent" | "import";

export interface QuerySnapshot {
  name: string;
  sql: string;
  chart_type: string;
  chart_renderer: string;
  chart_config_json: string;
  chart_python_code: string | null;
  chart_mode: string;
  parameters_json: string;
}

export interface DashboardWidgetSnapshot {
  query_id: number | null;
  visualization_id: number | null;
  position_x: number;
  position_y: number;
  width: number;
  height: number;
  title_override: string | null;
  parameter_mappings: Record<string, string>;
}

export interface DashboardSnapshot {
  name: string;
  description: string | null;
  layout_json: string;
  filters_json: string;
  widgets: DashboardWidgetSnapshot[];
}

export interface RevisionRow {
  id: number;
  source: RevisionSource;
  source_revision_id: number | null;
  message: string | null;
  git_sha: string | null;
  created_at: number;
}

function hashState(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

function loadQuerySnapshotById(queryId: number, userId: number): QuerySnapshot | null {
  const row = db
    .prepare(
      `SELECT name, sql, chart_type, chart_renderer, chart_config_json,
              chart_python_code, chart_mode, parameters_json
       FROM queries WHERE id = ? AND user_id = ?`,
    )
    .get(queryId, userId) as QuerySnapshot | undefined;
  return row ?? null;
}

function loadDashboardSnapshotById(
  dashboardId: number,
  userId: number,
): DashboardSnapshot | null {
  const dash = db
    .prepare(
      `SELECT name, description, layout_json, filters_json
       FROM dashboards WHERE id = ? AND user_id = ?`,
    )
    .get(dashboardId, userId) as
    | { name: string; description: string | null; layout_json: string; filters_json: string }
    | undefined;
  if (!dash) return null;
  const widgets = db
    .prepare(
      `SELECT query_id, visualization_id, position_x, position_y, width, height,
              title_override, parameter_mappings_json
       FROM dashboard_widgets WHERE dashboard_id = ?
       ORDER BY id`,
    )
    .all(dashboardId) as Array<{
      query_id: number | null;
      visualization_id: number | null;
      position_x: number;
      position_y: number;
      width: number;
      height: number;
      title_override: string | null;
      parameter_mappings_json: string;
    }>;
  return {
    name: dash.name,
    description: dash.description,
    layout_json: dash.layout_json,
    filters_json: dash.filters_json,
    widgets: widgets.map((w) => ({
      query_id: w.query_id,
      visualization_id: w.visualization_id,
      position_x: w.position_x,
      position_y: w.position_y,
      width: w.width,
      height: w.height,
      title_override: w.title_override,
      parameter_mappings: parseMapping(w.parameter_mappings_json),
    })),
  };
}

function parseMapping(raw: string): Record<string, string> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

// Serialise git commits across the whole process. The git workspace is
// shared across users, so concurrent commits would interleave and
// occasionally fail with "index.lock exists". Chaining promises is
// dumb-simple and avoids pulling in a real mutex library.
let gitChain: Promise<string | null> = Promise.resolve(null);

async function commitToGit(userId: number, message: string): Promise<string | null> {
  const next = gitChain.then(async () => {
    try {
      if (!(await gitIsInitialized(config.workspaceDir))) return null;
      // Materialize the user's workspace first so the commit captures
      // the same state that's in the DB. The exporter is idempotent and
      // cheap for a single-user repo.
      await exportToWorkspace(userId, config.workspaceDir);
      const r = await commitAll(config.workspaceDir, message);
      if (!r.committed) return null;
      return r.sha;
    } catch (err) {
      console.warn("[versioning] git commit failed:", (err as Error).message);
      return null;
    }
  });
  // Always advance the chain to a resolved Promise so one failure
  // doesn't poison every subsequent save.
  gitChain = next.then(
    (v) => v,
    () => null,
  );
  return next;
}

export interface SnapshotOpts {
  source?: RevisionSource;
  message?: string;
  sourceRevisionId?: number | null;
}

/**
 * Capture the current state of a query as a new revision row. Returns
 * the inserted revision (or the existing latest one if the snapshot is
 * identical, so callers can rely on a non-null return for navigation).
 */
export async function snapshotQuery(
  queryId: number,
  userId: number,
  opts: SnapshotOpts = {},
): Promise<RevisionRow | null> {
  const snap = loadQuerySnapshotById(queryId, userId);
  if (!snap) return null;
  const hash = hashState(snap);

  const prior = db
    .prepare(
      `SELECT id, source, source_revision_id, message, git_sha, created_at, snapshot_hash
       FROM query_revisions WHERE query_id = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(queryId) as (RevisionRow & { snapshot_hash: string }) | undefined;
  if (prior && prior.snapshot_hash === hash && (opts.source ?? "save") === "save") {
    // No meaningful change — keep the timeline tidy.
    return {
      id: prior.id,
      source: prior.source,
      source_revision_id: prior.source_revision_id,
      message: prior.message,
      git_sha: prior.git_sha,
      created_at: prior.created_at,
    };
  }

  const info = db
    .prepare(
      `INSERT INTO query_revisions (
         query_id, user_id, name, sql, chart_type, chart_renderer, chart_config_json,
         chart_python_code, chart_mode, parameters_json, snapshot_hash,
         source, source_revision_id, message
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      queryId,
      userId,
      snap.name,
      snap.sql,
      snap.chart_type,
      snap.chart_renderer,
      snap.chart_config_json,
      snap.chart_python_code,
      snap.chart_mode,
      snap.parameters_json,
      hash,
      opts.source ?? "save",
      opts.sourceRevisionId ?? null,
      opts.message ?? null,
    );
  const id = Number(info.lastInsertRowid);

  const sha = await commitToGit(
    userId,
    opts.message ?? `query "${snap.name}" — ${opts.source ?? "save"}`,
  );
  if (sha) {
    db.prepare("UPDATE query_revisions SET git_sha = ? WHERE id = ?").run(sha, id);
  }

  return {
    id,
    source: opts.source ?? "save",
    source_revision_id: opts.sourceRevisionId ?? null,
    message: opts.message ?? null,
    git_sha: sha,
    created_at: Math.floor(Date.now() / 1000),
  };
}

export async function snapshotDashboard(
  dashboardId: number,
  userId: number,
  opts: SnapshotOpts = {},
): Promise<RevisionRow | null> {
  const snap = loadDashboardSnapshotById(dashboardId, userId);
  if (!snap) return null;
  const hash = hashState(snap);

  const prior = db
    .prepare(
      `SELECT id, source, source_revision_id, message, git_sha, created_at, snapshot_hash
       FROM dashboard_revisions WHERE dashboard_id = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(dashboardId) as (RevisionRow & { snapshot_hash: string }) | undefined;
  if (prior && prior.snapshot_hash === hash && (opts.source ?? "save") === "save") {
    return {
      id: prior.id,
      source: prior.source,
      source_revision_id: prior.source_revision_id,
      message: prior.message,
      git_sha: prior.git_sha,
      created_at: prior.created_at,
    };
  }

  const info = db
    .prepare(
      `INSERT INTO dashboard_revisions (
         dashboard_id, user_id, name, description, layout_json, filters_json, widgets_json,
         snapshot_hash, source, source_revision_id, message
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      dashboardId,
      userId,
      snap.name,
      snap.description,
      snap.layout_json,
      snap.filters_json,
      JSON.stringify(snap.widgets),
      hash,
      opts.source ?? "save",
      opts.sourceRevisionId ?? null,
      opts.message ?? null,
    );
  const id = Number(info.lastInsertRowid);

  const sha = await commitToGit(
    userId,
    opts.message ?? `dashboard "${snap.name}" — ${opts.source ?? "save"}`,
  );
  if (sha) {
    db.prepare("UPDATE dashboard_revisions SET git_sha = ? WHERE id = ?").run(sha, id);
  }

  return {
    id,
    source: opts.source ?? "save",
    source_revision_id: opts.sourceRevisionId ?? null,
    message: opts.message ?? null,
    git_sha: sha,
    created_at: Math.floor(Date.now() / 1000),
  };
}

export interface QueryRevisionWithSnapshot extends RevisionRow {
  snapshot: QuerySnapshot;
}

export interface DashboardRevisionWithSnapshot extends RevisionRow {
  snapshot: DashboardSnapshot;
}

export function listQueryRevisions(
  queryId: number,
  userId: number,
  limit = 100,
): RevisionRow[] {
  return db
    .prepare(
      `SELECT id, source, source_revision_id, message, git_sha, created_at
       FROM query_revisions WHERE query_id = ? AND user_id = ?
       ORDER BY id DESC LIMIT ?`,
    )
    .all(queryId, userId, limit) as RevisionRow[];
}

export function getQueryRevision(
  queryId: number,
  revisionId: number,
  userId: number,
): QueryRevisionWithSnapshot | null {
  const row = db
    .prepare(
      `SELECT id, name, sql, chart_type, chart_renderer, chart_config_json,
              chart_python_code, chart_mode, parameters_json,
              source, source_revision_id, message, git_sha, created_at
       FROM query_revisions WHERE id = ? AND query_id = ? AND user_id = ?`,
    )
    .get(revisionId, queryId, userId) as (RevisionRow & QuerySnapshot) | undefined;
  if (!row) return null;
  const {
    id, name, sql, chart_type, chart_renderer, chart_config_json,
    chart_python_code, chart_mode, parameters_json,
    source, source_revision_id, message, git_sha, created_at,
  } = row;
  return {
    id,
    source: source as RevisionSource,
    source_revision_id,
    message,
    git_sha,
    created_at,
    snapshot: {
      name, sql, chart_type, chart_renderer, chart_config_json,
      chart_python_code, chart_mode, parameters_json,
    },
  };
}

export function listDashboardRevisions(
  dashboardId: number,
  userId: number,
  limit = 100,
): RevisionRow[] {
  return db
    .prepare(
      `SELECT id, source, source_revision_id, message, git_sha, created_at
       FROM dashboard_revisions WHERE dashboard_id = ? AND user_id = ?
       ORDER BY id DESC LIMIT ?`,
    )
    .all(dashboardId, userId, limit) as RevisionRow[];
}

export function getDashboardRevision(
  dashboardId: number,
  revisionId: number,
  userId: number,
): DashboardRevisionWithSnapshot | null {
  const row = db
    .prepare(
      `SELECT id, name, description, layout_json, filters_json, widgets_json,
              source, source_revision_id, message, git_sha, created_at
       FROM dashboard_revisions WHERE id = ? AND dashboard_id = ? AND user_id = ?`,
    )
    .get(revisionId, dashboardId, userId) as
    | (RevisionRow & {
        name: string;
        description: string | null;
        layout_json: string;
        filters_json: string;
        widgets_json: string;
      })
    | undefined;
  if (!row) return null;
  let widgets: DashboardWidgetSnapshot[] = [];
  try {
    const parsed = JSON.parse(row.widgets_json);
    if (Array.isArray(parsed)) widgets = parsed as DashboardWidgetSnapshot[];
  } catch {
    /* keep empty */
  }
  return {
    id: row.id,
    source: row.source as RevisionSource,
    source_revision_id: row.source_revision_id,
    message: row.message,
    git_sha: row.git_sha,
    created_at: row.created_at,
    snapshot: {
      name: row.name,
      description: row.description,
      layout_json: row.layout_json,
      filters_json: row.filters_json,
      widgets,
    },
  };
}

/**
 * Restore the query state to the named revision. Stamps a new revision
 * on top so the timeline is monotonic and a revert can itself be
 * reverted.
 */
export async function revertQuery(
  queryId: number,
  revisionId: number,
  userId: number,
): Promise<RevisionRow | null> {
  const rev = getQueryRevision(queryId, revisionId, userId);
  if (!rev) return null;
  const s = rev.snapshot;
  const r = db
    .prepare(
      `UPDATE queries SET
         name = ?, sql = ?, chart_type = ?, chart_renderer = ?,
         chart_config_json = ?, chart_python_code = ?, chart_mode = ?,
         parameters_json = ?, updated_at = strftime('%s', 'now')
       WHERE id = ? AND user_id = ?`,
    )
    .run(
      s.name, s.sql, s.chart_type, s.chart_renderer,
      s.chart_config_json, s.chart_python_code, s.chart_mode,
      s.parameters_json, queryId, userId,
    );
  if (r.changes === 0) return null;
  return snapshotQuery(queryId, userId, {
    source: "revert",
    sourceRevisionId: revisionId,
    message: `revert to revision #${revisionId}`,
  });
}

export async function revertDashboard(
  dashboardId: number,
  revisionId: number,
  userId: number,
): Promise<RevisionRow | null> {
  const rev = getDashboardRevision(dashboardId, revisionId, userId);
  if (!rev) return null;
  const s = rev.snapshot;
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE dashboards SET
         name = ?, description = ?, layout_json = ?, filters_json = ?,
         updated_at = strftime('%s', 'now')
       WHERE id = ? AND user_id = ?`,
    ).run(s.name, s.description, s.layout_json, s.filters_json, dashboardId, userId);

    // Widget identity isn't preserved across reverts (positions and
    // mappings are what users care about — reusing widget ids would
    // also conflict with the ON DELETE CASCADE on the queries table).
    // Nuke + rebuild from the snapshot.
    db.prepare("DELETE FROM dashboard_widgets WHERE dashboard_id = ?").run(dashboardId);
    const insert = db.prepare(
      `INSERT INTO dashboard_widgets
         (dashboard_id, query_id, visualization_id, position_x, position_y,
          width, height, title_override, parameter_mappings_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const w of s.widgets) {
      // Skip widgets whose underlying source has since been deleted.
      if (w.query_id != null) {
        const exists = db
          .prepare("SELECT id FROM queries WHERE id = ? AND user_id = ?")
          .get(w.query_id, userId);
        if (!exists) continue;
      }
      if (w.visualization_id != null) {
        const exists = db
          .prepare("SELECT id FROM visualizations WHERE id = ? AND user_id = ?")
          .get(w.visualization_id, userId);
        if (!exists) continue;
      }
      insert.run(
        dashboardId,
        w.query_id,
        w.visualization_id,
        w.position_x,
        w.position_y,
        w.width,
        w.height,
        w.title_override,
        JSON.stringify(w.parameter_mappings ?? {}),
      );
    }
  });
  tx();

  return snapshotDashboard(dashboardId, userId, {
    source: "revert",
    sourceRevisionId: revisionId,
    message: `revert to revision #${revisionId}`,
  });
}
