/**
 * Pipeline proposal tools. Mirrors the query/dashboard pattern: list +
 * get for discovery, propose_* for every mutation. Extended with schema
 * inspection, validation, run-log retrieval, version comparison, and
 * failure diagnosis.
 */

import { db } from "../../db/index.js";
import { explainFailure, stripSecretsFromConfig } from "../pipelineOps.js";
import {
  aiSafePipeline,
  diffVersions,
  inspectConnectionSchema,
  validatePipeline,
} from "../pipelineRuntime.js";
import { safeParse, type ToolHandler, type ToolModule } from "./types.js";

const list_pipelines: ToolHandler = (ctx) =>
  db.prepare(
    `SELECT id, name, description, source_type, load_mode,
            destination_connection_id, destination_dataset,
            schedule, schedule_enabled,
            last_run_status, last_run_at
     FROM pipelines WHERE user_id = ? ORDER BY updated_at DESC`,
  ).all(ctx.userId);

const get_pipeline: ToolHandler = (ctx, input) => {
  const id = input.pipeline_id as number;
  const row = db
    .prepare(
      `SELECT id, name, description, source_type, source_config_json,
              destination_connection_id, destination_dataset,
              load_mode, primary_key, cursor_field,
              python_code, code_mode,
              schedule, schedule_enabled,
              stream_max_seconds, stream_max_messages,
              last_run_id, last_run_status, last_run_at
       FROM pipelines WHERE id = ? AND user_id = ?`,
    )
    .get(id, ctx.userId) as
    | {
        id: number; name: string; description: string | null;
        source_type: string; source_config_json: string;
        destination_connection_id: number | null; destination_dataset: string | null;
        load_mode: string; primary_key: string | null; cursor_field: string | null;
        python_code: string; code_mode: string;
        schedule: string | null; schedule_enabled: number;
        stream_max_seconds: number; stream_max_messages: number;
        last_run_id: number | null; last_run_status: string | null;
        last_run_at: number | null;
      }
    | undefined;
  if (!row) return { error: `pipeline #${id} not found`, success: false };
  const recent = db
    .prepare(
      `SELECT id, status, started_at, finished_at, rows_loaded,
              error_message, triggered_by, version_id, attempt_number
       FROM pipeline_runs WHERE pipeline_id = ?
       ORDER BY id DESC LIMIT 10`,
    )
    .all(id);
  const safe = aiSafePipeline(row as unknown as Record<string, unknown>);
  return {
    ...safe,
    source_config: stripSecretsFromConfig(safeParse(row.source_config_json)).sanitized,
    schedule_enabled: !!row.schedule_enabled,
    recent_runs: recent,
  };
};

const inspect_connection_schema: ToolHandler = async (ctx, input) => {
  const id = input.connection_id as number;
  try {
    return await inspectConnectionSchema(db, id, ctx.userId);
  } catch (e) {
    return { error: (e as Error).message, success: false };
  }
};

const validate_pipeline: ToolHandler = (ctx, input) => {
  const id = input.pipeline_id as number;
  try {
    return validatePipeline(db, id, ctx.userId);
  } catch (e) {
    return { error: (e as Error).message, success: false };
  }
};

const get_pipeline_run_logs: ToolHandler = (ctx, input) => {
  const pipelineId = input.pipeline_id as number;
  const runId = input.run_id as number;
  const owned = db
    .prepare("SELECT name FROM pipelines WHERE id = ? AND user_id = ?")
    .get(pipelineId, ctx.userId) as { name: string } | undefined;
  if (!owned) return { error: `pipeline #${pipelineId} not found`, success: false };
  const run = db
    .prepare(
      `SELECT id, status, log, error_message, version_id, triggered_by,
              attempt_number, started_at, finished_at
       FROM pipeline_runs WHERE id = ? AND pipeline_id = ?`,
    )
    .get(runId, pipelineId) as Record<string, unknown> | undefined;
  if (!run) return { error: `run #${runId} not found`, success: false };
  const attempts = db
    .prepare(
      `SELECT attempt_number, status, log, error_message, started_at, finished_at
       FROM pipeline_run_attempts WHERE run_id = ? ORDER BY attempt_number`,
    )
    .all(runId);
  return { ...run, attempts };
};

