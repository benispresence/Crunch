import cronParser from "cron-parser";
import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import { requireAuth } from "../middleware/auth.js";
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

export const pipelinesRouter = Router();
pipelinesRouter.use(requireAuth);

const SOURCE_TYPES = ["rest_api", "sql", "file", "kafka", "custom"] as const;
const LOAD_MODES = ["replace", "append", "merge", "incremental", "streaming"] as const;
const CODE_MODES = ["template", "custom"] as const;

const upsertSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().nullable().optional(),
  folder_id: z.number().int().nullable().optional(),
  source_type: z.enum(SOURCE_TYPES).default("custom"),
  source_config: z.record(z.unknown()).optional(),
  destination_connection_id: z.number().int().nullable().optional(),
  destination_dataset: z.string().max(120).nullable().optional(),
  load_mode: z.enum(LOAD_MODES).default("replace"),
  primary_key: z.string().nullable().optional(),
  cursor_field: z.string().nullable().optional(),
  python_code: z.string().optional(),
  code_mode: z.enum(CODE_MODES).default("template"),
  schedule: z.string().nullable().optional(),
  schedule_enabled: z.boolean().optional(),
  stream_max_seconds: z.number().int().min(1).max(86400).optional(),
  stream_max_messages: z.number().int().min(1).max(10_000_000).optional(),
});

const SELECT_COLS = `
  id, user_id, folder_id, name, description,
  source_type, source_config_json,
  destination_connection_id, destination_dataset,
  load_mode, primary_key, cursor_field,
  python_code, code_mode,
  schedule, schedule_enabled,
  stream_max_seconds, stream_max_messages,
  last_run_id, last_run_status, last_run_at, last_scheduled_check,
  created_at, updated_at
`;

pipelinesRouter.get("/", (req, res) => {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM pipelines WHERE user_id = ?
       ORDER BY updated_at DESC`,
    )
    .all(req.user!.sub) as PipelineRow[];
  res.json(rows.map(rowToPipeline));
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
  res.json(rowToPipeline(row));
});

/**
 * Generate (or re-generate) a template script for the given form
 * inputs. Useful when the UI wants to preview the script before save,
 * and on every save when ``code_mode = template``.
 */
pipelinesRouter.post("/template", async (req, res) => {
  const parsed = upsertSchema
    .partial()
    .extend({ name: z.string().min(1) })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // We assemble a "virtual" pipeline row so buildTemplateSpec can run
  // with no DB persistence. Resolving the destination connection from
  // the user's accounts gives the template the right destination type.
  const row: PipelineRow = {
    id: 0,
    user_id: req.user!.sub,
    folder_id: null,
    name: parsed.data.name,
    description: parsed.data.description ?? null,
    source_type: (parsed.data.source_type ?? "custom") as SourceType,
    source_config_json: JSON.stringify(parsed.data.source_config ?? {}),
    destination_connection_id: parsed.data.destination_connection_id ?? null,
    destination_dataset: parsed.data.destination_dataset ?? null,
    load_mode: (parsed.data.load_mode ?? "replace") as LoadMode,
    primary_key: parsed.data.primary_key ?? null,
    cursor_field: parsed.data.cursor_field ?? null,
    python_code: "",
    code_mode: (parsed.data.code_mode ?? "template") as CodeMode,
    schedule: parsed.data.schedule ?? null,
    schedule_enabled: parsed.data.schedule_enabled ? 1 : 0,
    stream_max_seconds: parsed.data.stream_max_seconds ?? 60,
    stream_max_messages: parsed.data.stream_max_messages ?? 10_000,
    last_run_id: null, last_run_status: null,
    last_run_at: null, last_scheduled_check: null,
    created_at: 0, updated_at: 0,
  };
  const spec = buildTemplateSpec(row, req.user!.sub);
  try {
    const r = await pythonEngine.generatePipelineTemplate(spec);
    res.json({ code: r.code, spec });
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
    try { nextRun(parsed.data.schedule); }
    catch (e) {
      res.status(400).json({ error: `invalid cron: ${(e as Error).message}` });
      return;
    }
  }
  const info = db
    .prepare(
      `INSERT INTO pipelines (
         user_id, folder_id, name, description,
         source_type, source_config_json,
         destination_connection_id, destination_dataset,
         load_mode, primary_key, cursor_field,
         python_code, code_mode,
         schedule, schedule_enabled,
         stream_max_seconds, stream_max_messages
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      req.user!.sub,
      parsed.data.folder_id ?? null,
      parsed.data.name,
      parsed.data.description ?? null,
      parsed.data.source_type ?? "custom",
      JSON.stringify(parsed.data.source_config ?? {}),
      parsed.data.destination_connection_id ?? null,
      parsed.data.destination_dataset ?? null,
      parsed.data.load_mode ?? "replace",
      parsed.data.primary_key ?? null,
      parsed.data.cursor_field ?? null,
      parsed.data.python_code ?? "",
      parsed.data.code_mode ?? "template",
      parsed.data.schedule ?? null,
      parsed.data.schedule_enabled ? 1 : 0,
      parsed.data.stream_max_seconds ?? 60,
      parsed.data.stream_max_messages ?? 10_000,
    );
  const row = db
    .prepare(`SELECT ${SELECT_COLS} FROM pipelines WHERE id = ?`)
    .get(info.lastInsertRowid) as PipelineRow;
  res.json(rowToPipeline(row));
});

