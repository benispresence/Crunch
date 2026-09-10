import { publicEnvironment, saveEnvironment } from "../services/pipelineEnvironment.js";
import cronParser from "cron-parser";
import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import { requireAuth } from "../middleware/auth.js";
import { pipelineAllowedPackages } from "../services/packages.js";
import { pythonEngine } from "../services/pythonEngine.js";
import {
  buildTemplateSpec,
  nextRun,
  rowToPipeline,
  runPipeline,
  type CodeMode,
  type LoadMode,
  type PipelineRow,
  type SourceType,
} from "../services/pipelines.js";
import { normalizeLoadBehavior, stripSecretsFromConfig } from "../services/pipelineOps.js";
import {
  aiSafePipeline,
  buildOverview,
  cancelRun,
  diffVersions,
  enqueueBackfill,
  enqueueRun,
  getRunDetail,
  inspectConnectionSchema,
  listActivity,
  listVersions,
  pauseSchedule,
  pipelineLineage,
  publishVersion,
  restoreVersionAsDraft,
  retryRun,
  sealPipelineSourceConfig,
  validatePipeline,
  waitForRun,
} from "../services/pipelineRuntime.js";

export const pipelinesRouter = Router();
pipelinesRouter.use(requireAuth);

// Values are deliberately separate from pipeline DTOs, snapshots and AI tools.
pipelinesRouter.get("/:id/environment", (req, res) => {
  const row = db.prepare("SELECT environment_sealed FROM pipelines WHERE id = ? AND user_id = ?").get(req.params.id, req.user!.sub) as {environment_sealed: string} | undefined;
  if (!row) { res.status(404).json({error: "not found"}); return; }
  res.json(publicEnvironment(row.environment_sealed));
});
pipelinesRouter.put("/:id/environment", (req, res) => {
  const row = db.prepare("SELECT environment_sealed FROM pipelines WHERE id = ? AND user_id = ?").get(req.params.id, req.user!.sub) as {environment_sealed: string} | undefined;
  if (!row) { res.status(404).json({error: "not found"}); return; }
  try {
    const sealed = saveEnvironment(req.body, row.environment_sealed);
    db.transaction(() => {
      db.prepare("UPDATE pipelines SET environment_sealed = ? WHERE id = ? AND user_id = ?").run(sealed, req.params.id, req.user!.sub);
      db.prepare("INSERT INTO pipeline_activity (pipeline_id, actor_user_id, action, detail_json) VALUES (?, ?, 'environment_updated', '{}')").run(req.params.id, req.user!.sub);
    })();
    res.json(publicEnvironment(sealed));
  } catch { res.status(400).json({error: "Invalid variables. Use unique uppercase names, avoid reserved process names, and enter values for new secrets."}); }
});

const SOURCE_TYPES = ["rest_api", "sql", "file", "kafka", "custom"] as const;
const LOAD_MODES = ["replace", "append", "merge", "incremental", "streaming"] as const;
const CODE_MODES = ["template", "custom"] as const;
const EXTRACT = ["full", "incremental", "streaming"] as const;
const WRITE = ["replace", "append", "merge"] as const;

const upsertSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().nullable().optional(),
  folder_id: z.number().int().nullable().optional(),
  source_type: z.enum(SOURCE_TYPES).default("custom"),
  source_config: z.record(z.unknown()).optional(),
  destination_connection_id: z.number().int().nullable().optional(),
  destination_dataset: z.string().max(120).nullable().optional(),
  load_mode: z.enum(LOAD_MODES).default("replace"),
  extract_strategy: z.enum(EXTRACT).optional(),
  write_behavior: z.enum(WRITE).optional(),
  primary_key: z.string().nullable().optional(),
  cursor_field: z.string().nullable().optional(),
  python_code: z.string().optional(),
  code_mode: z.enum(CODE_MODES).default("template"),
  schedule: z.string().nullable().optional(),
  schedule_enabled: z.boolean().optional(),
  stream_max_seconds: z.number().int().min(1).max(86400).optional(),
  stream_max_messages: z.number().int().min(1).max(10_000_000).optional(),
  tags: z.array(z.string()).optional(),
  timezone: z.string().optional(),
  freshness_threshold_seconds: z.number().int().nullable().optional(),
  quality_checks: z.array(z.record(z.unknown())).optional(),
  source_connection_id: z.number().int().nullable().optional(),
  scratch_destination_connection_id: z.number().int().nullable().optional(),
  scratch_destination_dataset: z.string().nullable().optional(),
  processing_interval: z.string().nullable().optional(),
  convert_to_custom: z.boolean().optional(),
});