const compare_pipeline_versions: ToolHandler = (ctx, input) => {
  const pipelineId = input.pipeline_id as number;
  const owned = db
    .prepare("SELECT id FROM pipelines WHERE id = ? AND user_id = ?")
    .get(pipelineId, ctx.userId);
  if (!owned) return { error: `pipeline #${pipelineId} not found`, success: false };
  try {
    return diffVersions(
      db,
      pipelineId,
      input.from_version_id as number,
      input.to_version_id as number,
    );
  } catch (e) {
    return { error: (e as Error).message, success: false };
  }
};

const diagnose_pipeline_failure: ToolHandler = (ctx, input) => {
  const pipelineId = input.pipeline_id as number;
  const runId = input.run_id as number;
  const pipe = db
    .prepare("SELECT name, last_successful_update FROM pipelines WHERE id = ? AND user_id = ?")
    .get(pipelineId, ctx.userId) as
    | { name: string; last_successful_update: number | null }
    | undefined;
  if (!pipe) return { error: `pipeline #${pipelineId} not found`, success: false };
  const run = db
    .prepare(
      `SELECT log, error_message, next_retry_at FROM pipeline_runs
       WHERE id = ? AND pipeline_id = ?`,
    )
    .get(runId, pipelineId) as
    | { log: string; error_message: string | null; next_retry_at: number | null }
    | undefined;
  if (!run) return { error: `run #${runId} not found`, success: false };
  const explanation = explainFailure({
    error: run.error_message,
    log: run.log || "",
    lastSuccessfulUpdate: pipe.last_successful_update,
    retryAt: run.next_retry_at,
    pipelineName: pipe.name,
  });
  return { success: true, ...explanation };
};

const propose_new_pipeline: ToolHandler = (_ctx, input) => ({
  success: true,
  proposal: {
    kind: "new_pipeline",
    rationale: input.rationale as string | undefined,
    pipeline: {
      name: input.name as string,
      description: (input.description as string | undefined) ?? null,
      source_type: (input.source_type as string | undefined) ?? "custom",
      source_config: (input.source_config as Record<string, unknown> | undefined) ?? {},
      destination_connection_id: (input.destination_connection_id as number | undefined) ?? null,
      destination_dataset: (input.destination_dataset as string | undefined) ?? null,
      load_mode: (input.load_mode as string | undefined) ?? "replace",
      extract_strategy: (input.extract_strategy as string | undefined) ?? undefined,
      write_behavior: (input.write_behavior as string | undefined) ?? undefined,
      primary_key: (input.primary_key as string | undefined) ?? null,
      cursor_field: (input.cursor_field as string | undefined) ?? null,
      timezone: (input.timezone as string | undefined) ?? "UTC",
      quality_checks: (input.quality_checks as unknown[] | undefined) ?? [],
      tags: (input.tags as string[] | undefined) ?? [],
      recovery: (input.recovery as Record<string, unknown> | undefined) ?? {
        retries: "bounded, transient failures",
      },
      schedule: (input.schedule as string | undefined) ?? null,
      schedule_enabled: !!input.schedule_enabled,
      python_code: (input.python_code as string | undefined) ?? "",
      code_mode: (input.code_mode as string | undefined) ?? "template",
    },
  },
});

