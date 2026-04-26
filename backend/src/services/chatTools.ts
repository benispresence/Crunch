import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages.js";
import { db } from "../db/index.js";
import { pythonEngine } from "./pythonEngine.js";

export const chatTools: Tool[] = [
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
        chart_type: {
          type: "string",
          description: "line | bar | scatter | area | pie | histogram | heatmap",
        },
        x: { type: "string", description: "Column name for x axis" },
        y: { type: "string", description: "Column name for y axis (or numeric series)" },
        data: {
          type: "object",
          description: "Object mapping column name -> array of values",
          additionalProperties: { type: "array" },
        },
        title: { type: "string" },
      },
      required: ["chart_type", "data"],
    },
  },
  {
    name: "run_python",
    description:
      "Run user Python code in the sandbox to transform data or build a custom plotly figure. Code receives variable `data` (dict of lists) and should set variable `fig` to a plotly Figure.",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string" },
        data: {
          type: "object",
          additionalProperties: { type: "array" },
        },
      },
      required: ["code"],
    },
  },
];

export interface ToolContext {
  userId: number;
}

export async function runTool(
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "list_connections": {
      const rows = db
        .prepare("SELECT id, name, type FROM connections WHERE user_id = ?")
        .all(ctx.userId);
      return rows;
    }
    case "execute_sql": {
      const connId = input.connection_id as number;
      const sql = input.sql as string;
      const limit = (input.limit as number | undefined) ?? 1000;
      const conn = db
        .prepare("SELECT type, config_json FROM connections WHERE id = ? AND user_id = ?")
        .get(connId, ctx.userId) as { type: string; config_json: string } | undefined;
      if (!conn) return { error: "connection not found" };
      return await pythonEngine.executeSql({
        connection: { type: conn.type, ...JSON.parse(conn.config_json) },
        sql,
        limit,
      });
    }
    case "render_chart": {
      const chartType = input.chart_type as string;
      const data = input.data as Record<string, unknown[]>;
      const cfg: Record<string, unknown> = {};
      if (input.x) cfg.x = input.x;
      if (input.y) cfg.y = input.y;
      if (input.title) cfg.title = input.title;
      return await pythonEngine.renderChart({ chart_type: chartType, data, config: cfg });
    }
    case "run_python": {
      const code = input.code as string;
      const data = (input.data as Record<string, unknown[]> | undefined) ?? {};
      return await pythonEngine.executePython({ code, data });
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}
