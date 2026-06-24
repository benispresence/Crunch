/**
 * Pipeline proposal tools. Mirrors the query/dashboard pattern: list +
 * get for discovery, propose_* for every mutation.
 */

import { db } from "../../db/index.js";
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
              error_message, triggered_by
       FROM pipeline_runs WHERE pipeline_id = ?
       ORDER BY id DESC LIMIT 10`,
    )
    .all(id);
  return {
    ...row,
    source_config: safeParse(row.source_config_json),
    schedule_enabled: !!row.schedule_enabled,
    recent_runs: recent,
  };
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
      primary_key: (input.primary_key as string | undefined) ?? null,
      cursor_field: (input.cursor_field as string | undefined) ?? null,
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
    "load_mode", "primary_key", "cursor_field",
    "schedule", "schedule_enabled",
    "python_code", "code_mode",
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
          load_mode: { type: "string", description: "replace | append | merge | incremental | streaming" },
          primary_key: { type: "string" },
          cursor_field: { type: "string" },
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
  },
};
