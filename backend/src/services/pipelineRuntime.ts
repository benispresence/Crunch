/**
 * Persisted pipeline queue, versions, overview DTOs, and execution.
 *
 * All SQLite I/O for the operational pipeline model lives here. Pure
 * classifiers stay in pipelineOps.ts; process spawn/kill in
 * pipelineProcess.ts. Callers (routes, scheduler, tests) pass a
 * better-sqlite3 Database so tests can use an isolated file.
 */

import type Database from "better-sqlite3";
import cronParser from "cron-parser";
import { decryptConnectionConfig, decryptString, encryptString, isEncrypted, SECRET_MASK } from "./crypto.js";
import {
  admitRun,
  buildBackfillPlan,
  buildOverviewCounts,
  buildOverviewEntry,
  buildSqlAlchemyUrl,
  buildVersionSnapshot,
  canResumeFromFailedStep,
  classifyRetryKind,
  computeRetryBackoffMs,
  detectLineage,
  diffCode,
  diffConfigs,
  evaluateQualityChecks,
  explainFailure,
  extractAndReplaceSecrets,
  flattenOutputRows,
  normalizeLoadBehavior,
  payloadContainsSecretValues,
  payloadHasSecretRefs,
  recoverRunsOnRestart,
  resolveSecretReferences,
  schemaInspectSql,
  shouldRetry,
  stripSecretsFromConfig,
  validatePipelineConfig,
  type AttentionBucket,
  type CheckResult,
  type ExtractStrategy,
  type OverviewPipeline,
  type QualityCheck,
  type RunStatus,
  type RunTrigger,
  type VersionSnapshot,
  type WriteBehavior,
} from "./pipelineOps.js";
import {
  cleanupJobDir,
  isPidAlive,
  killPid,
  readJobResult,
  spawnPipelineProcess,
  waitForChild,
  type SpawnedPipeline,
} from "./pipelineProcess.js";
import { pythonEngine } from "./pythonEngine.js";

export interface EnqueueRequest {
  pipelineId: number;
  userId: number;
  trigger: RunTrigger;
  versionId?: number | null;
  isTest?: boolean;
  retryOfRunId?: number | null;
  processingIntervalStart?: number | null;
  processingIntervalEnd?: number | null;
  backfillWarning?: string | null;
  confirmBackfill?: boolean;
}

const liveChildren = new Map<number, SpawnedPipeline>();
const workerState = {
  handle: null as NodeJS.Timeout | null,
  inFlight: new Set<number>(),
  maxConcurrent: 4,
  lastTickAt: Math.floor(Date.now() / 1000),
  database: null as Database.Database | null,
};

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function setSchedulerConcurrency(n: number): void {
  workerState.maxConcurrent = Math.max(1, Math.min(16, n));
}

export function getSchedulerStatus(): {
  running: boolean;
  in_flight_pipeline_ids: number[];
  last_tick_at: number;
  max_concurrent: number;
} {
  return {
    running: workerState.handle != null,
    in_flight_pipeline_ids: [...workerState.inFlight],
    last_tick_at: workerState.lastTickAt,
    max_concurrent: workerState.maxConcurrent,
  };
}

