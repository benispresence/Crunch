/**
 * Pipeline storage + execution + scheduler.
 *
 * Each pipeline is a Python script (auto-generated from a form or
 * fully custom) that ingests data into one of the user's saved
 * connections. The script runs in the python engine's sandbox and
 * gets a ``ctx`` object exposing the destination's decrypted
 * credentials, so user code doesn't have to handle secrets.
 *
 * A small in-process ticker scans `pipelines` every 30s and fires any
 * pipeline whose cron expression has a match inside the window
 * between the previous tick and now (``fireBetween`` below). The
 * ticker holds an in-memory set of running pipeline ids so a slow
 * run can't fire twice while still executing.
 *
 * Runs are persisted to ``pipeline_runs`` so the UI can show history
 * and the user can read logs from failed runs without SSH.
 */

import cronParser from "cron-parser";
import { db } from "../db/index.js";
import { decryptConnectionConfig } from "./crypto.js";
import { pythonEngine } from "./pythonEngine.js";

export type LoadMode = "replace" | "append" | "merge" | "incremental" | "streaming";
export type SourceType = "rest_api" | "sql" | "file" | "kafka" | "custom";
export type CodeMode = "template" | "custom";

export interface PipelineRow {
  id: number;
  user_id: number;
  folder_id: number | null;
  name: string;
  description: string | null;
  source_type: SourceType;
  source_config_json: string;
  destination_connection_id: number | null;
  destination_dataset: string | null;
  load_mode: LoadMode;
  primary_key: string | null;
  cursor_field: string | null;
  python_code: string;
  code_mode: CodeMode;
  schedule: string | null;
  schedule_enabled: number;
  stream_max_seconds: number;
  stream_max_messages: number;
  last_run_id: number | null;
  last_run_status: string | null;
  last_run_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface PipelineRunRow {
  id: number;
  pipeline_id: number;
  status: "pending" | "running" | "success" | "failed" | "cancelled";
  started_at: number;
  finished_at: number | null;
  rows_loaded: number | null;
  log: string;
  error_message: string | null;
  triggered_by: "manual" | "schedule" | "agent";
}

interface ConnectionRow {
  id: number;
  type: string;
  config_json: string;
  name: string;
}

export function rowToPipeline(row: PipelineRow) {
  return {
    id: row.id,
    folder_id: row.folder_id,
    name: row.name,
    description: row.description,
    source_type: row.source_type,
    source_config: safeJson(row.source_config_json),
    destination_connection_id: row.destination_connection_id,
    destination_dataset: row.destination_dataset,
    load_mode: row.load_mode,
    primary_key: row.primary_key,
    cursor_field: row.cursor_field,
    python_code: row.python_code,
    code_mode: row.code_mode,
    schedule: row.schedule,
    schedule_enabled: !!row.schedule_enabled,
    stream_max_seconds: row.stream_max_seconds,
    stream_max_messages: row.stream_max_messages,
    last_run_id: row.last_run_id,
    last_run_status: row.last_run_status,
    last_run_at: row.last_run_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function safeJson(s: string | null): Record<string, unknown> {
  if (!s) return {};
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}

/** Validate a cron expression. Returns the next run's epoch seconds
 *  on success; throws otherwise (with a user-friendly message). */
export function nextRun(schedule: string, after: Date = new Date()): number {
  const it = cronParser.parseExpression(schedule, { currentDate: after });
  return Math.floor(it.next().toDate().getTime() / 1000);
}

/** Truthy when the cron expression has *any* match inside the
 *  (closed, open] window between ``prev`` and ``now``. We use this
 *  rather than "next match equals now" so a 30s scheduler tick can't
 *  miss a minute-precision cron firing. */
function fireBetween(schedule: string, prev: Date, now: Date): boolean {
  try {
    const it = cronParser.parseExpression(schedule, {
      currentDate: prev,
      endDate: now,
    });
    while (true) {
      const n = it.next();
      const t = n.toDate().getTime();
      if (t > now.getTime()) return false;
      if (t > prev.getTime()) return true;
    }
  } catch {
    return false;
  }
}

/** Resolve a pipeline's destination connection to a decrypted
 *  `{type, host, port, database, user, password, options}` object,
 *  ready to hand to the python engine. */
function resolveDestination(pipeline: PipelineRow, userId: number) {
  if (pipeline.destination_connection_id == null) {
    throw new Error("Pipeline has no destination connection.");
  }
  const conn = db
    .prepare(
      "SELECT id, type, config_json, name FROM connections WHERE id = ? AND user_id = ?",
    )
    .get(pipeline.destination_connection_id, userId) as ConnectionRow | undefined;
  if (!conn) throw new Error("Destination connection not found.");
  const decrypted = decryptConnectionConfig(JSON.parse(conn.config_json)) as Record<string, unknown>;
  return { type: conn.type, name: conn.name, ...decrypted };
}

/** Pre-flight: build a ``spec`` that the python template generator
 *  understands. Resolves the destination connection name/type so the
 *  generator can pick the right dlt destination. */
export function buildTemplateSpec(pipeline: PipelineRow, userId: number): Record<string, unknown> {
  const dest = pipeline.destination_connection_id == null ? {} : (() => {
    try {
      const r = resolveDestination(pipeline, userId);
      return {
        name: r.name,
        type: r.type,
        dataset: pipeline.destination_dataset,
        // We intentionally don't pass credentials to the *template* —
        // the user's source code shouldn't bake host/password values
        // in. Runtime credentials reach the script via `ctx`.
      };
    } catch {
      return { dataset: pipeline.destination_dataset };
    }
  })();
  return {
    name: pipeline.name,
    description: pipeline.description,
    source_type: pipeline.source_type,
    source_config: safeJson(pipeline.source_config_json),
    destination: dest,
    load_mode: pipeline.load_mode,
    primary_key: pipeline.primary_key,
    cursor_field: pipeline.cursor_field,
  };
}

/**
 * Run a single pipeline now. Creates a ``pipeline_runs`` row, calls
 * the python engine, captures the result, updates denormalised
 * last-run fields on the pipeline. Returns the finished run.
 */
export async function runPipeline(
  pipelineId: number,
  userId: number,
  triggeredBy: PipelineRunRow["triggered_by"] = "manual",
): Promise<PipelineRunRow> {
  const pipeline = db
    .prepare("SELECT * FROM pipelines WHERE id = ? AND user_id = ?")
    .get(pipelineId, userId) as PipelineRow | undefined;
  if (!pipeline) throw new Error("pipeline not found");

  const runInfo = db
    .prepare(
      `INSERT INTO pipeline_runs (pipeline_id, status, triggered_by)
       VALUES (?, 'running', ?)`,
    )
    .run(pipelineId, triggeredBy);
  const runId = Number(runInfo.lastInsertRowid);

  let status: PipelineRunRow["status"] = "failed";
  let log = "";
  let rowsLoaded: number | null = null;
  let errorMessage: string | null = null;
  try {
    const dest = resolveDestination(pipeline, userId);
    const r = await pythonEngine.runPipeline({
      code: pipeline.python_code,
      destination: dest as unknown as Record<string, unknown>,
      stream_max_seconds: pipeline.stream_max_seconds,
      stream_max_messages: pipeline.stream_max_messages,
    });
    log = r.log ?? "";
    rowsLoaded = r.rows_loaded;
    if (r.success) {
      status = "success";
    } else {
      status = "failed";
      errorMessage = r.error ?? "unknown error";
    }
  } catch (e) {
    status = "failed";
    errorMessage = (e as Error).message;
  }

  db.prepare(
    `UPDATE pipeline_runs SET
       status = ?, finished_at = strftime('%s', 'now'),
       rows_loaded = ?, log = ?, error_message = ?
     WHERE id = ?`,
  ).run(status, rowsLoaded, log, errorMessage, runId);
  db.prepare(
    `UPDATE pipelines SET
       last_run_id = ?, last_run_status = ?,
       last_run_at = strftime('%s', 'now')
     WHERE id = ?`,
  ).run(runId, status, pipelineId);

  return db
    .prepare("SELECT * FROM pipeline_runs WHERE id = ?")
    .get(runId) as PipelineRunRow;
}

// ---------- Scheduler ----------------------------------------------

interface SchedulerState {
  intervalHandle: NodeJS.Timeout | null;
  lastTickAt: number;
  inFlight: Set<number>;        // pipeline ids currently running
  maxConcurrent: number;
}

const state: SchedulerState = {
  intervalHandle: null,
  lastTickAt: Math.floor(Date.now() / 1000),
  inFlight: new Set(),
  maxConcurrent: 4,
};

export function setSchedulerConcurrency(n: number): void {
  state.maxConcurrent = Math.max(1, Math.min(16, n));
}

export function getSchedulerStatus(): {
  running: boolean;
  in_flight_pipeline_ids: number[];
  last_tick_at: number;
  max_concurrent: number;
} {
  return {
    running: state.intervalHandle != null,
    in_flight_pipeline_ids: [...state.inFlight],
    last_tick_at: state.lastTickAt,
    max_concurrent: state.maxConcurrent,
  };
}

/** Start the cron-style ticker. Idempotent. */
export function startScheduler(intervalMs = 30_000): void {
  if (state.intervalHandle) return;
  state.intervalHandle = setInterval(() => {
    void tickScheduler();
  }, intervalMs);
  // Kick once immediately so a freshly-saved due pipeline doesn't
  // wait the full interval.
  void tickScheduler();
  console.log(`[scheduler] started, polling every ${intervalMs / 1000}s`);
}

export function stopScheduler(): void {
  if (state.intervalHandle) {
    clearInterval(state.intervalHandle);
    state.intervalHandle = null;
  }
}

async function tickScheduler(): Promise<void> {
  const now = new Date();
  const prev = new Date(state.lastTickAt * 1000);
  state.lastTickAt = Math.floor(now.getTime() / 1000);

  const due = db
    .prepare(
      `SELECT id, user_id, schedule FROM pipelines
       WHERE schedule_enabled = 1 AND schedule IS NOT NULL AND schedule != ''`,
    )
    .all() as Array<{ id: number; user_id: number; schedule: string }>;

  for (const row of due) {
    if (state.inFlight.size >= state.maxConcurrent) break;
    if (state.inFlight.has(row.id)) continue;
    if (!fireBetween(row.schedule, prev, now)) continue;

    state.inFlight.add(row.id);
    runPipeline(row.id, row.user_id, "schedule")
      .catch((e) => {
        console.warn(`[scheduler] pipeline ${row.id} failed: ${(e as Error).message}`);
      })
      .finally(() => {
        state.inFlight.delete(row.id);
      });
  }
}
