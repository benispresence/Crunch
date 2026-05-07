import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import { requireAuth } from "../middleware/auth.js";

export const foldersRouter = Router();
foldersRouter.use(requireAuth);

interface FolderRow {
  id: number;
  user_id: number;
  parent_id: number | null;
  name: string;
  sort_order: number;
  created_at: number;
}

function rowToFolder(row: FolderRow) {
  return {
    id: row.id,
    parent_id: row.parent_id,
    name: row.name,
    sort_order: row.sort_order,
    created_at: row.created_at,
  };
}

foldersRouter.get("/", (req, res) => {
  const rows = db
    .prepare(
      "SELECT * FROM folders WHERE user_id = ? ORDER BY parent_id IS NULL DESC, parent_id, sort_order, name",
    )
    .all(req.user!.sub) as FolderRow[];
  res.json(rows.map(rowToFolder));
});

foldersRouter.post("/", (req, res) => {
  const parsed = z
    .object({
      name: z.string().min(1).max(120),
      parent_id: z.number().int().nullable().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // If a parent is given, ensure it belongs to this user.
  if (parsed.data.parent_id != null) {
    const parent = db
      .prepare("SELECT id FROM folders WHERE id = ? AND user_id = ?")
      .get(parsed.data.parent_id, req.user!.sub);
    if (!parent) {
      res.status(400).json({ error: "parent folder not found" });
      return;
    }
  }
  const info = db
    .prepare("INSERT INTO folders (user_id, parent_id, name) VALUES (?, ?, ?)")
    .run(req.user!.sub, parsed.data.parent_id ?? null, parsed.data.name.trim());
  res.json({ id: Number(info.lastInsertRowid) });
});

foldersRouter.put("/:id", (req, res) => {
  const parsed = z
    .object({
      name: z.string().min(1).max(120).optional(),
      parent_id: z.number().int().nullable().optional(),
      sort_order: z.number().int().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const id = Number(req.params.id);
  // Prevent setting parent to self or to a descendant.
  if (parsed.data.parent_id === id) {
    res.status(400).json({ error: "folder cannot be its own parent" });
    return;
  }
  if (parsed.data.parent_id != null) {
    const descendants = collectDescendantIds(id, req.user!.sub);
    if (descendants.has(parsed.data.parent_id)) {
      res.status(400).json({ error: "cannot move folder into its own descendant" });
      return;
    }
  }
  const fields: string[] = [];
  const values: unknown[] = [];
  if (parsed.data.name !== undefined) {
    fields.push("name = ?");
    values.push(parsed.data.name.trim());
  }
  if (parsed.data.parent_id !== undefined) {
    fields.push("parent_id = ?");
    values.push(parsed.data.parent_id);
  }
  if (parsed.data.sort_order !== undefined) {
    fields.push("sort_order = ?");
    values.push(parsed.data.sort_order);
  }
  if (fields.length === 0) {
    res.json({ ok: true });
    return;
  }
  values.push(id, req.user!.sub);
  const result = db
    .prepare(`UPDATE folders SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`)
    .run(...values);
  if (result.changes === 0) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ ok: true });
});

foldersRouter.delete("/:id", (req, res) => {
  const result = db
    .prepare("DELETE FROM folders WHERE id = ? AND user_id = ?")
    .run(req.params.id, req.user!.sub);
  if (result.changes === 0) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ ok: true });
});

function collectDescendantIds(rootId: number, userId: number): Set<number> {
  const out = new Set<number>();
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const children = db
      .prepare("SELECT id FROM folders WHERE parent_id = ? AND user_id = ?")
      .all(id, userId) as Array<{ id: number }>;
    for (const c of children) {
      if (!out.has(c.id)) {
        out.add(c.id);
        queue.push(c.id);
      }
    }
  }
  return out;
}
