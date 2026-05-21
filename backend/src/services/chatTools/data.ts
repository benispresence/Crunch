/**
 * Data-execution tools: listing connections + running queries / charts
 * / Python through the engine. These are the building blocks; the
 * propose_* tools in the per-domain modules use them indirectly.
 */

import { db } from "../../db/index.js";
import { decryptConnectionConfig } from "../crypto.js";
import { pythonEngine } from "../pythonEngine.js";
import type { ToolHandler, ToolModule } from "./types.js";

const list_connections: ToolHandler = (ctx) =>
  db.prepare("SELECT id, name, type FROM connections WHERE user_id = ?").all(ctx.userId);

const execute_sql: ToolHandler = async (ctx, input) => {
  const connId = input.connection_id as number;
  const sql = input.sql as string;
  const limit = (input.limit as number | undefined) ?? 1000;
  const conn = db
    .prepare("SELECT type, config_json FROM connections WHERE id = ? AND user_id = ?")
    .get(connId, ctx.userId) as { type: string; config_json: string } | undefined;
  if (!conn) return { error: "connection not found" };
  return await pythonEngine.executeSql({
    connection: { type: conn.type, ...decryptConnectionConfig(JSON.parse(conn.config_json)) },
    sql,
    limit,
  });
};

const render_chart: ToolHandler = async (_ctx, input) => {
  const chartType = input.chart_type as string;
  const data = input.data as Record<string, unknown[]>;
  const cfg: Record<string, unknown> = {};
  if (input.x) cfg.x = input.x;
  if (input.y) cfg.y = input.y;
  if (input.title) cfg.title = input.title;
  return await pythonEngine.renderChart({ chart_type: chartType, data, config: cfg });
};

const run_python: ToolHandler = async (_ctx, input) => {
  const code = input.code as string;
  const data = (input.data as Record<string, unknown[]> | undefined) ?? {};
  return await pythonEngine.executePython({ code, data });
};

export const dataTools: ToolModule = {
  tools: [
    {
      name: "list_connections",
      description: "List all database connections the user has configured.",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "execute_sql",
      description:
        "Execute a read-only SQL query against one of the user's connections. Returns columns and rows. Always prefer LIMIT clauses for exploratory queries.",
      input_schema: {
        type: "object",
        properties: {
          connection_id: { type: "number", description: "Id from list_connections" },
          sql: { type: "string", description: "SELECT-only SQL" },
          limit: { type: "number", description: "Max rows (default 1000)" },
        },
        required: ["connection_id", "sql"],
      },
    },
    {
      name: "render_chart",
      description:
        "Render a chart from data returned by a previous execute_sql call. Returns a Plotly spec the UI can display.",
      input_schema: {
        type: "object",
        properties: {
          chart_type: { type: "string", description: "line | bar | scatter | area | pie | histogram | heatmap" },
          x: { type: "string", description: "Column name for x axis" },
          y: { type: "string", description: "Column name for y axis (or numeric series)" },
          data: { type: "object", description: "Object mapping column name -> array of values", additionalProperties: { type: "array" } },
          title: { type: "string" },
        },
        required: ["chart_type", "data"],
      },
    },
    {
      name: "run_python",
      description:
        "Run user Python code in the sandbox to transform data or build a custom plotly figure. Code receives variable `df` (pandas DataFrame) and should assign a plotly Figure to variable `fig`.",
      input_schema: {
        type: "object",
        properties: {
          code: { type: "string" },
          data: { type: "object", additionalProperties: { type: "array" } },
        },
        required: ["code"],
      },
    },
  ],
  handlers: { list_connections, execute_sql, render_chart, run_python },
};
