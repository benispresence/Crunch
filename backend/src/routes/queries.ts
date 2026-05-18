import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import { requireAuth } from "../middleware/auth.js";
import { pythonEngine } from "../services/pythonEngine.js";

export const queriesRouter = Router();
queriesRouter.use(requireAuth);

interface QueryRow {
  id: number;
  connection_id: number | null;
  folder_id: number | null;
  name: string;
  sql: string;
  chart_type: string;
  chart_renderer: string;
  chart_config_json: string;
  chart_python_code: string | null;
  chart_mode: string;
  created_at: number;
  updated_at: number;
}

interface ConnectionRow {
  id: number;
  type: string;
  config_json: string;
}

const SELECT_COLS = `
  id, connection_id, folder_id, name, sql,
  chart_type, chart_renderer, chart_config_json, chart_python_code, chart_mode,
  created_at, updated_at
`;

function rowToQuery(row: QueryRow) {
  return {
    id: row.id,
    connection_id: row.connection_id,
    folder_id: row.folder_id,
    name: row.name,
    sql: row.sql,
    chart_type: row.chart_type,
    chart_renderer: row.chart_renderer,
    chart_config: safeJson(row.chart_config_json),
    chart_python_code: row.chart_python_code,
    chart_mode: row.chart_mode,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function safeJson(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}

queriesRouter.get("/", (req, res) => {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM queries WHERE user_id = ? ORDER BY updated_at DESC`,
    )
    .all(req.user!.sub) as QueryRow[];
  res.json(rows.map(rowToQuery));
});

const chartFields = {
  chart_type: z.string().min(1).optional(),
  chart_renderer: z.string().min(1).optional(),
  chart_config: z.record(z.unknown()).optional(),
  chart_python_code: z.string().nullable().optional(),
  chart_mode: z.enum(["picker", "python"]).optional(),
};

queriesRouter.post("/", (req, res) => {
  const parsed = z
    .object({
      name: z.string().min(1),
      sql: z.string(),
      connection_id: z.number().nullable().optional(),
      folder_id: z.number().int().nullable().optional(),
      ...chartFields,
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const info = db
    .prepare(
      `INSERT INTO queries (
         user_id, connection_id, folder_id, name, sql,
         chart_type, chart_renderer, chart_config_json, chart_python_code, chart_mode
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      req.user!.sub,
      parsed.data.connection_id ?? null,
      parsed.data.folder_id ?? null,
      parsed.data.name,
      parsed.data.sql,
      parsed.data.chart_type ?? "bar",
      parsed.data.chart_renderer ?? "plotly",
      JSON.stringify(parsed.data.chart_config ?? {}),
      parsed.data.chart_python_code ?? null,
      parsed.data.chart_mode ?? "picker",
    );
  const row = db
    .prepare(`SELECT ${SELECT_COLS} FROM queries WHERE id = ?`)
    .get(info.lastInsertRowid) as QueryRow;
  res.json(rowToQuery(row));
});

queriesRouter.delete("/:id", (req, res) => {
  const result = db
    .prepare("DELETE FROM queries WHERE id = ? AND user_id = ?")
    .run(req.params.id, req.user!.sub);
  if (result.changes === 0) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ ok: true });
});