const SELECT_COLS = `
  id, user_id, folder_id, name, description,
  source_type, source_config_json,
  destination_connection_id, destination_dataset,
  load_mode, primary_key, cursor_field,
  python_code, code_mode,
  schedule, schedule_enabled,
  stream_max_seconds, stream_max_messages,
  last_run_id, last_run_status, last_run_at,
  created_at, updated_at,
  tags_json, timezone, extract_strategy, write_behavior,
  freshness_threshold_seconds, quality_checks_json,
  source_connection_id, scratch_destination_connection_id,
  scratch_destination_dataset, published_version_id, paused,
  processing_interval, last_successful_update,
  source_secrets_json
`;

pipelinesRouter.get("/timeline", (req, res) => {
  const lookbackHours = Math.min(
    24 * 30,
    Math.max(1, Number(req.query.hours ?? 24)),
  );
  const limit = Math.min(500, Math.max(10, Number(req.query.limit ?? 200)));
  const since = Math.floor(Date.now() / 1000) - lookbackHours * 3600;
  const rows = db
    .prepare(
      `SELECT r.id, r.pipeline_id, r.status, r.started_at, r.finished_at,
              r.rows_loaded, r.triggered_by, r.error_message,
              p.name AS pipeline_name
       FROM pipeline_runs r
       JOIN pipelines p ON p.id = r.pipeline_id
       WHERE p.user_id = ? AND COALESCE(r.started_at, r.queued_at, 0) >= ?
       ORDER BY COALESCE(r.started_at, r.queued_at) DESC
       LIMIT ?`,
    )
    .all(req.user!.sub, since, limit);
  res.json({ runs: rows, lookback_hours: lookbackHours });
});

pipelinesRouter.get("/overview", (req, res) => {
  res.json(buildOverview(db, req.user!.sub));
});

