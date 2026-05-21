/**
 * Query + chart proposal tools. Every mutation is a *proposal* — the
 * UI renders an Accept/Reject card; nothing here writes the DB.
 */

import { db } from "../../db/index.js";
import { safeParse, type ToolHandler, type ToolModule } from "./types.js";

const list_saved_queries: ToolHandler = (ctx) => {
  const rows = db
    .prepare(
      `SELECT id, name, connection_id, folder_id, sql,
              chart_type, chart_mode, chart_config_json, chart_python_code
       FROM queries WHERE user_id = ? ORDER BY updated_at DESC`,
    )
    .all(ctx.userId) as Array<{
      id: number; name: string; connection_id: number | null; folder_id: number | null;
      sql: string; chart_type: string; chart_mode: string;
      chart_config_json: string; chart_python_code: string | null;
    }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    connection_id: r.connection_id,
    folder_id: r.folder_id,
    sql: r.sql,
    chart_type: r.chart_type,
    chart_mode: r.chart_mode,
    chart_config: safeParse(r.chart_config_json),
    chart_python_code: r.chart_python_code,
  }));
};

const propose_query_edit: ToolHandler = (ctx, input) => {
  const id = input.query_id as number;
  const row = db
    .prepare("SELECT id, name, sql FROM queries WHERE id = ? AND user_id = ?")
    .get(id, ctx.userId) as { id: number; name: string; sql: string } | undefined;
  if (!row) return { error: `query #${id} not found`, success: false };
  const newSql = (input.new_sql as string | undefined) ?? row.sql;
  const newName = (input.new_name as string | undefined) ?? row.name;
  return {
    success: true,
    proposal: {
      kind: "query_edit",
      query_id: row.id,
      rationale: input.rationale as string | undefined,
      before: { name: row.name, sql: row.sql },
      after: { name: newName, sql: newSql },
    },
  };
};

const propose_chart_change: ToolHandler = (ctx, input) => {
  const id = input.query_id as number;
  const row = db
    .prepare(
      `SELECT id, name, chart_type, chart_mode, chart_config_json, chart_python_code
       FROM queries WHERE id = ? AND user_id = ?`,
    )
    .get(id, ctx.userId) as {
      id: number; name: string; chart_type: string; chart_mode: string;
      chart_config_json: string; chart_python_code: string | null;
    } | undefined;
  if (!row) return { error: `query #${id} not found`, success: false };
  const before = {
    chart_type: row.chart_type,
    chart_mode: row.chart_mode,
    chart_config: safeParse(row.chart_config_json),
    chart_python_code: row.chart_python_code,
  };
  const after = {
    chart_type: (input.chart_type as string | undefined) ?? before.chart_type,
    chart_mode: (input.chart_mode as string | undefined) ?? before.chart_mode,
    chart_config: (input.chart_config as Record<string, unknown> | undefined) ?? before.chart_config,
    chart_python_code: (input.chart_python_code as string | undefined) ?? before.chart_python_code,
  };
  return {
    success: true,
    proposal: {
      kind: "chart_change",
      query_id: row.id,
      query_name: row.name,
      rationale: input.rationale as string | undefined,
      before, after,
    },
  };
};

const propose_new_query: ToolHandler = (_ctx, input) => ({
  success: true,
  proposal: {
    kind: "new_query",
    rationale: input.rationale as string | undefined,
    query: {
      name: input.name as string,
      sql: input.sql as string,
      connection_id: input.connection_id as number,
      folder_id: (input.folder_id as number | undefined) ?? null,
      chart_type: (input.chart_type as string | undefined) ?? "bar",
      chart_config: (input.chart_config as Record<string, unknown> | undefined) ?? {},
      chart_mode: (input.chart_mode as string | undefined) ?? "picker",
      chart_python_code: (input.chart_python_code as string | undefined) ?? null,
    },
  },
});

const propose_delete_query: ToolHandler = (ctx, input) => {
  const id = input.query_id as number;
  const row = db
    .prepare("SELECT id, name, sql FROM queries WHERE id = ? AND user_id = ?")
    .get(id, ctx.userId) as { id: number; name: string; sql: string } | undefined;
  if (!row) return { error: `query #${id} not found`, success: false };
  return {
    success: true,
    proposal: {
      kind: "delete_query",
      query_id: row.id,
      rationale: input.rationale as string | undefined,
      target: { name: row.name, sql: row.sql },
    },
  };
};

export const queryTools: ToolModule = {
  tools: [
    {
      name: "list_saved_queries",
      description:
        "List the user's saved queries (id, name, connection, chart settings). Call this before any propose_* tool so you can target the right query by id.",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "propose_query_edit",
      description:
        "Propose changes to an EXISTING saved query (SQL and/or name). Returns a proposal object that the UI renders as a Cursor-style diff with Accept/Reject. DOES NOT mutate the DB.",
      input_schema: {
        type: "object",
        properties: {
          query_id: { type: "number", description: "Id from list_saved_queries" },
          new_sql: { type: "string", description: "Replacement SQL. Omit to leave SQL unchanged." },
          new_name: { type: "string", description: "Replacement name. Omit to leave name unchanged." },
          rationale: { type: "string", description: "One-line explanation shown to the user above the diff." },
        },
        required: ["query_id"],
      },
    },
    {
      name: "propose_chart_change",
      description:
        "Propose changing the chart settings attached to an EXISTING saved query (chart_type / chart_config / python_code / chart_mode). Returns a proposal the UI renders for Accept/Reject. DOES NOT mutate the DB.",
      input_schema: {
        type: "object",
        properties: {
          query_id: { type: "number" },
          chart_type: { type: "string", description: "e.g. bar, line, scatter, pie, histogram" },
          chart_config: {
            type: "object",
            description: "Picker field bindings, e.g. {x: 'date', y: 'value'}",
            additionalProperties: { type: "string" },
          },
          chart_python_code: { type: "string", description: "Custom python code (sets `fig`). Switches mode to python." },
          chart_mode: { type: "string", description: "'picker' or 'python'" },
          rationale: { type: "string" },
        },
        required: ["query_id"],
      },
    },
    {
      name: "propose_new_query",
      description:
        "Propose creating a brand-new saved query (SQL + name + optional chart). Returns a proposal the UI renders with a preview and an Accept button. DOES NOT mutate the DB.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          sql: { type: "string" },
          connection_id: { type: "number", description: "Id from list_connections" },
          folder_id: { type: "number", description: "Optional folder/collection id" },
          chart_type: { type: "string" },
          chart_config: { type: "object", additionalProperties: { type: "string" } },
          chart_mode: { type: "string", description: "'picker' or 'python'" },
          chart_python_code: { type: "string" },
          rationale: { type: "string" },
        },
        required: ["name", "sql", "connection_id"],
      },
    },
    {
      name: "propose_delete_query",
      description:
        "Propose deleting an existing saved query. Returns a proposal the UI renders with a confirm prompt. DOES NOT mutate the DB.",
      input_schema: {
        type: "object",
        properties: {
          query_id: { type: "number" },
          rationale: { type: "string" },
        },
        required: ["query_id"],
      },
    },
  ],
  handlers: {
    list_saved_queries, propose_query_edit, propose_chart_change,
    propose_new_query, propose_delete_query,
  },
};
