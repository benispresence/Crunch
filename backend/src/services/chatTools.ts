import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages.js";
import { db } from "../db/index.js";
import { decryptConnectionConfig } from "./crypto.js";
import { pythonEngine } from "./pythonEngine.js";

function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}

function safeParseArr(s: string): unknown[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
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
  // --- Dashboard tools -----------------------------------------------------
  {
    name: "list_dashboards",
    description:
      "List the user's saved dashboards (id, name, description). Call this before any propose_dashboard_* tool so you can target the right dashboard by id.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_dashboard",
    description:
      "Fetch a dashboard's full state: filters, widgets (with their underlying query, position, parameter mapping). Use before proposing widget/filter edits so you can compute exact deltas.",
    input_schema: {
      type: "object",
      properties: { dashboard_id: { type: "number" } },
      required: ["dashboard_id"],
    },
  },
  {
    name: "propose_new_dashboard",
    description:
      "Propose creating a brand-new dashboard with optional initial widgets and filters. Each widget references an existing saved query by id (use list_saved_queries first). DOES NOT mutate the DB.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        folder_id: { type: "number" },
        widgets: {
          type: "array",
          description: "Optional initial chart widgets",
          items: {
            type: "object",
            properties: {
              query_id: { type: "number" },
              position_x: { type: "number" },
              position_y: { type: "number" },
              width: { type: "number" },
              height: { type: "number" },
              title_override: { type: "string" },
            },
            required: ["query_id"],
          },
        },
        filters: {
          type: "array",
          description: "Optional initial dashboard-level filters",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string", description: "text | number | date | boolean" },
              default: {},
            },
            required: ["name"],
          },
        },
        rationale: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "propose_add_widget",
    description:
      "Propose adding a chart (a saved query) to an existing dashboard. Optionally pre-wire parameter mappings from dashboard filters to query variables. DOES NOT mutate the DB.",
    input_schema: {
      type: "object",
      properties: {
        dashboard_id: { type: "number" },
        query_id: { type: "number" },
        position_x: { type: "number" },
        position_y: { type: "number" },
        width: { type: "number", description: "1-12 grid cells (default 6)" },
        height: { type: "number", description: "1-20 grid rows (default 4)" },
        title_override: { type: "string" },
        parameter_mappings: {
          type: "object",
          description: "Object of {dashboard_filter_id: query_variable_name}",
          additionalProperties: { type: "string" },
        },
        rationale: { type: "string" },
      },
      required: ["dashboard_id", "query_id"],
    },
  },
  {
    name: "propose_remove_widget",
    description:
      "Propose removing a widget from an existing dashboard. DOES NOT mutate the DB.",
    input_schema: {
      type: "object",
      properties: {
        dashboard_id: { type: "number" },
        widget_id: { type: "number" },
        rationale: { type: "string" },
      },
      required: ["dashboard_id", "widget_id"],
    },
  },
  {
    name: "propose_dashboard_filter_change",
    description:
      "Propose replacing the full filter set on a dashboard (add, remove, edit, or reorder). Pass the entire new array — partial diffs aren't supported. DOES NOT mutate the DB.",
    input_schema: {
      type: "object",
      properties: {
        dashboard_id: { type: "number" },
        filters: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable id; reuse for existing filters" },
              name: { type: "string" },
              type: { type: "string" },
              default: {},
            },
            required: ["id", "name"],
          },
        },
        rationale: { type: "string" },
      },
      required: ["dashboard_id", "filters"],
    },
  },
  {
    name: "propose_widget_mapping",
    description:
      "Propose updating the parameter_mappings on a single widget (which dashboard filter feeds which query variable). DOES NOT mutate the DB.",
    input_schema: {
      type: "object",
      properties: {
        dashboard_id: { type: "number" },
        widget_id: { type: "number" },
        parameter_mappings: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        rationale: { type: "string" },
      },
      required: ["dashboard_id", "widget_id", "parameter_mappings"],
    },
  },
  {
    name: "propose_navigate",
    description:
      "Propose moving the user's UI to either the workspace (optionally opening a specific saved query) or a dashboard detail page. Use this when the natural next step is to look at something in a different surface — e.g. after creating a query, jump to it in the workspace, or after building widgets, open the dashboard. With auto-accept on, navigation happens immediately.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "'workspace' or 'dashboard'" },
        query_id: { type: "number", description: "If to=workspace, the saved query to open" },
        dashboard_id: { type: "number", description: "If to=dashboard, the dashboard to open" },
        rationale: { type: "string" },
      },
      required: ["to"],
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
    case "list_dashboards": {
      const rows = db
        .prepare(
          "SELECT id, name, description, folder_id, updated_at FROM dashboards WHERE user_id = ? ORDER BY updated_at DESC",
        )
        .all(ctx.userId);
      return rows;
    }
    case "get_dashboard": {
      const id = input.dashboard_id as number;
      const dash = db
        .prepare(
          "SELECT id, name, description, layout_json, filters_json FROM dashboards WHERE id = ? AND user_id = ?",
        )
        .get(id, ctx.userId) as
        | { id: number; name: string; description: string | null; layout_json: string; filters_json: string }
        | undefined;
      if (!dash) return { error: `dashboard #${id} not found`, success: false };
      const widgets = db
        .prepare(
          `SELECT w.id, w.query_id, w.visualization_id, w.position_x, w.position_y,
                  w.width, w.height, w.title_override, w.parameter_mappings_json,
                  COALESCE(q.name, v.name) AS source_name,
                  q.parameters_json AS query_parameters_json
           FROM dashboard_widgets w
           LEFT JOIN queries q ON q.id = w.query_id
           LEFT JOIN visualizations v ON v.id = w.visualization_id
           WHERE w.dashboard_id = ?
           ORDER BY w.id`,
        )
        .all(id) as Array<{
          id: number; query_id: number | null; visualization_id: number | null;
          position_x: number; position_y: number; width: number; height: number;
          title_override: string | null; parameter_mappings_json: string;
          source_name: string | null; query_parameters_json: string | null;
        }>;
      return {
        id: dash.id,
        name: dash.name,
        description: dash.description,
        layout: safeParse(dash.layout_json),
        filters: safeParseArr(dash.filters_json),
        widgets: widgets.map((w) => ({
          id: w.id,
          query_id: w.query_id,
          visualization_id: w.visualization_id,
          source_name: w.source_name,
          position_x: w.position_x,
          position_y: w.position_y,
          width: w.width,
          height: w.height,
          title_override: w.title_override,
          parameter_mappings: safeParse(w.parameter_mappings_json),
          query_parameters: safeParseArr(w.query_parameters_json ?? "[]"),
        })),
      };
    }
    case "propose_new_dashboard": {
      return {
        success: true,
        proposal: {
          kind: "new_dashboard",
          rationale: input.rationale as string | undefined,
          dashboard: {
            name: input.name as string,
            description: (input.description as string | undefined) ?? null,
            folder_id: (input.folder_id as number | undefined) ?? null,
            widgets: ((input.widgets as Array<Record<string, unknown>> | undefined) ?? []).map((w) => ({
              query_id: Number(w.query_id),
              position_x: Number(w.position_x ?? 0),
              position_y: Number(w.position_y ?? 0),
              width: Number(w.width ?? 6),
              height: Number(w.height ?? 4),
              title_override: (w.title_override as string | undefined) ?? null,
            })),
            filters: ((input.filters as Array<Record<string, unknown>> | undefined) ?? []).map((f, i) => ({
              id: (f.id as string | undefined) ?? `f_${Date.now().toString(36)}_${i}`,
              name: String(f.name),
              type: (f.type as string | undefined) ?? "text",
              default: f.default ?? null,
            })),
          },
        },
      };
    }
    case "propose_add_widget": {
      const dashId = input.dashboard_id as number;
      const queryId = input.query_id as number;
      const dash = db
        .prepare("SELECT name FROM dashboards WHERE id = ? AND user_id = ?")
        .get(dashId, ctx.userId) as { name: string } | undefined;
      if (!dash) return { error: `dashboard #${dashId} not found`, success: false };
      const q = db
        .prepare("SELECT name FROM queries WHERE id = ? AND user_id = ?")
        .get(queryId, ctx.userId) as { name: string } | undefined;
      if (!q) return { error: `query #${queryId} not found`, success: false };
      return {
        success: true,
        proposal: {
          kind: "add_widget",
          dashboard_id: dashId,
          dashboard_name: dash.name,
          rationale: input.rationale as string | undefined,
          widget: {
            query_id: queryId,
            query_name: q.name,
            position_x: (input.position_x as number | undefined) ?? 0,
            position_y: (input.position_y as number | undefined) ?? 0,
            width: (input.width as number | undefined) ?? 6,
            height: (input.height as number | undefined) ?? 4,
            title_override: (input.title_override as string | undefined) ?? null,
            parameter_mappings:
              (input.parameter_mappings as Record<string, string> | undefined) ?? {},
          },
        },
      };
    }
    case "propose_remove_widget": {
      const dashId = input.dashboard_id as number;
      const widgetId = input.widget_id as number;
      const dash = db
        .prepare("SELECT name FROM dashboards WHERE id = ? AND user_id = ?")
        .get(dashId, ctx.userId) as { name: string } | undefined;
      if (!dash) return { error: `dashboard #${dashId} not found`, success: false };
      const widget = db
        .prepare(
          `SELECT w.id, COALESCE(q.name, v.name) AS source_name
           FROM dashboard_widgets w
           LEFT JOIN queries q ON q.id = w.query_id
           LEFT JOIN visualizations v ON v.id = w.visualization_id
           WHERE w.id = ? AND w.dashboard_id = ?`,
        )
        .get(widgetId, dashId) as { id: number; source_name: string | null } | undefined;
      if (!widget) return { error: `widget #${widgetId} not found`, success: false };
      return {
        success: true,
        proposal: {
          kind: "remove_widget",
          dashboard_id: dashId,
          dashboard_name: dash.name,
          widget_id: widgetId,
          widget_name: widget.source_name ?? `#${widgetId}`,
          rationale: input.rationale as string | undefined,
        },
      };
    }
    case "propose_dashboard_filter_change": {
      const dashId = input.dashboard_id as number;
      const dash = db
        .prepare("SELECT name, filters_json FROM dashboards WHERE id = ? AND user_id = ?")
        .get(dashId, ctx.userId) as { name: string; filters_json: string } | undefined;
      if (!dash) return { error: `dashboard #${dashId} not found`, success: false };
      return {
        success: true,
        proposal: {
          kind: "dashboard_filter_change",
          dashboard_id: dashId,
          dashboard_name: dash.name,
          rationale: input.rationale as string | undefined,
          before: safeParseArr(dash.filters_json),
          after: input.filters,
        },
      };
    }
    case "propose_widget_mapping": {
      const dashId = input.dashboard_id as number;
      const widgetId = input.widget_id as number;
      const row = db
        .prepare(
          `SELECT w.parameter_mappings_json,
                  COALESCE(q.name, v.name) AS source_name,
                  d.name AS dashboard_name
           FROM dashboard_widgets w
           JOIN dashboards d ON d.id = w.dashboard_id
           LEFT JOIN queries q ON q.id = w.query_id
           LEFT JOIN visualizations v ON v.id = w.visualization_id
           WHERE w.id = ? AND w.dashboard_id = ? AND d.user_id = ?`,
        )
        .get(widgetId, dashId, ctx.userId) as
        | { parameter_mappings_json: string; source_name: string | null; dashboard_name: string }
        | undefined;
      if (!row) return { error: `widget #${widgetId} not found`, success: false };
      return {
        success: true,
        proposal: {
          kind: "widget_mapping",
          dashboard_id: dashId,
          dashboard_name: row.dashboard_name,
          widget_id: widgetId,
          widget_name: row.source_name ?? `#${widgetId}`,
          rationale: input.rationale as string | undefined,
          before: safeParse(row.parameter_mappings_json),
          after: input.parameter_mappings,
        },
      };
    }
    case "propose_navigate": {
      return {
        success: true,
        proposal: {
          kind: "navigate",
          to: input.to as string,
          query_id: input.query_id as number | undefined,
          dashboard_id: input.dashboard_id as number | undefined,
          rationale: input.rationale as string | undefined,
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
        connection: { type: conn.type, ...decryptConnectionConfig(JSON.parse(conn.config_json)) },
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