const propose_pipeline_edit: ToolHandler = (ctx, input) => {
  const id = input.pipeline_id as number;
  const row = db
    .prepare(
      `SELECT id, name, source_type, load_mode, python_code,
              destination_connection_id, schedule, schedule_enabled
       FROM pipelines WHERE id = ? AND user_id = ?`,
    )
    .get(id, ctx.userId) as
    | {
        id: number; name: string; source_type: string; load_mode: string;
        python_code: string; destination_connection_id: number | null;
        schedule: string | null; schedule_enabled: number;
      }
    | undefined;
  if (!row) return { error: `pipeline #${id} not found`, success: false };
  const patch: Record<string, unknown> = {};
  for (const k of [
    "name", "description", "source_type", "source_config",
    "destination_connection_id", "destination_dataset",
    "load_mode", "extract_strategy", "write_behavior",
    "primary_key", "cursor_field",
    "schedule", "schedule_enabled", "timezone",
    "python_code", "code_mode", "quality_checks", "tags",
  ]) {
    if (input[k] !== undefined) patch[k] = input[k];
  }
  return {
    success: true,
    proposal: {
      kind: "pipeline_edit",
      pipeline_id: row.id,
      pipeline_name: row.name,
      rationale: input.rationale as string | undefined,
      before: row,
      after: patch,
    },
  };
};

const propose_run_pipeline: ToolHandler = (ctx, input) => {
  const id = input.pipeline_id as number;
  const row = db
    .prepare("SELECT id, name FROM pipelines WHERE id = ? AND user_id = ?")
    .get(id, ctx.userId) as { id: number; name: string } | undefined;
  if (!row) return { error: `pipeline #${id} not found`, success: false };
  return {
    success: true,
    proposal: {
      kind: "run_pipeline",
      pipeline_id: row.id,
      pipeline_name: row.name,
      rationale: input.rationale as string | undefined,
    },
  };
};

const propose_delete_pipeline: ToolHandler = (ctx, input) => {
  const id = input.pipeline_id as number;
  const row = db
    .prepare("SELECT id, name FROM pipelines WHERE id = ? AND user_id = ?")
    .get(id, ctx.userId) as { id: number; name: string } | undefined;
  if (!row) return { error: `pipeline #${id} not found`, success: false };
  return {
    success: true,
    proposal: {
      kind: "delete_pipeline",
      pipeline_id: row.id,
      pipeline_name: row.name,
      rationale: input.rationale as string | undefined,
    },
  };
};

