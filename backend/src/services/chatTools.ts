import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages.js";
import { db } from "../db/index.js";
import { pythonEngine } from "./pythonEngine.js";

function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}

export const chatTools: Tool[] = [
  {
    name: "list_connections",
    description: "List all database connections the user has configured.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_saved_queries",
    description:
      "List the user's saved queries (id, name, connection, chart settings). Call this before any propose_* tool so you can target the right query by id.",
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
    case "list_saved_queries": {
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
    }
    case "propose_query_edit": {
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
    }
    case "propose_chart_change": {
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
    }
    case "propose_new_query": {
      return {
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
      };
    }
    case "propose_delete_query": {
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
