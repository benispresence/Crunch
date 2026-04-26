import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { pythonEngine } from "../services/pythonEngine.js";

export const vizRouter = Router();
vizRouter.use(requireAuth);

vizRouter.post("/render", async (req, res) => {
  const parsed = z
    .object({
      chart_type: z.string(),
      renderer: z.string().optional(),
      data: z.record(z.array(z.unknown())),
      config: z.record(z.unknown()).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    res.json(await pythonEngine.renderChart(parsed.data));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

vizRouter.post("/python", async (req, res) => {
  const parsed = z
    .object({
      code: z.string(),
      data: z.record(z.array(z.unknown())).optional(),
      allowed_packages: z.array(z.string()).optional(),
      timeout_seconds: z.number().int().positive().max(120).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    res.json(await pythonEngine.executePython(parsed.data));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});