queriesRouter.put("/:id", (req, res) => {
  const parsed = z
    .object({
      name: z.string().optional(),
      sql: z.string().optional(),
      folder_id: z.number().int().nullable().optional(),
      connection_id: z.number().int().nullable().optional(),
      ...chartFields,
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const fields: string[] = [];
  const values: unknown[] = [];
  const push = (sql: string, v: unknown) => { fields.push(sql); values.push(v); };
  if (parsed.data.name !== undefined) push("name = ?", parsed.data.name);
  if (parsed.data.sql !== undefined) push("sql = ?", parsed.data.sql);
  if (parsed.data.folder_id !== undefined) push("folder_id = ?", parsed.data.folder_id);
  if (parsed.data.connection_id !== undefined) push("connection_id = ?", parsed.data.connection_id);
  if (parsed.data.chart_type !== undefined) push("chart_type = ?", parsed.data.chart_type);
  if (parsed.data.chart_renderer !== undefined) push("chart_renderer = ?", parsed.data.chart_renderer);
  if (parsed.data.chart_config !== undefined) push("chart_config_json = ?", JSON.stringify(parsed.data.chart_config));
  if (parsed.data.chart_python_code !== undefined) push("chart_python_code = ?", parsed.data.chart_python_code);
  if (parsed.data.chart_mode !== undefined) push("chart_mode = ?", parsed.data.chart_mode);
  if (fields.length === 0) { res.json({ ok: true }); return; }
  fields.push("updated_at = strftime('%s', 'now')");
  values.push(req.params.id, req.user!.sub);
  db.prepare(`UPDATE queries SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);
  const row = db
    .prepare(`SELECT ${SELECT_COLS} FROM queries WHERE id = ? AND user_id = ?`)
    .get(req.params.id, req.user!.sub) as QueryRow | undefined;
  res.json(row ? rowToQuery(row) : { ok: true });
});

queriesRouter.post("/validate", async (req, res) => {
  const parsed = z.object({ sql: z.string() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  res.json(await pythonEngine.validateSql(parsed.data.sql));
});

/**
 * Render a saved query into a chart spec. Runs the SQL against its
 * connection, then either evaluates the saved python code or renders
 * via the chart picker config. Used by dashboards.
 */
queriesRouter.post("/:id/render", async (req, res) => {
  const row = db
    .prepare(
      `SELECT id, connection_id, sql, chart_type, chart_renderer, chart_config_json,
              chart_python_code, chart_mode
       FROM queries WHERE id = ? AND user_id = ?`,
    )
    .get(req.params.id, req.user!.sub) as
    | (QueryRow & { chart_renderer: string })
    | undefined;
  if (!row) {
    res.status(404).json({ error: "query not found" });
    return;
  }
  if (!row.connection_id) {
    res.status(400).json({ error: "query has no connection" });
    return;
  }
  const conn = db
    .prepare("SELECT type, config_json FROM connections WHERE id = ? AND user_id = ?")
    .get(row.connection_id, req.user!.sub) as ConnectionRow | undefined;
  if (!conn) {
    res.status(404).json({ error: "connection not found" });
    return;
  }
  try {
    const sqlResult = await pythonEngine.executeSql({
      connection: { type: conn.type, ...JSON.parse(conn.config_json) },
      sql: row.sql,
      limit: 5000,
    });
    if (!sqlResult.success) {
      res.json({ success: false, error: sqlResult.error });
      return;
    }
    const data: Record<string, unknown[]> = {};
    sqlResult.columns.forEach((col, i) => {
      data[col] = sqlResult.rows.map((r) => r[i]);
    });
    if (row.chart_mode === "python" && row.chart_python_code) {
      const py = await pythonEngine.executePython({ code: row.chart_python_code, data });
      res.json({
        success: py.success, spec: py.spec, error: py.error,
        row_count: sqlResult.row_count,
      });
      return;
    }
    const chart = await pythonEngine.renderChart({
      chart_type: row.chart_type,
      renderer: row.chart_renderer,
      data,
      config: safeJson(row.chart_config_json),
    });
    res.json({
      success: chart.success, spec: chart.spec, error: chart.error,
      row_count: sqlResult.row_count,
    });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

queriesRouter.post("/execute", async (req, res) => {
  const parsed = z
    .object({
      connection_id: z.number(),
      sql: z.string(),
      limit: z.number().int().positive().max(50000).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const conn = db
    .prepare("SELECT id, type, config_json FROM connections WHERE id = ? AND user_id = ?")
    .get(parsed.data.connection_id, req.user!.sub) as ConnectionRow | undefined;
  if (!conn) {
    res.status(404).json({ error: "connection not found" });
    return;
  }
  const config = JSON.parse(conn.config_json);
  try {
    const result = await pythonEngine.executeSql({
      connection: { type: conn.type, ...config },
      sql: parsed.data.sql,
      limit: parsed.data.limit,
    });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});
