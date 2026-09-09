/**
 * Pipeline storage helpers + compatibility wrappers.
 *
 * Queue, versions, process execution, and overview DTOs live in
 * pipelineRuntime.ts. This module keeps row mapping, template spec
 * building, and re-exports the scheduler so existing imports continue
 * to work.
 */

import { db } from "../db/index.js";
import { decryptConnectionConfig } from "./crypto.js";
import { normalizeLoadBehavior } from "./pipelineOps.js";
import {
  enqueueRun,
  startScheduler as startRuntimeScheduler,
  stopScheduler as stopRuntimeScheduler,
  setSchedulerConcurrency as setRuntimeConcurrency,
  getSchedulerStatus as getRuntimeStatus,
  waitForRun,
} from "./pipelineRuntime.js";
import { getSetting } from "./settings.js";

export {
  nextRunEpoch as nextRun,
} from "./pipelineRuntime.js";

export type LoadMode = "replace" | "append" | "merge" | "incremental" | "streaming";
export type SourceType = "rest_api" | "sql" | "file" | "kafka" | "custom";
export type CodeMode = "template" | "custom";
export type ExtractStrategy = "full" | "incremental" | "streaming";
export type WriteBehavior = "replace" | "append" | "merge";

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
  tags_json?: string;
  timezone?: string;
  extract_strategy?: ExtractStrategy;
  write_behavior?: WriteBehavior;
  freshness_threshold_seconds?: number | null;
  quality_checks_json?: string;
  source_connection_id?: number | null;
  scratch_destination_connection_id?: number | null;
  scratch_destination_dataset?: string | null;
  published_version_id?: number | null;
  paused?: number;
  processing_interval?: string | null;
  last_successful_update?: number | null;
}

export interface PipelineRunRow {
  id: number;
  pipeline_id: number;
  status: "pending" | "queued" | "running" | "success" | "failed" | "cancelled" | "retrying";
  started_at: number;
  finished_at: number | null;
  rows_loaded: number | null;
  log: string;
  error_message: string | null;
  triggered_by: "manual" | "schedule" | "agent" | "retry" | "backfill" | "test";
  version_id?: number | null;
}

interface ConnectionRow {
  id: number;
  type: string;
  config_json: string;
  name: string;
}

export function rowToPipeline(row: PipelineRow) {
  const load = normalizeLoadBehavior({
    extract_strategy: row.extract_strategy,
    write_behavior: row.write_behavior,
    load_mode: row.load_mode,
  });
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
    extract_strategy: load.extract_strategy,
    write_behavior: load.write_behavior,
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
    tags: safeJsonArr(row.tags_json),
    timezone: row.timezone || "UTC",
    freshness_threshold_seconds: row.freshness_threshold_seconds ?? null,
    quality_checks: safeJsonArr(row.quality_checks_json),
    source_connection_id: row.source_connection_id ?? null,
    scratch_destination_connection_id: row.scratch_destination_connection_id ?? null,
    scratch_destination_dataset: row.scratch_destination_dataset ?? null,
    published_version_id: row.published_version_id ?? null,
    paused: !!row.paused || !row.schedule_enabled,
    processing_interval: row.processing_interval ?? null,
    last_successful_update: row.last_successful_update ?? null,
  };
}

function safeJsonArr(s: string | null | undefined): unknown[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function safeJson(s: string | null): Record<string, unknown> {
  if (!s) return {};
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
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
    extract_strategy: pipeline.extract_strategy,
    write_behavior: pipeline.write_behavior,
    primary_key: pipeline.primary_key,
    cursor_field: pipeline.cursor_field,
  };
}

/**
 * Enqueue a run on the persisted shared queue. Returns the queued row
 * immediately; pass ``wait`` to block until a terminal status.
 */
export async function runPipeline(
  pipelineId: number,
  userId: number,
  triggeredBy: PipelineRunRow["triggered_by"] = "manual",
  opts: { wait?: boolean } = {},
): Promise<PipelineRunRow> {
  const trigger =
    triggeredBy === "agent" || triggeredBy === "schedule" || triggeredBy === "manual"
      ? triggeredBy
      : "manual";
  const queued = enqueueRun(db, {
    pipelineId,
    userId,
    trigger,
  });
  trimRunHistory(pipelineId);
  if (opts.wait) {
    return (await waitForRun(db, Number(queued.id))) as unknown as PipelineRunRow;
  }
  return queued as unknown as PipelineRunRow;
}

/** Default number of runs to keep per pipeline before older rows are
 *  pruned. The admin can override via the ``pipeline_run_retention``
 *  setting; anything outside [1, 10_000] falls back to the default. */
const DEFAULT_RUN_RETENTION = 100;

export function getRunRetention(): number {
  const raw = (getSetting("pipeline_run_retention") || "").trim();
  if (!raw) return DEFAULT_RUN_RETENTION;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 10_000) return DEFAULT_RUN_RETENTION;
  return n;
}

/** Delete pipeline_runs for one pipeline beyond the configured cap.
 *  Keeps the newest N by id, deletes the rest. Safe to call on every
 *  insert — bounded work since we only ever exceed by one row. */
export function trimRunHistory(pipelineId: number): number {
  const keep = getRunRetention();
  const r = db
    .prepare(
      `DELETE FROM pipeline_runs
       WHERE pipeline_id = ?
       AND id NOT IN (
         SELECT id FROM pipeline_runs
         WHERE pipeline_id = ?
         ORDER BY id DESC LIMIT ?
       )`,
    )
    .run(pipelineId, pipelineId, keep);
  return r.changes;
}

export function setSchedulerConcurrency(n: number): void {
  setRuntimeConcurrency(n);
}

export function getSchedulerStatus() {
  return getRuntimeStatus();
}

export function startScheduler(intervalMs = 30_000): void {
  startRuntimeScheduler(db, intervalMs);
}

export function stopScheduler(): void {
  stopRuntimeScheduler();
}
