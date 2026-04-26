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
  name: string;
  sql: string;
  created_at: number;
  updated_at: number;
}

interface ConnectionRow {
  id: number;
  type: string;
  config_json: string;
}

queriesRouter.get("/", (req, res) => {
  const rows = db
    .prepare("SELECT id, connection_id, name, sql, created_at, updated_at FROM queries WHERE user_id = ? ORDER BY updated_at DESC")
    .all(req.user!.sub) as QueryRow[];
  res.json(rows);
});

queriesRouter.post("/", (req, res) => {
  const parsed = z
    .object({
      name: z.string().min(1),
      sql: z.string(),
      connection_id: z.number().nullable().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const info = db
    .prepare("INSERT INTO queries (user_id, connection_id, name, sql) VALUES (?, ?, ?, ?)")
    .run(req.user!.sub, parsed.data.connection_id ?? null, parsed.data.name, parsed.data.sql);
  res.json({ id: Number(info.lastInsertRowid) });
});

queriesRouter.put("/:id", (req, res) => {
  const parsed = z
    .object({ name: z.string().optional(), sql: z.string().optional() })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  db.prepare(
    "UPDATE queries SET name = COALESCE(?, name), sql = COALESCE(?, sql), updated_at = strftime('%s', 'now') WHERE id = ? AND user_id = ?",
  ).run(parsed.data.name ?? null, parsed.data.sql ?? null, req.params.id, req.user!.sub);
  res.json({ ok: true });
});

queriesRouter.post("/validate", async (req, res) => {
  const parsed = z.object({ sql: z.string() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  res.json(await pythonEngine.validateSql(parsed.data.sql));
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