pipelinesRouter.post("/imports", async (req, res) => {
  const parsed = z.object({ code: z.string() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const r = await pythonEngine.analyzePipelineImports(
      parsed.data.code,
      pipelineAllowedPackages(),
    );
    res.json(r);
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

pipelinesRouter.get("/schema/:connectionId", async (req, res) => {
  try {
    const r = await inspectConnectionSchema(db, Number(req.params.connectionId), req.user!.sub);
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

pipelinesRouter.get("/", (req, res) => {
  const overview = buildOverview(db, req.user!.sub);
  res.json(overview);
});

pipelinesRouter.get("/:id", (req, res) => {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM pipelines WHERE id = ? AND user_id = ?`,
    )
    .get(req.params.id, req.user!.sub) as PipelineRow | undefined;
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const overview = buildOverview(db, req.user!.sub);
  const extra = overview.pipelines.find((p) => p.id === row.id);
  const lineage = pipelineLineage(db, row.id, req.user!.sub);
  res.json({ ...extra, ...rowToPipeline(row), published_schedule: extra?.schedule, published_timezone: extra?.timezone, feeds: lineage });
});

pipelinesRouter.post("/template", async (req, res) => {
  const parsed = upsertSchema
    .partial()
    .extend({ name: z.string().min(1) })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const load = normalizeLoadBehavior({
    extract_strategy: parsed.data.extract_strategy,
    write_behavior: parsed.data.write_behavior,
    load_mode: parsed.data.load_mode,
  });
  const { sanitized } = stripSecretsFromConfig(parsed.data.source_config ?? {});
  const row: PipelineRow = {
    id: 0,
    user_id: req.user!.sub,
    folder_id: null,
    name: parsed.data.name,
    description: parsed.data.description ?? null,
    source_type: (parsed.data.source_type ?? "custom") as SourceType,
    source_config_json: JSON.stringify(sanitized),
    destination_connection_id: parsed.data.destination_connection_id ?? null,
    destination_dataset: parsed.data.destination_dataset ?? null,
    load_mode: (parsed.data.load_mode ?? "replace") as LoadMode,
    extract_strategy: load.extract_strategy,
    write_behavior: load.write_behavior,
    primary_key: parsed.data.primary_key ?? null,
    cursor_field: parsed.data.cursor_field ?? null,
    python_code: "",
    code_mode: (parsed.data.code_mode ?? "template") as CodeMode,
    schedule: parsed.data.schedule ?? null,
    schedule_enabled: parsed.data.schedule_enabled ? 1 : 0,
    stream_max_seconds: parsed.data.stream_max_seconds ?? 60,
    stream_max_messages: parsed.data.stream_max_messages ?? 10_000,
    last_run_id: null, last_run_status: null,
    last_run_at: null,
    created_at: 0, updated_at: 0,
  };
  const spec = buildTemplateSpec(row, req.user!.sub);
  try {
    const r = await pythonEngine.generatePipelineTemplate(spec);
    res.json({ code: r.code, spec, generated: true });
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

pipelinesRouter.post("/", async (req, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (parsed.data.schedule) {
    try { nextRun(parsed.data.schedule, parsed.data.timezone || "UTC"); }
    catch (e) {
      res.status(400).json({ error: `invalid cron: ${(e as Error).message}` });
      return;
    }
  }
  const load = normalizeLoadBehavior({
    extract_strategy: parsed.data.extract_strategy,
    write_behavior: parsed.data.write_behavior,
    load_mode: parsed.data.load_mode,
  });
  const sealed = sealPipelineSourceConfig(parsed.data.source_config ?? {});
  const info = db
    .prepare(
      `INSERT INTO pipelines (
         user_id, folder_id, name, description,
         source_type, source_config_json,
         destination_connection_id, destination_dataset,
         load_mode, primary_key, cursor_field,
         python_code, code_mode,
         schedule, schedule_enabled,
         stream_max_seconds, stream_max_messages,
         tags_json, timezone, extract_strategy, write_behavior,
         freshness_threshold_seconds, quality_checks_json,
         source_connection_id, scratch_destination_connection_id,
         scratch_destination_dataset, processing_interval,
         source_secrets_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      req.user!.sub,
      parsed.data.folder_id ?? null,
      parsed.data.name,
      parsed.data.description ?? null,
      parsed.data.source_type ?? "custom",
      JSON.stringify(sealed.sanitized),
      parsed.data.destination_connection_id ?? null,
      parsed.data.destination_dataset ?? null,
      parsed.data.load_mode ?? "replace",
      parsed.data.primary_key ?? null,
      parsed.data.cursor_field ?? null,
      parsed.data.python_code ?? "",
      parsed.data.convert_to_custom ? "custom" : (parsed.data.code_mode ?? "template"),
      parsed.data.schedule ?? null,
      parsed.data.schedule_enabled ? 1 : 0,
      parsed.data.stream_max_seconds ?? 60,
      parsed.data.stream_max_messages ?? 10_000,
      JSON.stringify(parsed.data.tags ?? []),
      parsed.data.timezone ?? "UTC",
      load.extract_strategy,
      load.write_behavior,
      parsed.data.freshness_threshold_seconds ?? null,
      JSON.stringify(parsed.data.quality_checks ?? []),
      parsed.data.source_connection_id ?? null,
      parsed.data.scratch_destination_connection_id ?? null,
      parsed.data.scratch_destination_dataset ?? null,
      parsed.data.processing_interval ?? null,
      sealed.sealed,
    );
  const row = db.prepare(`SELECT ${SELECT_COLS} FROM pipelines WHERE id = ?`).get(info.lastInsertRowid) as PipelineRow;
  if (row.code_mode === "template" && !row.python_code.trim()) {
    try {
      const generated = await pythonEngine.generatePipelineTemplate(buildTemplateSpec(row, req.user!.sub));
      db.prepare("UPDATE pipelines SET python_code = ? WHERE id = ?").run(generated.code, row.id);
      row.python_code = generated.code;
    } catch(e) { res.status(502).json({error: `Draft saved, but generation failed: ${String(e)}`, pipeline_id: row.id}); return; }
  }
  res.json(rowToPipeline(row));
});

pipelinesRouter.put("/:id", async (req, res) => {
  const parsed = upsertSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (parsed.data.schedule) {
    try { nextRun(parsed.data.schedule, parsed.data.timezone || "UTC"); }
    catch (e) {
      res.status(400).json({ error: `invalid cron: ${(e as Error).message}` });
      return;
    }
  }
  const existing = db
    .prepare(`SELECT ${SELECT_COLS} FROM pipelines WHERE id = ? AND user_id = ?`)
    .get(req.params.id, req.user!.sub) as PipelineRow | undefined;
  if (!existing) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const fields: string[] = [];
  const values: unknown[] = [];
  const push = (sql: string, v: unknown) => { fields.push(sql); values.push(v); };
  if (parsed.data.name !== undefined) push("name = ?", parsed.data.name);
  if (parsed.data.description !== undefined) push("description = ?", parsed.data.description);
  if (parsed.data.folder_id !== undefined) push("folder_id = ?", parsed.data.folder_id);
  if (parsed.data.source_type !== undefined) push("source_type = ?", parsed.data.source_type);
  if (parsed.data.source_config !== undefined) {
    const sealed = sealPipelineSourceConfig(
      parsed.data.source_config,
      (existing as { source_secrets_json?: string }).source_secrets_json ?? "",
    );
    push("source_config_json = ?", JSON.stringify(sealed.sanitized));
    push("source_secrets_json = ?", sealed.sealed);
  }
  if (parsed.data.destination_connection_id !== undefined) push("destination_connection_id = ?", parsed.data.destination_connection_id);
  if (parsed.data.destination_dataset !== undefined) push("destination_dataset = ?", parsed.data.destination_dataset);
  if (parsed.data.load_mode !== undefined) push("load_mode = ?", parsed.data.load_mode);
  if (parsed.data.primary_key !== undefined) push("primary_key = ?", parsed.data.primary_key);
  if (parsed.data.cursor_field !== undefined) push("cursor_field = ?", parsed.data.cursor_field);
  const nextMode = parsed.data.convert_to_custom
    ? "custom"
    : parsed.data.code_mode;
  // An explicitly submitted script is an edit, including an AI patch that
  // omits code_mode. Template generation happens only for generated drafts.
  if (parsed.data.python_code !== undefined) {
    push("python_code = ?", parsed.data.python_code);
  }
  if (nextMode !== undefined) push("code_mode = ?", nextMode);
  if (parsed.data.schedule !== undefined) push("schedule = ?", parsed.data.schedule);
  if (parsed.data.schedule_enabled !== undefined) push("schedule_enabled = ?", parsed.data.schedule_enabled ? 1 : 0);
  if (parsed.data.stream_max_seconds !== undefined) push("stream_max_seconds = ?", parsed.data.stream_max_seconds);
  if (parsed.data.stream_max_messages !== undefined) push("stream_max_messages = ?", parsed.data.stream_max_messages);
  if (parsed.data.tags !== undefined) push("tags_json = ?", JSON.stringify(parsed.data.tags));
  if (parsed.data.timezone !== undefined) push("timezone = ?", parsed.data.timezone);
  if (parsed.data.extract_strategy !== undefined || parsed.data.write_behavior !== undefined || parsed.data.load_mode !== undefined) {
    const load = normalizeLoadBehavior({
      extract_strategy: parsed.data.extract_strategy ?? existing.extract_strategy,
      write_behavior: parsed.data.write_behavior ?? existing.write_behavior,
      load_mode: parsed.data.load_mode ?? existing.load_mode,
    });
    push("extract_strategy = ?", load.extract_strategy);
    push("write_behavior = ?", load.write_behavior);
  }
  if (parsed.data.freshness_threshold_seconds !== undefined) push("freshness_threshold_seconds = ?", parsed.data.freshness_threshold_seconds);
  if (parsed.data.quality_checks !== undefined) push("quality_checks_json = ?", JSON.stringify(parsed.data.quality_checks));
  if (parsed.data.source_connection_id !== undefined) push("source_connection_id = ?", parsed.data.source_connection_id);
  if (parsed.data.scratch_destination_connection_id !== undefined) {
    push("scratch_destination_connection_id = ?", parsed.data.scratch_destination_connection_id);
  }
  if (parsed.data.scratch_destination_dataset !== undefined) {
    push("scratch_destination_dataset = ?", parsed.data.scratch_destination_dataset);
  }
  if (parsed.data.processing_interval !== undefined) push("processing_interval = ?", parsed.data.processing_interval);
  if (fields.length === 0) {
    res.json(rowToPipeline(existing));
    return;
  }
  fields.push("updated_at = strftime('%s', 'now')");
  values.push(req.params.id, req.user!.sub);
  db.prepare(
    `UPDATE pipelines SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`,
  ).run(...values);
  const row = db
    .prepare(`SELECT ${SELECT_COLS} FROM pipelines WHERE id = ? AND user_id = ?`)
    .get(req.params.id, req.user!.sub) as PipelineRow | undefined;
  res.json(row ? rowToPipeline(row) : { ok: true });
});

pipelinesRouter.delete("/:id", (req, res) => {
  const r = db
    .prepare("DELETE FROM pipelines WHERE id = ? AND user_id = ?")
    .run(req.params.id, req.user!.sub);
  if (r.changes === 0) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ ok: true });
});

pipelinesRouter.post("/:id/run", async (req, res) => {
  try {
    const wait = req.query.wait === "1" || req.body?.wait === true;
    const run = await runPipeline(Number(req.params.id), req.user!.sub, "manual", { wait });
    res.json(run);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

async function prepareGeneratedDraft(id: number, userId: number) {
  const row = db.prepare("SELECT * FROM pipelines WHERE id = ? AND user_id = ?").get(id,userId) as PipelineRow | undefined;
  if (!row) throw new Error("pipeline not found");
  if (row.code_mode === "template") {
    const generated = await pythonEngine.generatePipelineTemplate(buildTemplateSpec(row,userId));
    db.prepare("UPDATE pipelines SET python_code = ? WHERE id = ? AND user_id = ?").run(generated.code,id,userId);
  }
}

pipelinesRouter.post("/:id/test", async (req, res) => {
  try {
    await prepareGeneratedDraft(Number(req.params.id), req.user!.sub);
    const run = enqueueRun(db, {
      pipelineId: Number(req.params.id),
      userId: req.user!.sub,
      trigger: "test",
      isTest: true,
    });
    if (req.query.wait === "1") {
      res.json(await waitForRun(db, Number(run.id)));
      return;
    }
    res.json(run);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

pipelinesRouter.post("/:id/publish", async (req, res) => {
  try {
    await prepareGeneratedDraft(Number(req.params.id), req.user!.sub);
    const validation = await validatePipeline(db, Number(req.params.id), req.user!.sub);
    if (!validation.ok) { res.status(400).json({error: "Validation failed", validation}); return; }
    const r = publishVersion(
      db,
      Number(req.params.id),
      req.user!.sub,
      typeof req.body?.change_summary === "string" ? req.body.change_summary : undefined,
    );
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

pipelinesRouter.get("/:id/versions", (req, res) => {
  const exists = db
    .prepare("SELECT id FROM pipelines WHERE id = ? AND user_id = ?")
    .get(req.params.id, req.user!.sub);
  if (!exists) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ versions: listVersions(db, Number(req.params.id)) });
});

pipelinesRouter.get("/:id/versions/:fromId/diff/:toId", (req, res) => {
  try {
    res.json(
      diffVersions(
        db,
        Number(req.params.id),
        Number(req.params.fromId),
        Number(req.params.toId),
      ),
    );
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

pipelinesRouter.post("/:id/versions/:versionId/restore", (req, res) => {
  try {
    const row = restoreVersionAsDraft(
      db,
      Number(req.params.id),
      req.user!.sub,
      Number(req.params.versionId),
    );
    res.json(rowToPipeline(row as unknown as PipelineRow));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

pipelinesRouter.get("/:id/runs", (req, res) => {
  const pipelineId = Number(req.params.id);
  const exists = db
    .prepare("SELECT id FROM pipelines WHERE id = ? AND user_id = ?")
    .get(pipelineId, req.user!.sub);
  if (!exists) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const rows = db
    .prepare(
      `SELECT id, status, started_at, finished_at, rows_loaded,
              error_message, triggered_by, version_id, attempt_number,
              queued_at, processing_interval_start, processing_interval_end
       FROM pipeline_runs WHERE pipeline_id = ?
       ORDER BY id DESC LIMIT 50`,
    )
    .all(pipelineId);
  res.json({ runs: rows });
});

pipelinesRouter.get("/:id/runs/:runId", (req, res) => {
  const pipelineId = Number(req.params.id);
  const pipe = db
    .prepare("SELECT id, name FROM pipelines WHERE id = ? AND user_id = ?")
    .get(pipelineId, req.user!.sub) as { id: number; name: string } | undefined;
  if (!pipe) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const detail = getRunDetail(db, pipelineId, Number(req.params.runId), pipe.name);
  if (!detail) {
    res.status(404).json({ error: "run not found" });
    return;
  }
  res.json(detail);
});

pipelinesRouter.post("/:id/runs/:runId/cancel", async (req, res) => {
  try {
    res.json(await cancelRun(db, Number(req.params.id), Number(req.params.runId), req.user!.sub));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

pipelinesRouter.post("/:id/runs/:runId/retry", (req, res) => {
  try {
    res.json(retryRun(db, Number(req.params.id), Number(req.params.runId), req.user!.sub));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

pipelinesRouter.post("/:id/pause", (req, res) => {
  try {
    const paused = req.body?.paused !== false;
    pauseSchedule(db, Number(req.params.id), req.user!.sub, paused);
    res.json({ ok: true, paused });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

pipelinesRouter.post("/:id/validate", async (req, res) => {
  try {
    res.json(await validatePipeline(db, Number(req.params.id), req.user!.sub));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

pipelinesRouter.post("/:id/backfill", (req, res) => {
  try {
    const start = Number(req.body?.start);
    const end = Number(req.body?.end);
    const confirm = !!req.body?.confirm;
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      res.status(400).json({ error: "start and end (epoch seconds) required" });
      return;
    }
    res.json(enqueueBackfill(db, Number(req.params.id), req.user!.sub, start, end, confirm));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

pipelinesRouter.get("/:id/activity", (req, res) => {
  const exists = db
    .prepare("SELECT id FROM pipelines WHERE id = ? AND user_id = ?")
    .get(req.params.id, req.user!.sub);
  if (!exists) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ activity: listActivity(db, Number(req.params.id)) });
});

pipelinesRouter.get("/:id/impact", (req, res) => {
  try {
    res.json(pipelineLineage(db, Number(req.params.id), req.user!.sub));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

pipelinesRouter.get("/:id/ai-safe", (req, res) => {
  const row = db
    .prepare(`SELECT ${SELECT_COLS} FROM pipelines WHERE id = ? AND user_id = ?`)
    .get(req.params.id, req.user!.sub) as Record<string, unknown> | undefined;
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(aiSafePipeline(row));
});

pipelinesRouter.get("/:id/next-runs", (req, res) => {
  const row = db
    .prepare(
      "SELECT v.schedule, p.schedule_enabled, v.timezone FROM pipelines p LEFT JOIN pipeline_versions v ON v.id = p.published_version_id WHERE p.id = ? AND p.user_id = ?",
    )
    .get(req.params.id, req.user!.sub) as
    | { schedule: string | null; schedule_enabled: number; timezone: string | null }
    | undefined;
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (!row.schedule || row.schedule_enabled === 0) {
    res.json({ next: [], timezone: row.timezone || "UTC" });
    return;
  }
  try {
    const it = cronParser.parseExpression(row.schedule, {
      currentDate: new Date(),
      tz: row.timezone || undefined,
    });
    const next: number[] = [];
    for (let i = 0; i < 5; i++) {
      next.push(Math.floor(it.next().toDate().getTime() / 1000));
    }
    res.json({ next, timezone: row.timezone || "UTC" });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});