export const pipelineTools: ToolModule = {
  tools: [
    {
      name: "inspect_connection_schema",
      description:
        "Inspect tables/schemas on a saved connection. Call this when proposing a pipeline so Source/Destination map to real tables. Does not return credentials.",
      input_schema: {
        type: "object",
        properties: { connection_id: { type: "number" } },
        required: ["connection_id"],
      },
    },
    {
      name: "validate_pipeline",
      description:
        "Validate a pipeline's configuration (extract vs write, keys, destination) and that destination credentials resolve. DOES NOT run a load.",
      input_schema: {
        type: "object",
        properties: { pipeline_id: { type: "number" } },
        required: ["pipeline_id"],
      },
    },
    {
      name: "get_pipeline_run_logs",
      description:
        "Fetch one run's logs, attempts, version, trigger, and timestamps. Use before diagnose_pipeline_failure.",
      input_schema: {
        type: "object",
        properties: {
          pipeline_id: { type: "number" },
          run_id: { type: "number" },
        },
        required: ["pipeline_id", "run_id"],
      },
    },
    {
      name: "compare_pipeline_versions",
      description:
        "Readable config + code diff between two published pipeline versions.",
      input_schema: {
        type: "object",
        properties: {
          pipeline_id: { type: "number" },
          from_version_id: { type: "number" },
          to_version_id: { type: "number" },
        },
        required: ["pipeline_id", "from_version_id", "to_version_id"],
      },
    },
    {
      name: "diagnose_pipeline_failure",
      description:
        "Explain a failed run using its logs. Labels the cause as likely vs confirmed and cites log evidence. Does not mutate state.",
      input_schema: {
        type: "object",
        properties: {
          pipeline_id: { type: "number" },
          run_id: { type: "number" },
        },
        required: ["pipeline_id", "run_id"],
      },
    },
    {
      name: "list_pipelines",
      description:
        "List the user's data pipelines (id, name, source_type, load_mode, destination, last_run_status). Call before any propose_pipeline_* tool.",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "get_pipeline",
      description:
        "Fetch one pipeline's full configuration including its Python code, schedule, and recent runs. Use this to read the current state before proposing edits.",
      input_schema: {
        type: "object",
        properties: { pipeline_id: { type: "number" } },
        required: ["pipeline_id"],
      },
    },
    {
      name: "propose_new_pipeline",
      description:
        "Propose creating a new data pipeline. Accepts source_type (rest_api/sql/file/kafka/custom), load_mode (replace/append/merge/incremental/streaming), destination_connection_id (from list_connections), optional schedule (cron). The python_code is auto-generated by the engine from these inputs unless you supply your own; you can switch to code_mode='custom' to opt out of regeneration. DOES NOT mutate the DB.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          source_type: { type: "string", description: "rest_api | sql | file | kafka | custom" },
          source_config: { type: "object" },
          destination_connection_id: { type: "number" },
          destination_dataset: { type: "string" },
          load_mode: { type: "string", description: "legacy combined mode; prefer extract_strategy + write_behavior" },
          extract_strategy: { type: "string", description: "full | incremental | streaming (independent of write)" },
          write_behavior: { type: "string", description: "replace | append | merge (independent of extract)" },
          primary_key: { type: "string" },
          cursor_field: { type: "string" },
          timezone: { type: "string" },
          quality_checks: { type: "array", items: { type: "object" } },
          tags: { type: "array", items: { type: "string" } },
          recovery: { type: "object" },
          schedule: { type: "string", description: "5-field cron expression, optional" },
          schedule_enabled: { type: "boolean" },
          python_code: { type: "string", description: "Override the auto-generated template" },
          code_mode: { type: "string", description: "'template' (default) or 'custom'" },
          rationale: { type: "string" },
        },
        required: ["name"],
      },
    },
    {
      name: "propose_pipeline_edit",
      description:
        "Propose changes to an existing pipeline. Only fields you set are changed; leave python_code unset to auto-regenerate from the form when code_mode='template'. DOES NOT mutate the DB.",
      input_schema: {
        type: "object",
        properties: {
          pipeline_id: { type: "number" },
          name: { type: "string" },
          description: { type: "string" },
          source_type: { type: "string" },
          source_config: { type: "object" },
          destination_connection_id: { type: "number" },
          destination_dataset: { type: "string" },
          load_mode: { type: "string" },
          primary_key: { type: "string" },
          cursor_field: { type: "string" },
          schedule: { type: "string" },
          schedule_enabled: { type: "boolean" },
          python_code: { type: "string" },
          code_mode: { type: "string" },
          rationale: { type: "string" },
        },
        required: ["pipeline_id"],
      },
    },
    {
      name: "propose_run_pipeline",
      description:
        "Propose triggering an immediate pipeline run. Useful right after creating or editing a pipeline so the user can see it land data without leaving the chat. DOES NOT run automatically.",
      input_schema: {
        type: "object",
        properties: {
          pipeline_id: { type: "number" },
          rationale: { type: "string" },
        },
        required: ["pipeline_id"],
      },
    },
    {
      name: "propose_delete_pipeline",
      description:
        "Propose deleting a pipeline. Run history is removed with it. DOES NOT mutate the DB.",
      input_schema: {
        type: "object",
        properties: {
          pipeline_id: { type: "number" },
          rationale: { type: "string" },
        },
        required: ["pipeline_id"],
      },
    },
  ],
  handlers: {
    list_pipelines, get_pipeline, propose_new_pipeline,
    propose_pipeline_edit, propose_run_pipeline, propose_delete_pipeline,
    inspect_connection_schema, validate_pipeline, get_pipeline_run_logs,
    compare_pipeline_versions, diagnose_pipeline_failure,
  },
};
