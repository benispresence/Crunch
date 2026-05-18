import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import { requireAuth } from "../middleware/auth.js";
import {
  encryptConnectionConfig,
  maskConnectionConfig,
} from "../services/crypto.js";

export const connectionsRouter = Router();
connectionsRouter.use(requireAuth);

const upsertSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["postgres", "mysql", "sqlite", "sqlserver", "file"]),
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

connectionsRouter.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM connections WHERE id = ? AND user_id = ?").run(req.params.id, req.user!.sub);
  res.json({ ok: true });
});
