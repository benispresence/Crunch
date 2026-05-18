import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import { requireAuth } from "../middleware/auth.js";

export const dashboardsRouter = Router();
dashboardsRouter.use(requireAuth);

interface DashboardRow {
  id: number;
  name: string;
  description: string | null;
  layout_json: string;
  created_at: number;
  updated_at: number;
}

interface WidgetRow {
  id: number;
  dashboard_id: number;
  visualization_id: number | null;
  query_id: number | null;
  position_x: number;
  position_y: number;
  width: number;
  height: number;
  title_override: string | null;
}

dashboardsRouter.get("/", (req, res) => {
  const rows = db
    .prepare("SELECT id, name, description, folder_id, updated_at FROM dashboards WHERE user_id = ? ORDER BY updated_at DESC")
    .all(req.user!.sub);
  res.json(rows);
});

dashboardsRouter.get("/:id", (req, res) => {
  const dash = db
    .prepare("SELECT * FROM dashboards WHERE id = ? AND user_id = ?")
    .get(req.params.id, req.user!.sub) as DashboardRow | undefined;
  if (!dash) {
    res.status(404).json({ error: "not found" });
    return;
  }
  // Widgets may target either a saved query (new) or a legacy visualization.
  // LEFT JOIN both sides and let the caller see whichever name/chart_type is
  // available so the UI can render either kind of source uniformly.
  const widgets = db
    .prepare(
      `SELECT w.*,
              COALESCE(q.name, v.name) AS source_name,
              COALESCE(q.chart_type, v.chart_type) AS chart_type
       FROM dashboard_widgets w
       LEFT JOIN queries q ON q.id = w.query_id
       LEFT JOIN visualizations v ON v.id = w.visualization_id
       WHERE w.dashboard_id = ?`,
    )
    .all(dash.id) as Array<WidgetRow & { source_name: string; chart_type: string }>;
  res.json({
    id: dash.id,
    name: dash.name,
    description: dash.description,
    layout: JSON.parse(dash.layout_json),
    widgets,
  });
});

dashboardsRouter.post("/", (req, res) => {
  const parsed = z
    .object({
      name: z.string().min(1),
      description: z.string().optional(),
      folder_id: z.number().int().nullable().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const info = db
    .prepare(
      "INSERT INTO dashboards (user_id, name, description, folder_id) VALUES (?, ?, ?, ?)",
    )
    .run(
      req.user!.sub,
      parsed.data.name,
      parsed.data.description ?? null,
      parsed.data.folder_id ?? null,
    );
  res.json({ id: Number(info.lastInsertRowid) });
});

dashboardsRouter.put("/:id", (req, res) => {
  const parsed = z
    .object({
      name: z.string().optional(),
      description: z.string().nullable().optional(),
      folder_id: z.number().int().nullable().optional(),
      layout: z.record(z.unknown()).optional(),
    })
    .safeParse(req.body);
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
  if (parsed.data.description !== undefined) {
    fields.push("description = ?");
    values.push(parsed.data.description);
  }
  if (parsed.data.folder_id !== undefined) {
    fields.push("folder_id = ?");
    values.push(parsed.data.folder_id);
  }
  if (parsed.data.layout !== undefined) {
    fields.push("layout_json = ?");
    values.push(JSON.stringify(parsed.data.layout));
  }
  if (fields.length === 0) {
    res.json({ ok: true });
    return;
  }
  fields.push("updated_at = strftime('%s', 'now')");
  values.push(req.params.id, req.user!.sub);
  db.prepare(
    `UPDATE dashboards SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`,
  ).run(...values);
  res.json({ ok: true });
});

dashboardsRouter.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM dashboards WHERE id = ? AND user_id = ?").run(
    req.params.id,
    req.user!.sub,
  );
  res.json({ ok: true });
});

const widgetSchema = z
  .object({
    query_id: z.number().int().optional(),
    visualization_id: z.number().int().optional(),
    position_x: z.number().int().min(0).default(0),
    position_y: z.number().int().min(0).default(0),
    width: z.number().int().min(1).max(12).default(6),
    height: z.number().int().min(1).max(20).default(4),
    title_override: z.string().nullable().optional(),
  })
  .refine(
    (d) => (d.query_id != null) !== (d.visualization_id != null),
    { message: "exactly one of query_id or visualization_id is required" },
  );

dashboardsRouter.post("/:id/widgets", (req, res) => {
  const dash = db
    .prepare("SELECT id FROM dashboards WHERE id = ? AND user_id = ?")
    .get(req.params.id, req.user!.sub);
  if (!dash) {
    res.status(404).json({ error: "dashboard not found" });
    return;
  }
  const parsed = widgetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const info = db
    .prepare(
      `INSERT INTO dashboard_widgets
         (dashboard_id, query_id, visualization_id, position_x, position_y, width, height, title_override)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      req.params.id,
      parsed.data.query_id ?? null,
      parsed.data.visualization_id ?? null,
      parsed.data.position_x,
      parsed.data.position_y,
      parsed.data.width,
      parsed.data.height,
      parsed.data.title_override ?? null,
    );
  res.json({ id: Number(info.lastInsertRowid) });
});

dashboardsRouter.put("/:id/widgets/positions", (req, res) => {
  const dash = db
    .prepare("SELECT id FROM dashboards WHERE id = ? AND user_id = ?")
    .get(req.params.id, req.user!.sub);
  if (!dash) {
    res.status(404).json({ error: "dashboard not found" });
    return;
  }
  const parsed = z
    .object({
      widgets: z.array(
        z.object({
          id: z.number().int(),
          position_x: z.number().int(),
          position_y: z.number().int(),
          width: z.number().int().min(1).max(12),
          height: z.number().int().min(1).max(20),
        }),
      ),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const stmt = db.prepare(
    "UPDATE dashboard_widgets SET position_x = ?, position_y = ?, width = ?, height = ? WHERE id = ? AND dashboard_id = ?",
  );
  const tx = db.transaction((items: typeof parsed.data.widgets) => {
    for (const w of items) {
      stmt.run(w.position_x, w.position_y, w.width, w.height, w.id, req.params.id);
    }
  });
  tx(parsed.data.widgets);
  db.prepare(
    "UPDATE dashboards SET updated_at = strftime('%s', 'now') WHERE id = ?",
  ).run(req.params.id);
  res.json({ ok: true });
});

dashboardsRouter.delete("/:id/widgets/:widgetId", (req, res) => {
  const dash = db
    .prepare("SELECT id FROM dashboards WHERE id = ? AND user_id = ?")
    .get(req.params.id, req.user!.sub);
  if (!dash) {
    res.status(404).json({ error: "dashboard not found" });
    return;
  }
  db.prepare("DELETE FROM dashboard_widgets WHERE id = ? AND dashboard_id = ?").run(
    req.params.widgetId,
    req.params.id,
  );
  res.json({ ok: true });
});
