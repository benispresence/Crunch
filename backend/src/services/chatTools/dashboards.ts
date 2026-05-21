/**
 * Dashboard proposal tools. Same propose-then-accept flow as queries
 * — the UI renders cards and only mutates state on user confirmation.
 */

import { db } from "../../db/index.js";
import { safeParse, safeParseArr, type ToolHandler, type ToolModule } from "./types.js";

const list_dashboards: ToolHandler = (ctx) =>
  db.prepare(
    "SELECT id, name, description, folder_id, updated_at FROM dashboards WHERE user_id = ? ORDER BY updated_at DESC",
  ).all(ctx.userId);

const get_dashboard: ToolHandler = (ctx, input) => {
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
};

const propose_new_dashboard: ToolHandler = (_ctx, input) => ({
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
});

const propose_add_widget: ToolHandler = (ctx, input) => {
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
};

const propose_remove_widget: ToolHandler = (ctx, input) => {
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
};

const propose_dashboard_filter_change: ToolHandler = (ctx, input) => {
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
};

const propose_widget_mapping: ToolHandler = (ctx, input) => {
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
};

export const dashboardTools: ToolModule = {
  tools: [
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
  ],
  handlers: {
    list_dashboards, get_dashboard, propose_new_dashboard, propose_add_widget,
    propose_remove_widget, propose_dashboard_filter_change, propose_widget_mapping,
  },
};
