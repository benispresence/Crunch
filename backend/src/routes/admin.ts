import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { pythonEngine } from "../services/pythonEngine.js";

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

interface PackageRow {
  id: number;
  package_name: string;
  import_name: string | null;
  version_spec: string | null;
  installed_version: string | null;
  status: string;
  error_message: string | null;
  is_default: number;
  is_enabled: number;
  created_at: number;
  updated_at: number;
}

interface UserRow {
  id: number;
  email: string;
  role: string;
  created_at: number;
}

function rowToPackage(row: PackageRow) {
  return {
    id: row.id,
    package_name: row.package_name,
    import_name: row.import_name,
    version_spec: row.version_spec,
    installed_version: row.installed_version,
    status: row.status,
    error_message: row.error_message,
    is_default: !!row.is_default,
    is_enabled: !!row.is_enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

adminRouter.get("/packages", (_req, res) => {
  const rows = db
    .prepare("SELECT * FROM allowed_packages ORDER BY is_default DESC, package_name ASC")
    .all() as PackageRow[];
  res.json(rows.map(rowToPackage));
});

adminRouter.post("/packages", async (req, res) => {
  const parsed = z
    .object({
      package_name: z.string().min(1),
      import_name: z.string().optional(),
      version_spec: z.string().optional(),
      auto_install: z.boolean().default(true),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const info = db
    .prepare(
      "INSERT INTO allowed_packages (package_name, import_name, version_spec, status, is_enabled) VALUES (?, ?, ?, 'pending', 1)",
    )
    .run(
      parsed.data.package_name,
      parsed.data.import_name ?? parsed.data.package_name,
      parsed.data.version_spec ?? null,
    );
  const id = Number(info.lastInsertRowid);
  if (parsed.data.auto_install) {
    await installPackageById(id);
  }
  const row = db
    .prepare("SELECT * FROM allowed_packages WHERE id = ?")
    .get(id) as PackageRow;
  res.json(rowToPackage(row));
});

adminRouter.put("/packages/:id", (req, res) => {
  const parsed = z
    .object({ is_enabled: z.boolean().optional() })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (parsed.data.is_enabled !== undefined) {
    db.prepare(
      "UPDATE allowed_packages SET is_enabled = ?, updated_at = strftime('%s', 'now') WHERE id = ?",
    ).run(parsed.data.is_enabled ? 1 : 0, req.params.id);
  }
  res.json({ ok: true });
});

adminRouter.post("/packages/:id/install", async (req, res) => {
  const result = await installPackageById(Number(req.params.id));
  res.json(result);
});

adminRouter.post("/packages/:id/uninstall", async (req, res) => {
  const row = db
    .prepare("SELECT * FROM allowed_packages WHERE id = ?")
    .get(req.params.id) as PackageRow | undefined;
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (row.is_default) {
    res.status(400).json({ error: "cannot uninstall default package" });
    return;
  }
  try {
    const r = await pythonEngine.uninstallPackage(row.package_name);
    db.prepare(
      "UPDATE allowed_packages SET status = ?, installed_version = NULL, error_message = ?, updated_at = strftime('%s', 'now') WHERE id = ?",
    ).run(r.success ? "pending" : "failed", r.error ?? null, row.id);
    res.json(r);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

adminRouter.delete("/packages/:id", (req, res) => {
  const row = db
    .prepare("SELECT is_default FROM allowed_packages WHERE id = ?")
    .get(req.params.id) as { is_default: number } | undefined;
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (row.is_default) {
    res.status(400).json({ error: "cannot delete default package" });
    return;
  }
  db.prepare("DELETE FROM allowed_packages WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

async function installPackageById(
  id: number,
): Promise<{ success: boolean; version?: string; error?: string }> {
  const row = db
    .prepare("SELECT * FROM allowed_packages WHERE id = ?")
    .get(id) as PackageRow | undefined;
  if (!row) return { success: false, error: "not found" };
  db.prepare(
    "UPDATE allowed_packages SET status = 'installing', error_message = NULL, updated_at = strftime('%s', 'now') WHERE id = ?",
  ).run(id);
  try {
    const r = await pythonEngine.installPackage(
      row.package_name,
      row.version_spec ?? undefined,
    );
    db.prepare(
      "UPDATE allowed_packages SET status = ?, installed_version = ?, error_message = ?, updated_at = strftime('%s', 'now') WHERE id = ?",
    ).run(
      r.success ? "installed" : "failed",
      r.version ?? null,
      r.error ?? null,
      id,
    );
    return r;
  } catch (err) {
    const msg = (err as Error).message;
    db.prepare(
      "UPDATE allowed_packages SET status = 'failed', error_message = ?, updated_at = strftime('%s', 'now') WHERE id = ?",
    ).run(msg, id);
    return { success: false, error: msg };
  }
}

adminRouter.get("/users", (_req, res) => {
  const rows = db
    .prepare("SELECT id, email, role, created_at FROM users ORDER BY id ASC")
    .all() as UserRow[];
  res.json(rows);
});

adminRouter.put("/users/:id/role", (req, res) => {
  const parsed = z
    .object({ role: z.enum(["admin", "editor", "viewer"]) })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (Number(req.params.id) === req.user!.sub && parsed.data.role !== "admin") {
    res.status(400).json({ error: "cannot demote yourself" });
    return;
  }
  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(parsed.data.role, req.params.id);
  res.json({ ok: true });
});
