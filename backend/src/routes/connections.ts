import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import { requireAuth } from "../middleware/auth.js";
import {
  encryptConnectionConfig,
  maskConnectionConfig,
  restoreMaskedSecrets,
} from "../services/crypto.js";
import { pythonEngine } from "../services/pythonEngine.js";

export const connectionsRouter = Router();
connectionsRouter.use(requireAuth);

const upsertSchema = z.object({
  name: z.string().min(1),
  type: z.enum([
    "postgres", "mysql", "mariadb", "sqlite", "sqlserver", "file",
    "duckdb", "snowflake", "bigquery", "redshift", "databricks",
    "clickhouse", "trino", "presto", "mongodb",
  ]),
  config: z.record(z.unknown()),
});

connectionsRouter.get("/", (req, res) => {
  const rows = db
    .prepare("SELECT id, name, type, config_json, created_at FROM connections WHERE user_id = ? ORDER BY id DESC")
    .all(req.user!.sub) as Array<{ id: number; name: string; type: string; config_json: string; created_at: number }>;
  res.json(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      // Mask secrets — the API never echoes back the password the user
      // typed in. Engine-side decryption happens server-side only.
      config: maskConnectionConfig(JSON.parse(r.config_json)),
      created_at: r.created_at,
    })),
  );
});

connectionsRouter.post("/", (req, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const encrypted = encryptConnectionConfig(parsed.data.config);
  const info = db
    .prepare("INSERT INTO connections (user_id, name, type, config_json) VALUES (?, ?, ?, ?)")
    .run(req.user!.sub, parsed.data.name, parsed.data.type, JSON.stringify(encrypted));
  res.json({ id: Number(info.lastInsertRowid) });
});

connectionsRouter.put("/:id", (req, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const existing = db
    .prepare("SELECT config_json FROM connections WHERE id = ? AND user_id = ?")
    .get(req.params.id, req.user!.sub) as { config_json: string } | undefined;
  if (!existing) {
    res.status(404).json({ error: "not found" });
    return;
  }
  // Carry over any secret the user left masked, then (re-)encrypt the rest.
  const stored = JSON.parse(existing.config_json) as Record<string, unknown>;
  const merged = restoreMaskedSecrets(parsed.data.config, stored);
  const encrypted = encryptConnectionConfig(merged);
  db.prepare(
    "UPDATE connections SET name = ?, type = ?, config_json = ? WHERE id = ? AND user_id = ?",
  ).run(
    parsed.data.name,
    parsed.data.type,
    JSON.stringify(encrypted),
    req.params.id,
    req.user!.sub,
  );
  res.json({ id: Number(req.params.id) });
});

connectionsRouter.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM connections WHERE id = ? AND user_id = ?").run(req.params.id, req.user!.sub);
  res.json({ ok: true });
});

/**
 * Walk a folder on disk and list every supported data file
 * underneath. Used by the "Browse folder" picker on the File
 * connection form — the user picks which entries to add. We cap the
 * recursion at a generous bound so the engine response stays a
 * reasonable size.
 */
connectionsRouter.post("/scan-folder", async (req, res) => {
  const parsed = z
    .object({
      path: z.string().min(1).max(4096),
      recursive: z.boolean().optional(),
      max_files: z.number().int().positive().max(20000).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const result = await pythonEngine.scanFolder(parsed.data);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});