export function recordActivity(
  database: Database.Database,
  input: {
    pipelineId: number;
    action: string;
    actorUserId?: number | null;
    runId?: number | null;
    versionId?: number | null;
    detail?: Record<string, unknown>;
  },
): void {
  database
    .prepare(
      `INSERT INTO pipeline_activity
         (pipeline_id, run_id, version_id, actor_user_id, action, detail_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.pipelineId,
      input.runId ?? null,
      input.versionId ?? null,
      input.actorUserId ?? null,
      input.action,
      JSON.stringify(input.detail ?? {}),
    );
}

export function listActivity(database: Database.Database, pipelineId: number) {
  return database
    .prepare(
      `SELECT id, pipeline_id, run_id, version_id, actor_user_id, action,
              detail_json, created_at
       FROM pipeline_activity WHERE pipeline_id = ? ORDER BY id DESC LIMIT 100`,
    )
    .all(pipelineId)
    .map((row) => {
      const r = row as Record<string, unknown>;
      return { ...r, detail: parseJson(String(r.detail_json ?? "{}"), {}) };
    });
}

export function getPipelineRow(database: Database.Database, id: number, userId: number) {
  return database
    .prepare("SELECT * FROM pipelines WHERE id = ? AND user_id = ?")
    .get(id, userId) as Record<string, unknown> | undefined;
}

function latestVersionNumber(database: Database.Database, pipelineId: number): number {
  const row = database
    .prepare("SELECT MAX(version_number) AS n FROM pipeline_versions WHERE pipeline_id = ?")
    .get(pipelineId) as { n: number | null };
  return row.n ?? 0;
}

function pipelineConfigObject(row: Record<string, unknown>): Record<string, unknown> {
  return {
    name: row.name,
    description: row.description,
    source_type: row.source_type,
    source_config: parseJson(String(row.source_config_json ?? "{}"), {}),
    source_connection_id: row.source_connection_id ?? null,
    destination_connection_id: row.destination_connection_id ?? null,
    destination_dataset: row.destination_dataset ?? null,
    load_mode: row.load_mode,
    extract_strategy: row.extract_strategy,
    write_behavior: row.write_behavior,
    primary_key: row.primary_key,
    cursor_field: row.cursor_field,
    schedule: row.schedule,
    timezone: row.timezone ?? "UTC",
    quality_checks: parseJson(String(row.quality_checks_json ?? "[]"), []),
    tags: parseJson(String(row.tags_json ?? "[]"), []),
    stream_max_seconds: row.stream_max_seconds,
    stream_max_messages: row.stream_max_messages,
    scratch_destination_connection_id: row.scratch_destination_connection_id ?? null,
    scratch_destination_dataset: row.scratch_destination_dataset ?? null,
    processing_interval: row.processing_interval ?? null,
    freshness_threshold_seconds: row.freshness_threshold_seconds ?? null,
    code_mode: row.code_mode,
  };
}

export function publishVersion(
  database: Database.Database,
  pipelineId: number,
  userId: number,
  changeSummary?: string,
): { version_id: number; version_number: number; snapshot: VersionSnapshot } {
  const row = getPipelineRow(database, pipelineId, userId);
  if (!row) throw new Error("pipeline not found");
  const snapshot = buildVersionSnapshot({
    python_code: String(row.python_code ?? ""),
    config: pipelineConfigObject(row),
    schedule: (row.schedule as string | null) ?? null,
    timezone: String(row.timezone ?? "UTC"),
    extract_strategy: row.extract_strategy as string,
    write_behavior: row.write_behavior as string,
    load_mode: row.load_mode as string,
    quality_checks: parseJson(String(row.quality_checks_json ?? "[]"), []),
  });
  const num = latestVersionNumber(database, pipelineId) + 1;
  const info = database
    .prepare(
      `INSERT INTO pipeline_versions (
         pipeline_id, version_number, python_code, config_json,
         schedule, timezone, extract_strategy, write_behavior,
         quality_checks_json, author_user_id, change_summary
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      pipelineId,
      num,
      snapshot.python_code,
      JSON.stringify(snapshot.config),
      snapshot.schedule,
      snapshot.timezone,
      snapshot.extract_strategy,
      snapshot.write_behavior,
      JSON.stringify(snapshot.quality_checks),
      userId,
      changeSummary ?? `Published version ${num}`,
    );
  const versionId = Number(info.lastInsertRowid);
  database
    .prepare(
      `UPDATE pipelines SET published_version_id = ?, updated_at = strftime('%s', 'now')
       WHERE id = ?`,
    )
    .run(versionId, pipelineId);
  recordActivity(database, {
    pipelineId,
    action: "publish",
    actorUserId: userId,
    versionId,
    detail: { version_number: num, change_summary: changeSummary ?? null },
  });
  return { version_id: versionId, version_number: num, snapshot };
}

export function listVersions(database: Database.Database, pipelineId: number) {
  return database
    .prepare(
      `SELECT id, pipeline_id, version_number, schedule, timezone,
              extract_strategy, write_behavior, author_user_id,
              change_summary, created_at, python_code, config_json,
              quality_checks_json
       FROM pipeline_versions WHERE pipeline_id = ?
       ORDER BY version_number DESC`,
    )
    .all(pipelineId);
}

export function getVersion(
  database: Database.Database,
  pipelineId: number,
  versionId: number,
) {
  return database
    .prepare(
      `SELECT * FROM pipeline_versions WHERE id = ? AND pipeline_id = ?`,
    )
    .get(versionId, pipelineId) as Record<string, unknown> | undefined;
}

export function diffVersions(
  database: Database.Database,
  pipelineId: number,
  fromId: number,
  toId: number,
) {
  const a = getVersion(database, pipelineId, fromId);
  const b = getVersion(database, pipelineId, toId);
  if (!a || !b) throw new Error("version not found");
  const cfgA = parseJson<Record<string, unknown>>(String(a.config_json), {});
  const cfgB = parseJson<Record<string, unknown>>(String(b.config_json), {});
  return {
    from: { id: a.id, version_number: a.version_number },
    to: { id: b.id, version_number: b.version_number },
    config_diff: diffConfigs(cfgA, cfgB),
    code_diff: diffCode(String(a.python_code ?? ""), String(b.python_code ?? "")),
  };
}

export function restoreVersionAsDraft(
  database: Database.Database,
  pipelineId: number,
  userId: number,
  versionId: number,
): Record<string, unknown> {
  const ver = getVersion(database, pipelineId, versionId);
  if (!ver) throw new Error("version not found");
  const cfg = parseJson<Record<string, unknown>>(String(ver.config_json), {});
  const sourceConfig = cfg.source_config ?? {};
  database
    .prepare(
      `UPDATE pipelines SET
         python_code = ?,
         source_config_json = ?,
         source_type = COALESCE(?, source_type),
         destination_connection_id = COALESCE(?, destination_connection_id),
         destination_dataset = COALESCE(?, destination_dataset),
         extract_strategy = ?,
         write_behavior = ?,
         schedule = ?,
         timezone = ?,
         quality_checks_json = ?,
         primary_key = COALESCE(?, primary_key),
         cursor_field = COALESCE(?, cursor_field),
         code_mode = 'custom',
         updated_at = strftime('%s', 'now')
       WHERE id = ? AND user_id = ?`,
    )
    .run(
      ver.python_code,
      JSON.stringify(sourceConfig),
      cfg.source_type ?? null,
      cfg.destination_connection_id ?? null,
      cfg.destination_dataset ?? null,
      ver.extract_strategy,
      ver.write_behavior,
      ver.schedule,
      ver.timezone,
      ver.quality_checks_json,
      cfg.primary_key ?? null,
      cfg.cursor_field ?? null,
      pipelineId,
      userId,
    );
  recordActivity(database, {
    pipelineId,
    action: "restore",
    actorUserId: userId,
    versionId,
    detail: { version_number: ver.version_number },
  });
  return getPipelineRow(database, pipelineId, userId) ?? {};
}

function resolveConnection(
  database: Database.Database,
  connectionId: number,
  userId: number,
): Record<string, unknown> {
  const conn = database
    .prepare("SELECT id, type, config_json, name FROM connections WHERE id = ? AND user_id = ?")
    .get(connectionId, userId) as
    | { id: number; type: string; config_json: string; name: string }
    | undefined;
  if (!conn) throw new Error("connection not found");
  const decrypted = decryptConnectionConfig(JSON.parse(conn.config_json)) as Record<string, unknown>;
  return { id: conn.id, type: conn.type, name: conn.name, ...decrypted };
}

export function unsealSourceSecrets(sealed: string | null | undefined): Record<string, string> {
  if (!sealed) return {};
  try {
    const raw = isEncrypted(sealed) ? decryptString(sealed) : sealed;
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist source_config secrets in an encrypted vault; return refs-only config. */
export function sealPipelineSourceConfig(
  incoming: Record<string, unknown>,
  previousSealed?: string | null,
): { sanitized: Record<string, unknown>; sealed: string } {
  const previous = unsealSourceSecrets(previousSealed);
  const { sanitized, secrets } = extractAndReplaceSecrets(incoming, {
    mask: SECRET_MASK,
    previous,
  });
  const merged = { ...previous, ...secrets };
  const sealed =
    Object.keys(merged).length > 0 ? encryptString(JSON.stringify(merged)) : "";
  return {
    sanitized: (sanitized && typeof sanitized === "object"
      ? sanitized
      : {}) as Record<string, unknown>,
    sealed,
  };
}

/**
 * Resolve source secret refs from the pipeline vault and/or the saved
 * source connection. Injects decrypted credentials into source_config
 * and returns the source connection blob for ctx.source_engine.
 */
export function prepareRuntimeSource(
  database: Database.Database,
  pipeline: Record<string, unknown>,
  snapshot: VersionSnapshot | null,
  userId: number,
): {
  sourceConfig: Record<string, unknown>;
  sourceConnection: Record<string, unknown> | null;
} {
  let sourceConfig = parseJson<Record<string, unknown>>(
    String(pipeline.source_config_json ?? "{}"),
    {},
  );
  if (snapshot?.config?.source_config && typeof snapshot.config.source_config === "object") {
    sourceConfig = snapshot.config.source_config as Record<string, unknown>;
  }

  const vault = unsealSourceSecrets(
    pipeline.source_secrets_json == null ? "" : String(pipeline.source_secrets_json),
  );
  const liveSource = parseJson<Record<string, unknown>>(
    String(pipeline.source_config_json ?? "{}"),
    {},
  );
  const sourceConnId =
    (snapshot?.config?.source_connection_id as number | null | undefined) ??
    (pipeline.source_connection_id as number | null | undefined) ??
    null;
  let sourceConnection: Record<string, unknown> | null = null;
  if (sourceConnId != null) {
    sourceConnection = resolveConnection(database, Number(sourceConnId), userId);
  }

  const resolver = (ref: string): string | undefined => {
    const stripped = ref.replace(/^source_config\./, "");
    const seg = stripped.includes(".") ? stripped.slice(stripped.lastIndexOf(".") + 1) : stripped;
    const keys = [ref, stripped, seg, `source_config.${seg}`];
    for (const k of keys) {
      if (vault[k] != null) return vault[k];
    }
    for (const k of keys) {
      const live = liveSource[k];
      if (typeof live === "string" && live.length > 0 && live !== SECRET_MASK) return live;
    }
    if (sourceConnection) {
      for (const k of keys) {
        const fromConn = sourceConnection[k];
        if (typeof fromConn === "string") return fromConn;
        if (typeof fromConn === "number") return String(fromConn);
      }
    }
    return undefined;
  };

  sourceConfig = resolveSecretReferences(sourceConfig, resolver) as Record<string, unknown>;

  if (sourceConnection) {
    for (const key of [
      "password", "user", "host", "port", "database", "auth_header", "connection_url",
    ]) {
      if (sourceConfig[key] == null && sourceConnection[key] != null) {
        sourceConfig[key] = sourceConnection[key];
      }
    }
    if (!sourceConfig.connection_url) {
      const url = buildSqlAlchemyUrl(sourceConnection);
      if (url) sourceConfig.connection_url = url;
    }
    sourceConfig._source_type = sourceConnection.type;
  }

  if (payloadHasSecretRefs(sourceConfig)) {
    throw new Error("unresolved source secret references");
  }
  return { sourceConfig, sourceConnection };
}

export function enqueueRun(
  database: Database.Database,
  req: EnqueueRequest,
): Record<string, unknown> {
  const pipeline = getPipelineRow(database, req.pipelineId, req.userId);
  if (!pipeline) throw new Error("pipeline not found");

  const isTest = !!req.isTest;
  let versionId = req.versionId ?? null;
  if (req.trigger === "retry" && req.retryOfRunId) {
    const orig = database
      .prepare("SELECT version_id FROM pipeline_runs WHERE id = ?")
      .get(req.retryOfRunId) as { version_id: number | null } | undefined;
    versionId = orig?.version_id ?? versionId;
  } else if (!isTest && versionId == null) {
    versionId = (pipeline.published_version_id as number | null) ?? null;
    if (versionId == null) {
      const published = publishVersion(
        database,
        req.pipelineId,
        req.userId,
        "Auto-published on first run",
      );
      versionId = published.version_id;
      pipeline.published_version_id = versionId;
    }
  }
  if (isTest) {
    if (pipeline.scratch_destination_connection_id == null) {
      throw new Error("Test draft requires an explicitly identified scratch destination");
    }
  }

  let snapshot: VersionSnapshot | null = null;
  if (versionId != null) {
    const ver = getVersion(database, req.pipelineId, versionId);
    if (ver) {
      snapshot = {
        python_code: String(ver.python_code),
        config: parseJson(String(ver.config_json), {}),
        schedule: (ver.schedule as string | null) ?? null,
        timezone: String(ver.timezone ?? "UTC"),
        extract_strategy: ver.extract_strategy as ExtractStrategy,
        write_behavior: ver.write_behavior as WriteBehavior,
        quality_checks: parseJson(String(ver.quality_checks_json ?? "[]"), []),
        secret_refs: [],
      };
    }
  } else {
    snapshot = buildVersionSnapshot({
      python_code: String(pipeline.python_code ?? ""),
      config: pipelineConfigObject(pipeline),
      schedule: (pipeline.schedule as string | null) ?? null,
      timezone: String(pipeline.timezone ?? "UTC"),
      extract_strategy: pipeline.extract_strategy as string,
      write_behavior: pipeline.write_behavior as string,
      load_mode: pipeline.load_mode as string,
      quality_checks: parseJson(String(pipeline.quality_checks_json ?? "[]"), []),
    });
  }

  const info = database
    .prepare(
      `INSERT INTO pipeline_runs (
         pipeline_id, status, triggered_by, version_id, queued_at,
         is_test, retry_of_run_id, processing_interval_start,
         processing_interval_end, backfill_warning, snapshot_json,
         attempt_number, max_attempts
       ) VALUES (?, 'queued', ?, ?, strftime('%s', 'now'), ?, ?, ?, ?, ?, ?, 1, 3)`,
    )
    .run(
      req.pipelineId,
      req.trigger,
      versionId,
      isTest ? 1 : 0,
      req.retryOfRunId ?? null,
      req.processingIntervalStart ?? null,
      req.processingIntervalEnd ?? null,
      req.backfillWarning ?? null,
      snapshot ? JSON.stringify(snapshot) : null,
    );
  const runId = Number(info.lastInsertRowid);
  recordActivity(database, {
    pipelineId: req.pipelineId,
    action: "enqueue",
    actorUserId: req.userId,
    runId,
    versionId,
    detail: { trigger: req.trigger, is_test: isTest },
  });
  void dispatchQueued(database);
  return getRun(database, runId)!;
}

export function getRun(database: Database.Database, runId: number) {
  return database.prepare("SELECT * FROM pipeline_runs WHERE id = ?").get(runId) as
    | Record<string, unknown>
    | undefined;
}

export function listAttempts(database: Database.Database, runId: number) {
  return database
    .prepare(
      `SELECT id, run_id, attempt_number, status, started_at, finished_at,
              log, error_message, pid
       FROM pipeline_run_attempts WHERE run_id = ? ORDER BY attempt_number`,
    )
    .all(runId);
}

function runToDto(
  database: Database.Database,
  run: Record<string, unknown>,
  pipelineName?: string,
) {
  const attempts = listAttempts(database, Number(run.id));
  const steps = parseJson<unknown[]>(String(run.steps_json ?? "[]"), []);
  const explanation =
    run.status === "failed"
      ? explainFailure({
          error: (run.error_message as string | null) ?? null,
          log: String(run.log ?? ""),
          lastSuccessfulUpdate: null,
          retryAt: (run.next_retry_at as number | null) ?? null,
          pipelineName: pipelineName ?? `pipeline #${run.pipeline_id}`,
        })
      : null;
  return {
    id: run.id,
    pipeline_id: run.pipeline_id,
    status: run.status,
    started_at: run.started_at,
    finished_at: run.finished_at,
    queued_at: run.queued_at,
    rows_loaded: run.rows_loaded,
    log: run.log,
    error_message: run.error_message,
    triggered_by: run.triggered_by,
    version_id: run.version_id,
    attempt_number: run.attempt_number,
    max_attempts: run.max_attempts,
    attempts,
    timestamps: {
      queued_at: run.queued_at,
      started_at: run.started_at,
      finished_at: run.finished_at,
      next_retry_at: run.next_retry_at,
    },
    processing_interval:
      run.processing_interval_start != null
        ? { start: run.processing_interval_start, end: run.processing_interval_end }
        : null,
    backfill_warning: run.backfill_warning,
    output_metrics: {
      rows_loaded: run.rows_loaded,
      output_tables: parseJson(String(run.output_tables_json ?? "[]"), []),
    },
    check_results: parseJson(String(run.check_results_json ?? "[]"), []),
    steps,
    pid: run.pid,
    is_test: !!run.is_test,
    retry_of_run_id: run.retry_of_run_id,
    cancel_requested: !!run.cancel_requested,
    explanation,
    resume_from_failed_step: canResumeFromFailedStep(
      parseJson(String(run.steps_json ?? "[]"), []),
    ),
  };
}

export function getRunDetail(
  database: Database.Database,
  pipelineId: number,
  runId: number,
  pipelineName?: string,
) {
  const run = database
    .prepare("SELECT * FROM pipeline_runs WHERE id = ? AND pipeline_id = ?")
    .get(runId, pipelineId) as Record<string, unknown> | undefined;
  if (!run) return null;
  return runToDto(database, run, pipelineName);
}

export async function dispatchQueued(database: Database.Database): Promise<void> {
  const running = database
    .prepare("SELECT COUNT(*) AS c FROM pipeline_runs WHERE status = 'running'")
    .get() as { c: number };
  let slots = workerState.maxConcurrent - running.c;
  if (slots <= 0) return;
  const due = database
    .prepare(
      `SELECT * FROM pipeline_runs
       WHERE status IN ('queued', 'retrying')
         AND cancel_requested = 0
         AND (next_retry_at IS NULL OR next_retry_at <= strftime('%s', 'now'))
       ORDER BY id ASC
       LIMIT ?`,
    )
    .all(slots) as Record<string, unknown>[];
  for (const run of due) {
    const decision = admitRun({
      inFlightCount: workerState.inFlight.size,
      maxConcurrent: workerState.maxConcurrent,
    });
    if (decision === "enqueue") break;
    workerState.inFlight.add(Number(run.pipeline_id));
    void executeRun(database, run).finally(() => {
      workerState.inFlight.delete(Number(run.pipeline_id));
      void dispatchQueued(database);
    });
    slots -= 1;
  }
}

async function executeRun(
  database: Database.Database,
  run: Record<string, unknown>,
): Promise<void> {
  const runId = Number(run.id);
  const pipelineId = Number(run.pipeline_id);
  const pipeline = database
    .prepare("SELECT * FROM pipelines WHERE id = ?")
    .get(pipelineId) as Record<string, unknown> | undefined;
  if (!pipeline) {
    finishRun(database, runId, pipelineId, {
      status: "failed",
      error: "pipeline not found",
      log: "",
      rows: null,
    });
    return;
  }
  const userId = Number(pipeline.user_id);
  const snapshot = parseJson<VersionSnapshot | null>(String(run.snapshot_json ?? "null"), null);
  const code = snapshot?.python_code ?? String(pipeline.python_code ?? "");
  const isTest = !!run.is_test;

  let destId = isTest
    ? Number(pipeline.scratch_destination_connection_id)
    : Number(pipeline.destination_connection_id);
  if (snapshot?.config?.destination_connection_id != null && !isTest) {
    destId = Number(snapshot.config.destination_connection_id);
  }
  if (!destId) {
    finishRun(database, runId, pipelineId, {
      status: "failed",
      error: "no destination connection",
      log: "",
      rows: null,
    });
    return;
  }

  let destination: Record<string, unknown>;
  try {
    destination = resolveConnection(database, destId, userId);
  } catch (e) {
    finishRun(database, runId, pipelineId, {
      status: "failed",
      error: (e as Error).message,
      log: "",
      rows: null,
    });
    return;
  }

  let sourceConfig: Record<string, unknown> = {};
  let sourceConnection: Record<string, unknown> | null = null;
  try {
    const prepared = prepareRuntimeSource(database, pipeline, snapshot, userId);
    sourceConfig = prepared.sourceConfig;
    sourceConnection = prepared.sourceConnection;
  } catch (e) {
    finishRun(database, runId, pipelineId, {
      status: "failed",
      error: (e as Error).message,
      log: "",
      rows: null,
    });
    return;
  }

  const attemptNumber = Number(run.attempt_number ?? 1);
  const attemptInfo = database
    .prepare(
      `INSERT INTO pipeline_run_attempts (run_id, attempt_number, status, started_at)
       VALUES (?, ?, 'running', strftime('%s', 'now'))`,
    )
    .run(runId, attemptNumber);
  const attemptId = Number(attemptInfo.lastInsertRowid);

  let spawned: SpawnedPipeline | null = null;
  try {
    spawned = spawnPipelineProcess({
      code,
      destination,
      source_config: sourceConfig,
      source_connection: sourceConnection,
      stream_max_seconds: Number(pipeline.stream_max_seconds ?? 60),
      stream_max_messages: Number(pipeline.stream_max_messages ?? 10_000),
      timeout_seconds: 1800,
    });
  } catch (e) {
    finishAttempt(database, attemptId, {
      status: "failed",
      log: "",
      error: (e as Error).message,
      pid: null,
    });
    maybeRetryOrFinish(database, run, pipeline, (e as Error).message, "");
    return;
  }

  liveChildren.set(runId, spawned);
  database
    .prepare(
      `UPDATE pipeline_runs SET status = 'running', pid = ?, job_dir = ?,
         started_at = strftime('%s', 'now')
       WHERE id = ?`,
    )
    .run(spawned.pid, spawned.jobDir, runId);
  database.prepare("UPDATE pipeline_run_attempts SET pid = ? WHERE id = ?").run(spawned.pid, attemptId);

  const exitCode = await waitForChild(spawned.child);
  liveChildren.delete(runId);
  const cancelled = !!(
    database.prepare("SELECT cancel_requested FROM pipeline_runs WHERE id = ?").get(runId) as
      | { cancel_requested: number }
      | undefined
  )?.cancel_requested;

  const result = readJobResult(spawned.jobPath);
  cleanupJobDir(spawned.jobDir);

  if (cancelled) {
    finishAttempt(database, attemptId, {
      status: "cancelled",
      log: result?.log ?? "",
      error: "cancelled",
      pid: spawned.pid,
    });
    finishRun(database, runId, pipelineId, {
      status: "cancelled",
      error: "cancelled",
      log: result?.log ?? "",
      rows: result?.rows_loaded ?? null,
    });
    recordActivity(database, {
      pipelineId,
      action: "cancel",
      runId,
      detail: { pid: spawned.pid, exit_code: exitCode },
    });
    return;
  }

  const success = !!result?.success;
  const log = result?.log ?? "";
  const error = result?.error ?? (success ? null : `process exited ${exitCode}`);
  finishAttempt(database, attemptId, {
    status: success ? "success" : "failed",
    log,
    error,
    pid: spawned.pid,
  });

  if (success) {
    const checks = evaluateRunChecks(
      database,
      pipeline,
      result?.rows_loaded ?? 0,
      flattenOutputRows(result),
    );
    database
      .prepare(
        `UPDATE pipeline_runs SET
           steps_json = ?, output_tables_json = ?, check_results_json = ?
         WHERE id = ?`,
      )
      .run(
        JSON.stringify(result?.steps ?? []),
        JSON.stringify(result?.output_tables ?? result?.rows ?? []),
        JSON.stringify(checks),
        runId,
      );
    finishRun(database, runId, pipelineId, {
      status: "success",
      error: null,
      log,
      rows: result?.rows_loaded ?? 0,
    });
  } else {
    maybeRetryOrFinish(database, run, pipeline, error, log);
  }
}

function evaluateRunChecks(
  database: Database.Database,
  pipeline: Record<string, unknown>,
  rowsLoaded: number,
  capturedRows: Record<string, unknown>[],
): CheckResult[] {
  const checks = parseJson<QualityCheck[]>(String(pipeline.quality_checks_json ?? "[]"), []);
  if (checks.length === 0) return [];
  const previous = database
    .prepare(
      `SELECT rows_loaded FROM pipeline_runs
       WHERE pipeline_id = ? AND status = 'success' AND rows_loaded IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .get(pipeline.id) as { rows_loaded: number } | undefined;
  const results: CheckResult[] = [];
  for (const check of checks) {
    if (check.type === "row_count") {
      const countRows =
        capturedRows.length > 0
          ? capturedRows
          : Array.from({ length: Math.min(rowsLoaded, 10_000) }, (_, i) => ({ _i: i }));
      results.push(
        evaluateQualityChecks({
          rows: countRows,
          checks: [check],
          previousRowCount: previous?.rows_loaded ?? null,
        })[0]!,
      );
      continue;
    }
    if (capturedRows.length === 0) {
      results.push({
        type: check.type,
        column: check.column,
        passed: false,
        message: `no output rows captured to evaluate ${check.type}${check.column ? ` on ${check.column}` : ""}`,
      });
      continue;
    }
    results.push(evaluateQualityChecks({ rows: capturedRows, checks: [check] })[0]!);
  }
  return results;
}

function maybeRetryOrFinish(
  database: Database.Database,
  run: Record<string, unknown>,
  pipeline: Record<string, unknown>,
  error: string | null,
  log: string,
): void {
  const attemptNumber = Number(run.attempt_number ?? 1);
  const maxAttempts = Number(run.max_attempts ?? 3);
  const retry = shouldRetry({ attemptNumber, maxAttempts, error });
  if (retry) {
    const backoff = computeRetryBackoffMs(attemptNumber);
    const nextAttempt = attemptNumber + 1;
    const nextAt = nowSec() + Math.ceil(backoff / 1000);
    database
      .prepare(
        `UPDATE pipeline_runs SET
           status = 'queued', attempt_number = ?, next_retry_at = ?,
           error_message = ?, log = ?, pid = NULL
         WHERE id = ?`,
      )
      .run(nextAttempt, nextAt, error, log, run.id);
    recordActivity(database, {
      pipelineId: Number(pipeline.id),
      action: "retry",
      runId: Number(run.id),
      detail: { attempt: nextAttempt, next_retry_at: nextAt, error },
    });
    return;
  }
  finishRun(database, Number(run.id), Number(pipeline.id), {
    status: "failed",
    error,
    log,
    rows: null,
  });
}

function finishAttempt(
  database: Database.Database,
  attemptId: number,
  r: { status: string; log: string; error: string | null; pid: number | null },
): void {
  database
    .prepare(
      `UPDATE pipeline_run_attempts SET
         status = ?, finished_at = strftime('%s', 'now'), log = ?, error_message = ?, pid = ?
       WHERE id = ?`,
    )
    .run(r.status, r.log, r.error, r.pid, attemptId);
}

function finishRun(
  database: Database.Database,
  runId: number,
  pipelineId: number,
  r: { status: RunStatus; error: string | null; log: string; rows: number | null },
): void {
  database
    .prepare(
      `UPDATE pipeline_runs SET
         status = ?, finished_at = strftime('%s', 'now'),
         rows_loaded = ?, log = ?, error_message = ?, pid = NULL
       WHERE id = ?`,
    )
    .run(r.status, r.rows, r.log, r.error, runId);
  database
    .prepare(
      `UPDATE pipelines SET last_run_id = ?, last_run_status = ?, last_run_at = strftime('%s', 'now')
       WHERE id = ?`,
    )
    .run(runId, r.status, pipelineId);
  if (r.status === "success") {
    database
      .prepare(
        `UPDATE pipelines SET last_successful_update = strftime('%s', 'now') WHERE id = ?`,
      )
      .run(pipelineId);
  }
}

export async function cancelRun(
  database: Database.Database,
  pipelineId: number,
  runId: number,
  userId: number,
): Promise<Record<string, unknown>> {
  const run = database
    .prepare("SELECT * FROM pipeline_runs WHERE id = ? AND pipeline_id = ?")
    .get(runId, pipelineId) as Record<string, unknown> | undefined;
  if (!run) throw new Error("run not found");
  database
    .prepare("UPDATE pipeline_runs SET cancel_requested = 1 WHERE id = ?")
    .run(runId);
  const spawned = liveChildren.get(runId);
  if (spawned) {
    killPid(spawned.pid, 500);
  } else if (run.pid) {
    killPid(Number(run.pid), 500);
  }
  if (run.status === "queued" || run.status === "retrying") {
    finishRun(database, runId, pipelineId, {
      status: "cancelled",
      error: "cancelled",
      log: "",
      rows: null,
    });
  }
  recordActivity(database, {
    pipelineId,
    action: "cancel",
    actorUserId: userId,
    runId,
    detail: { pid: run.pid ?? null },
  });
  const pid = spawned?.pid ?? (run.pid as number | null);
  const deadline = Date.now() + 4000;
  while (pid && isPidAlive(Number(pid)) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (pid && isPidAlive(Number(pid))) {
    killPid(Number(pid), 0);
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    id: runId,
    status: "cancelled",
    pid_alive: pid != null ? isPidAlive(Number(pid)) : false,
  };
}

export function retryRun(
  database: Database.Database,
  pipelineId: number,
  runId: number,
  userId: number,
): Record<string, unknown> {
  const orig = database
    .prepare("SELECT * FROM pipeline_runs WHERE id = ? AND pipeline_id = ?")
    .get(runId, pipelineId) as Record<string, unknown> | undefined;
  if (!orig) throw new Error("run not found");
  const pipeline = getPipelineRow(database, pipelineId, userId);
  if (!pipeline) throw new Error("pipeline not found");
  const published = (pipeline.published_version_id as number | null) ?? 0;
  const origVersion = (orig.version_id as number | null) ?? 0;
  const kind = classifyRetryKind({
    retryVersionId: origVersion,
    publishedVersionId: published,
  });
  const enqueued = enqueueRun(database, {
    pipelineId,
    userId,
    trigger: "retry",
    versionId: origVersion || null,
    retryOfRunId: runId,
  });
  return { ...enqueued, retry_kind: kind };
}

export function pauseSchedule(
  database: Database.Database,
  pipelineId: number,
  userId: number,
  paused = true,
): void {
  database
    .prepare(
      `UPDATE pipelines SET schedule_enabled = ?, paused = ?, updated_at = strftime('%s', 'now')
       WHERE id = ? AND user_id = ?`,
    )
    .run(paused ? 0 : 1, paused ? 1 : 0, pipelineId, userId);
  recordActivity(database, {
    pipelineId,
    action: paused ? "pause" : "resume",
    actorUserId: userId,
  });
}

export function planBackfill(
  writeBehavior: WriteBehavior,
  start: number,
  end: number,
) {
  return buildBackfillPlan({ intervalStart: start, intervalEnd: end, writeBehavior });
}

export function enqueueBackfill(
  database: Database.Database,
  pipelineId: number,
  userId: number,
  start: number,
  end: number,
  confirm: boolean,
): Record<string, unknown> {
  const pipeline = getPipelineRow(database, pipelineId, userId);
  if (!pipeline) throw new Error("pipeline not found");
  const load = normalizeLoadBehavior({
    extract_strategy: pipeline.extract_strategy as string,
    write_behavior: pipeline.write_behavior as string,
    load_mode: pipeline.load_mode as string,
  });
  const plan = buildBackfillPlan({
    intervalStart: start,
    intervalEnd: end,
    writeBehavior: load.write_behavior,
  });
  if (!confirm) {
    return { needs_confirm: true, ...plan };
  }
  return enqueueRun(database, {
    pipelineId,
    userId,
    trigger: "backfill",
    processingIntervalStart: start,
    processingIntervalEnd: end,
    backfillWarning: plan.warning,
    confirmBackfill: true,
  });
}

export function recoverQueue(database: Database.Database): void {
  const active = database
    .prepare(
      `SELECT id, status, pid FROM pipeline_runs
       WHERE status IN ('queued', 'running', 'retrying')`,
    )
    .all() as Array<{ id: number; status: string; pid: number | null }>;
  const recovered = recoverRunsOnRestart(active, isPidAlive);
  for (const r of recovered) {
    if (r.nextStatus === "queued" && r.requeue) {
      database
        .prepare(
          `UPDATE pipeline_runs SET status = 'queued', pid = NULL, next_retry_at = NULL
           WHERE id = ?`,
        )
        .run(r.id);
    }
  }
}

function fireBetween(schedule: string, prev: Date, now: Date, timezone: string): boolean {
  try {
    const it = cronParser.parseExpression(schedule, {
      currentDate: prev,
      endDate: now,
      tz: timezone || undefined,
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

export function enqueueDueSchedules(database: Database.Database): number {
  const now = new Date();
  const prev = new Date(workerState.lastTickAt * 1000);
  workerState.lastTickAt = Math.floor(now.getTime() / 1000);
  const due = database
    .prepare(
      `SELECT id, user_id, schedule, timezone FROM pipelines
       WHERE schedule_enabled = 1 AND schedule IS NOT NULL AND schedule != ''`,
    )
    .all() as Array<{ id: number; user_id: number; schedule: string; timezone: string | null }>;
  let n = 0;
  for (const row of due) {
    if (!fireBetween(row.schedule, prev, now, row.timezone || "UTC")) continue;
    try {
      enqueueRun(database, {
        pipelineId: row.id,
        userId: row.user_id,
        trigger: "schedule",
      });
      n += 1;
    } catch (e) {
      console.warn(`[scheduler] pipeline ${row.id} enqueue failed: ${(e as Error).message}`);
    }
  }
  return n;
}

export function startScheduler(database: Database.Database, intervalMs = 30_000): void {
  if (workerState.handle) return;
  workerState.database = database;
  recoverQueue(database);
  workerState.handle = setInterval(() => {
    enqueueDueSchedules(database);
    void dispatchQueued(database);
  }, intervalMs);
  enqueueDueSchedules(database);
  void dispatchQueued(database);
  console.log(`[scheduler] started, polling every ${intervalMs / 1000}s`);
}

export function stopScheduler(): void {
  if (workerState.handle) {
    clearInterval(workerState.handle);
    workerState.handle = null;
  }
}

export function nextRunEpoch(schedule: string, timezone = "UTC", after: Date = new Date()): number {
  const it = cronParser.parseExpression(schedule, {
    currentDate: after,
    tz: timezone || undefined,
  });
  return Math.floor(it.next().toDate().getTime() / 1000);
}

export function buildOverview(
  database: Database.Database,
  userId: number,
): { counts: Record<AttentionBucket, number>; pipelines: OverviewPipeline[] } {
  const rows = database
    .prepare("SELECT * FROM pipelines WHERE user_id = ? ORDER BY updated_at DESC")
    .all(userId) as Record<string, unknown>[];
  const now = nowSec();
  const entries: OverviewPipeline[] = [];
  for (const row of rows) {
    const recent = database
      .prepare(
        `SELECT id, status FROM pipeline_runs WHERE pipeline_id = ? ORDER BY id DESC LIMIT 10`,
      )
      .all(row.id) as Array<{ id: number; status: string }>;
    const lastSuccess = database
      .prepare(
        `SELECT finished_at, started_at, rows_loaded FROM pipeline_runs
         WHERE pipeline_id = ? AND status = 'success' ORDER BY id DESC LIMIT 1`,
      )
      .get(row.id) as
      | { finished_at: number | null; started_at: number; rows_loaded: number | null }
      | undefined;
    const lastFail = database
      .prepare(
        `SELECT id FROM pipeline_runs WHERE pipeline_id = ? AND status = 'failed'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(row.id) as { id: number } | undefined;
    const lastRun = database
      .prepare(
        `SELECT status, started_at, finished_at, rows_loaded FROM pipeline_runs
         WHERE pipeline_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(row.id) as
      | { status: string; started_at: number; finished_at: number | null; rows_loaded: number | null }
      | undefined;
    const running = recent.some((r) => r.status === "running");
    const queued = recent.some((r) => r.status === "queued" || r.status === "retrying");
    let destName: string | null = null;
    if (row.destination_connection_id != null) {
      const c = database
        .prepare("SELECT name FROM connections WHERE id = ?")
        .get(row.destination_connection_id) as { name: string } | undefined;
      destName = c?.name ?? null;
    }
    let sourceName: string | null = null;
    if (row.source_connection_id != null) {
      const c = database
        .prepare("SELECT name FROM connections WHERE id = ?")
        .get(row.source_connection_id) as { name: string } | undefined;
      sourceName = c?.name ?? null;
    }
    const pub = row.published_version_id
      ? (database
          .prepare("SELECT id, version_number FROM pipeline_versions WHERE id = ?")
          .get(row.published_version_id) as { id: number; version_number: number } | undefined)
      : undefined;
    let next: number | null = null;
    if (row.schedule && row.schedule_enabled) {
      try {
        next = nextRunEpoch(String(row.schedule), String(row.timezone || "UTC"));
      } catch {
        next = null;
      }
    }
    const lastChecks = parseJson<CheckResult[]>(
      String(
        (database
          .prepare(
            `SELECT check_results_json FROM pipeline_runs WHERE pipeline_id = ?
             ORDER BY id DESC LIMIT 1`,
          )
          .get(row.id) as { check_results_json: string } | undefined)?.check_results_json ?? "[]",
      ),
      [],
    );
    const duration =
      lastRun && lastRun.finished_at != null
        ? lastRun.finished_at - lastRun.started_at
        : null;
    entries.push(
      buildOverviewEntry({
        id: Number(row.id),
        name: String(row.name),
        description: (row.description as string | null) ?? null,
        sourceType: String(row.source_type),
        sourceName,
        destinationName: destName,
        destinationDataset: (row.destination_dataset as string | null) ?? null,
        tags: parseJson(String(row.tags_json ?? "[]"), []),
        schedule: (row.schedule as string | null) ?? null,
        scheduleEnabled: !!row.schedule_enabled,
        timezone: String(row.timezone || "UTC"),
        nextRun: next,
        lastSuccessfulUpdate:
          (row.last_successful_update as number | null) ?? lastSuccess?.finished_at ?? null,
        lastDurationSeconds: duration,
        lastRows: lastRun?.rows_loaded ?? null,
        lastRunStatus: lastRun?.status ?? (row.last_run_status as string | null) ?? null,
        lastFailedRunId: lastFail?.id ?? null,
        publishedVersionId: pub?.id ?? null,
        publishedVersionNumber: pub?.version_number ?? null,
        recentRuns: recent,
        running,
        queued,
        freshnessThresholdSeconds: (row.freshness_threshold_seconds as number | null) ?? null,
        checksFailed: lastChecks.some((c) => !c.passed),
        now,
      }),
    );
  }
  return {
    counts: buildOverviewCounts(entries.map((e) => e.attention)),
    pipelines: entries,
  };
}

export function pipelineLineage(
  database: Database.Database,
  pipelineId: number,
  userId: number,
) {
  const pipeline = getPipelineRow(database, pipelineId, userId);
  if (!pipeline) throw new Error("pipeline not found");
  const queries = database
    .prepare("SELECT id, name, sql FROM queries WHERE user_id = ?")
    .all(userId) as Array<{ id: number; name: string; sql: string }>;
  const widgets = database
    .prepare(
      `SELECT w.dashboard_id, d.name AS dashboard_name, w.query_id
       FROM dashboard_widgets w
       JOIN dashboards d ON d.id = w.dashboard_id
       WHERE d.user_id = ?`,
    )
    .all(userId) as Array<{ dashboard_id: number; dashboard_name: string; query_id: number | null }>;
  const auto = detectLineage({
    destinationDataset: (pipeline.destination_dataset as string | null) ?? null,
    destinationTable: null,
    queries,
    widgets,
  });
  const explicit = database
    .prepare(
      `SELECT l.query_id, l.dashboard_id, q.name AS query_name, d.name AS dashboard_name
       FROM pipeline_lineage l
       LEFT JOIN queries q ON q.id = l.query_id
       LEFT JOIN dashboards d ON d.id = l.dashboard_id
       WHERE l.pipeline_id = ?`,
    )
    .all(pipelineId) as Array<{
      query_id: number | null;
      dashboard_id: number | null;
      query_name: string | null;
      dashboard_name: string | null;
    }>;
  const qMap = new Map(auto.queries.map((q) => [q.id, q]));
  const dMap = new Map(auto.dashboards.map((d) => [d.id, d]));
  for (const e of explicit) {
    if (e.query_id && e.query_name) qMap.set(e.query_id, { id: e.query_id, name: e.query_name });
    if (e.dashboard_id && e.dashboard_name) {
      dMap.set(e.dashboard_id, { id: e.dashboard_id, name: e.dashboard_name });
    }
  }
  return {
    queries: [...qMap.values()],
    dashboards: [...dMap.values()],
  };
}

export function validatePipeline(
  database: Database.Database,
  pipelineId: number,
  userId: number,
): {
  ok: boolean;
  issues: ReturnType<typeof validatePipelineConfig>;
  connectivity: { ok: boolean; message: string };
} {
  const row = getPipelineRow(database, pipelineId, userId);
  if (!row) throw new Error("pipeline not found");
  const load = normalizeLoadBehavior({
    extract_strategy: row.extract_strategy as string,
    write_behavior: row.write_behavior as string,
    load_mode: row.load_mode as string,
  });
  const issues = validatePipelineConfig({
    name: String(row.name ?? ""),
    extract_strategy: load.extract_strategy,
    write_behavior: load.write_behavior,
    primary_key: (row.primary_key as string | null) ?? null,
    cursor_field: (row.cursor_field as string | null) ?? null,
    destination_connection_id: (row.destination_connection_id as number | null) ?? null,
    schedule: (row.schedule as string | null) ?? null,
    quality_checks: parseJson(String(row.quality_checks_json ?? "[]"), []),
  });
  let connectivity = { ok: false, message: "no destination" };
  if (row.destination_connection_id != null) {
    try {
      resolveConnection(database, Number(row.destination_connection_id), userId);
      connectivity = { ok: true, message: "destination credentials resolved" };
    } catch (e) {
      connectivity = { ok: false, message: (e as Error).message };
    }
  }
  return { ok: issues.length === 0 && connectivity.ok, issues, connectivity };
}

export async function inspectConnectionSchema(
  database: Database.Database,
  connectionId: number,
  userId: number,
): Promise<{ tables: unknown[]; sql: string; error?: string }> {
  const conn = database
    .prepare("SELECT id, type, config_json, name FROM connections WHERE id = ? AND user_id = ?")
    .get(connectionId, userId) as
    | { id: number; type: string; config_json: string; name: string }
    | undefined;
  if (!conn) throw new Error("connection not found");
  const sql = schemaInspectSql(conn.type);
  try {
    const decrypted = decryptConnectionConfig(JSON.parse(conn.config_json)) as Record<string, unknown>;
    const result = await pythonEngine.executeSql({
      connection: { type: conn.type, ...decrypted },
      sql,
      limit: 200,
    });
    if (!result.success) return { tables: [], sql, error: result.error };
    const tables = result.rows.map((row) => {
      const rec: Record<string, unknown> = {};
      result.columns.forEach((c, i) => {
        rec[c] = row[i];
      });
      return rec;
    });
    return { tables, sql };
  } catch (e) {
    return { tables: [], sql, error: (e as Error).message };
  }
}

export function aiSafePipeline(row: Record<string, unknown>): Record<string, unknown> {
  const cfg = pipelineConfigObject(row);
  const { sanitized } = stripSecretsFromConfig(cfg);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    source_type: row.source_type,
    load_mode: row.load_mode,
    extract_strategy: row.extract_strategy,
    write_behavior: row.write_behavior,
    destination_connection_id: row.destination_connection_id,
    destination_dataset: row.destination_dataset,
    source_connection_id: row.source_connection_id,
    schedule: row.schedule,
    timezone: row.timezone,
    schedule_enabled: !!row.schedule_enabled,
    published_version_id: row.published_version_id,
    code_mode: row.code_mode,
    python_code: row.python_code,
    config: sanitized,
    secret_refs: stripSecretsFromConfig(cfg).refs,
  };
}

export function snapshotContainsSecrets(
  snapshot: unknown,
  knownSecrets: string[],
): boolean {
  return payloadContainsSecretValues(snapshot, knownSecrets);
}

/** Test/helper: cancel in-flight work and drop worker bookkeeping. */
export async function shutdownRuns(database: Database.Database): Promise<void> {
  const active = database
    .prepare(
      `SELECT id, pipeline_id FROM pipeline_runs
       WHERE status IN ('queued','running','retrying')`,
    )
    .all() as Array<{ id: number; pipeline_id: number }>;
  for (const r of active) {
    try {
      await cancelRun(database, r.pipeline_id, r.id, 1);
    } catch {
      /* ignore */
    }
  }
  for (const spawned of liveChildren.values()) {
    killPid(spawned.pid, 0);
  }
  liveChildren.clear();
  workerState.inFlight.clear();
  await new Promise((r) => setTimeout(r, 80));
}

export async function waitForRun(
  database: Database.Database,
  runId: number,
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = getRun(database, runId);
    if (!run) throw new Error("run not found");
    const st = String(run.status);
    if (st === "success" || st === "failed" || st === "cancelled") return run;
    await new Promise((r) => setTimeout(r, 50));
    void dispatchQueued(database);
  }
  throw new Error("timed out waiting for run");
}

export function evaluateChecksOnTable(
  rows: Record<string, unknown>[],
  checks: QualityCheck[],
  previousRowCount?: number | null,
  now?: number,
): CheckResult[] {
  return evaluateQualityChecks({ rows, checks, previousRowCount, now });
}