pipelinesRouter.put("/:id", async (req, res) => {
  const parsed = upsertSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (parsed.data.schedule) {
    try { nextRun(parsed.data.schedule); }
    catch (e) {
      res.status(400).json({ error: `invalid cron: ${(e as Error).message}` });
      return;
    }
  }
  const fields: string[] = [];
  const values: unknown[] = [];
  const push = (sql: string, v: unknown) => { fields.push(sql); values.push(v); };
  if (parsed.data.name !== undefined) push("name = ?", parsed.data.name);
  if (parsed.data.description !== undefined) push("description = ?", parsed.data.description);
  if (parsed.data.folder_id !== undefined) push("folder_id = ?", parsed.data.folder_id);
  if (parsed.data.source_type !== undefined) push("source_type = ?", parsed.data.source_type);
  if (parsed.data.source_config !== undefined) push("source_config_json = ?", JSON.stringify(parsed.data.source_config));
  if (parsed.data.destination_connection_id !== undefined) push("destination_connection_id = ?", parsed.data.destination_connection_id);
  if (parsed.data.destination_dataset !== undefined) push("destination_dataset = ?", parsed.data.destination_dataset);
  if (parsed.data.load_mode !== undefined) push("load_mode = ?", parsed.data.load_mode);
  if (parsed.data.primary_key !== undefined) push("primary_key = ?", parsed.data.primary_key);
  if (parsed.data.cursor_field !== undefined) push("cursor_field = ?", parsed.data.cursor_field);
  if (parsed.data.python_code !== undefined) push("python_code = ?", parsed.data.python_code);
  if (parsed.data.code_mode !== undefined) push("code_mode = ?", parsed.data.code_mode);
  if (parsed.data.schedule !== undefined) push("schedule = ?", parsed.data.schedule);
  if (parsed.data.schedule_enabled !== undefined) push("schedule_enabled = ?", parsed.data.schedule_enabled ? 1 : 0);
  if (parsed.data.stream_max_seconds !== undefined) push("stream_max_seconds = ?", parsed.data.stream_max_seconds);
  if (parsed.data.stream_max_messages !== undefined) push("stream_max_messages = ?", parsed.data.stream_max_messages);
  if (fields.length === 0) {
    res.json({ ok: true });
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

/** Run a pipeline now. Returns the completed run record. */
pipelinesRouter.post("/:id/run", async (req, res) => {
  try {
    const run = await runPipeline(Number(req.params.id), req.user!.sub, "manual");
    res.json(run);
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
  // Return without logs for fast listing; the dialog fetches one
  // run by id when the user clicks a row.
  const rows = db
    .prepare(
      `SELECT id, status, started_at, finished_at, rows_loaded,
              error_message, triggered_by
       FROM pipeline_runs WHERE pipeline_id = ?
       ORDER BY id DESC LIMIT 50`,
    )
    .all(pipelineId);
  res.json({ runs: rows });
});

pipelinesRouter.get("/:id/runs/:runId", (req, res) => {
  const pipelineId = Number(req.params.id);
  const exists = db
    .prepare("SELECT id FROM pipelines WHERE id = ? AND user_id = ?")
    .get(pipelineId, req.user!.sub);
  if (!exists) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const row = db
    .prepare(
      `SELECT id, pipeline_id, status, started_at, finished_at,
              rows_loaded, log, error_message, triggered_by
       FROM pipeline_runs WHERE id = ? AND pipeline_id = ?`,
    )
    .get(req.params.runId, pipelineId);
  if (!row) {
    res.status(404).json({ error: "run not found" });
    return;
  }
  res.json(row);
});

pipelinesRouter.get("/:id/next-runs", (req, res) => {
  const row = db
    .prepare(
      "SELECT schedule, schedule_enabled FROM pipelines WHERE id = ? AND user_id = ?",
    )
    .get(req.params.id, req.user!.sub) as
    | { schedule: string | null; schedule_enabled: number }
    | undefined;
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (!row.schedule || row.schedule_enabled === 0) {
    res.json({ next: [] });
    return;
  }
  try {
    // Preview the next five firings so the user can sanity-check the
    // cron expression in the form.
    const it = cronParser.parseExpression(row.schedule, { currentDate: new Date() });
    const next: number[] = [];
    for (let i = 0; i < 5; i++) {
      next.push(Math.floor(it.next().toDate().getTime() / 1000));
    }
    res.json({ next });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});
