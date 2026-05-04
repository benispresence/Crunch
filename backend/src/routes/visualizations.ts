import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import { requireAuth } from "../middleware/auth.js";
import { pythonEngine } from "../services/pythonEngine.js";

export const visualizationsRouter = Router();
visualizationsRouter.use(requireAuth);

interface VizRow {
  id: number;
  user_id: number;
  connection_id: number | null;
  name: string;
  sql: string;
  chart_type: string;
  renderer: string;
  config_json: string;
  python_code: string | null;
  created_at: number;
  updated_at: number;
}

function rowToViz(row: VizRow) {
  return {
    id: row.id,
    connection_id: row.connection_id,
    name: row.name,
    sql: row.sql,
    chart_type: row.chart_type,
    renderer: row.renderer,
    config: JSON.parse(row.config_json),
    python_code: row.python_code,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const upsertSchema = z.object({
  name: z.string().min(1),
  connection_id: z.number().int().nullable(),
  sql: z.string().min(1),
  chart_type: z.string().min(1),
  renderer: z.string().optional(),
  config: z.record(z.unknown()).optional(),
  python_code: z.string().nullable().optional(),
});

visualizationsRouter.get("/", (req, res) => {
  const rows = db
    .prepare("SELECT * FROM visualizations WHERE user_id = ? ORDER BY updated_at DESC")
    .all(req.user!.sub) as VizRow[];
  res.json(rows.map(rowToViz));
});

visualizationsRouter.get("/:id", (req, res) => {
  const row = db
    .prepare("SELECT * FROM visualizations WHERE id = ? AND user_id = ?")
    .get(req.params.id, req.user!.sub) as VizRow | undefined;
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(rowToViz(row));
});

visualizationsRouter.post("/", (req, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const info = db
    .prepare(
      "INSERT INTO visualizations (user_id, connection_id, name, sql, chart_type, renderer, config_json, python_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      req.user!.sub,
      parsed.data.connection_id,
      parsed.data.name,
      parsed.data.sql,
      parsed.data.chart_type,
      parsed.data.renderer ?? "plotly",
      JSON.stringify(parsed.data.config ?? {}),
      parsed.data.python_code ?? null,
    );
  res.json({ id: Number(info.lastInsertRowid) });
});

visualizationsRouter.put("/:id", (req, res) => {
  const parsed = upsertSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const fields: string[] = [];
  const values: unknown[] = [];
  if (parsed.data.name !== undefined) {
    fields.push("name = ?");
    values.push(parsed.data.name);
  }
  if (parsed.data.connection_id !== undefined) {
    fields.push("connection_id = ?");
    values.push(parsed.data.connection_id);
  }
  if (parsed.data.sql !== undefined) {
    fields.push("sql = ?");
    values.push(parsed.data.sql);
  }
  if (parsed.data.chart_type !== undefined) {
    fields.push("chart_type = ?");
    values.push(parsed.data.chart_type);
  }
  if (parsed.data.renderer !== undefined) {
    fields.push("renderer = ?");
    values.push(parsed.data.renderer);
  }
  if (parsed.data.config !== undefined) {
    fields.push("config_json = ?");
    values.push(JSON.stringify(parsed.data.config));
  }
  if (parsed.data.python_code !== undefined) {
    fields.push("python_code = ?");
    values.push(parsed.data.python_code);
  }
  if (fields.length === 0) {
    res.json({ ok: true });
    return;
  }
  fields.push("updated_at = strftime('%s', 'now')");
  values.push(req.params.id, req.user!.sub);
  db.prepare(
    `UPDATE visualizations SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`,
  ).run(...values);
  res.json({ ok: true });
});

visualizationsRouter.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM visualizations WHERE id = ? AND user_id = ?").run(
    req.params.id,
    req.user!.sub,
  );
  res.json({ ok: true });
});

/** Render a saved visualization: run the SQL, then build the chart spec. */
visualizationsRouter.post("/:id/render", async (req, res) => {
  const row = db
    .prepare("SELECT * FROM visualizations WHERE id = ? AND user_id = ?")
    .get(req.params.id, req.user!.sub) as VizRow | undefined;
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (!row.connection_id) {
    res.status(400).json({ error: "visualization has no connection" });
    return;
  }
  const conn = db
    .prepare("SELECT type, config_json FROM connections WHERE id = ? AND user_id = ?")
    .get(row.connection_id, req.user!.sub) as { type: string; config_json: string } | undefined;
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
      res.json({ success: false, error: sqlResult.error, sql: sqlResult });
      return;
    }
    const data: Record<string, unknown[]> = {};
    sqlResult.columns.forEach((col, i) => {
      data[col] = sqlResult.rows.map((r) => r[i]);
    });
    if (row.python_code && row.renderer === "python") {
      const py = await pythonEngine.executePython({
        code: row.python_code,
        data,
      });
      res.json({
        success: py.success,
        spec: py.spec,
        error: py.error,
        row_count: sqlResult.row_count,
      });
      return;
    }
    const chart = await pythonEngine.renderChart({
      chart_type: row.chart_type,
      renderer: row.renderer,
      data,
      config: JSON.parse(row.config_json),
    });
    res.json({
      success: chart.success,
      spec: chart.spec,
      error: chart.error,
      row_count: sqlResult.row_count,
    });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});
