import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import {
  clone,
  commitAll,
  init,
  isInitialized,
  pull,
  push,
  recentLog,
  setRemote,
  status,
} from "../services/gitOps.js";
import { exportToWorkspace, importFromWorkspace } from "../services/workspaceSync.js";

export const gitRouter = Router();
gitRouter.use(requireAuth, requireAdmin);

gitRouter.get("/status", async (_req, res) => {
  const s = await status(config.workspaceDir);
  res.json({ ...s, workspace_dir: config.workspaceDir });
});

gitRouter.get("/log", async (_req, res) => {
  if (!(await isInitialized(config.workspaceDir))) {
    res.json({ entries: [] });
    return;
  }
  res.json({ entries: await recentLog(config.workspaceDir, 30) });
});

gitRouter.post("/init", async (_req, res) => {
  const r = await init(config.workspaceDir);
  if (!r.ok) {
    res.status(500).json({ error: r.stderr || r.stdout || "git init failed" });
    return;
  }
  res.json({ ok: true });
});

gitRouter.post("/sync-export", async (req, res) => {
  try {
    const summary = await exportToWorkspace(req.user!.sub, config.workspaceDir);
    res.json({ ok: true, ...summary });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

gitRouter.post("/sync-import", async (req, res) => {
  try {
    const summary = await importFromWorkspace(req.user!.sub, config.workspaceDir);
    res.json({ ok: true, ...summary });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

gitRouter.post("/commit", async (req, res) => {
  const parsed = z
    .object({
      message: z.string().min(1).max(500),
      sync_first: z.boolean().default(true),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!(await isInitialized(config.workspaceDir))) {
    res.status(400).json({ error: "workspace is not a git repo — POST /api/git/init first" });
    return;
  }
  let exported = null;
  if (parsed.data.sync_first) {
    exported = await exportToWorkspace(req.user!.sub, config.workspaceDir);
  }
  const out = await commitAll(config.workspaceDir, parsed.data.message);
  res.json({ ...out, exported });
});

gitRouter.post("/push", async (_req, res) => {
  if (!(await isInitialized(config.workspaceDir))) {
    res.status(400).json({ error: "workspace not initialized" });
    return;
  }
  const r = await push(config.workspaceDir);
  if (!r.ok) {
    res.status(502).json({ error: r.stderr || r.stdout || "git push failed" });
    return;
  }
  res.json({ ok: true, output: r.stdout });
});

gitRouter.post("/pull", async (req, res) => {
  if (!(await isInitialized(config.workspaceDir))) {
    res.status(400).json({ error: "workspace not initialized" });
    return;
  }
  const r = await pull(config.workspaceDir);
  if (!r.ok) {
    res.status(502).json({ error: r.stderr || r.stdout || "git pull failed" });
    return;
  }
  // Auto-import any new files that arrived.
  const summary = await importFromWorkspace(req.user!.sub, config.workspaceDir);
  res.json({ ok: true, output: r.stdout, imported: summary });
});

gitRouter.put("/remote", async (req, res) => {
  const parsed = z
    .object({ url: z.string().min(1) })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!(await isInitialized(config.workspaceDir))) {
    res.status(400).json({ error: "workspace not initialized" });
    return;
  }
  const r = await setRemote(config.workspaceDir, parsed.data.url);
  if (!r.ok) {
    res.status(500).json({ error: r.stderr || r.stdout || "set-remote failed" });
    return;
  }
  res.json({ ok: true });
});

gitRouter.post("/clone", async (req, res) => {
  const parsed = z
    .object({ url: z.string().min(1) })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const r = await clone(config.workspaceDir, parsed.data.url);
  if (!r.ok) {
    res.status(502).json({ error: r.stderr || r.stdout || "git clone failed" });
    return;
  }
  // After clone, pull the contents into the DB.
  const summary = await importFromWorkspace(req.user!.sub, config.workspaceDir);
  res.json({ ok: true, output: r.stdout, imported: summary });
});
