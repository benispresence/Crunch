import cors from "cors";
import express from "express";
import { config } from "./config.js";
import "./db/index.js";
import { adminRouter } from "./routes/admin.js";
import { authRouter } from "./routes/auth.js";
import { chatRouter } from "./routes/chat.js";
import { connectionsRouter } from "./routes/connections.js";
import { dashboardsRouter } from "./routes/dashboards.js";
import { foldersRouter } from "./routes/folders.js";
import { gitRouter } from "./routes/git.js";
import { queriesRouter } from "./routes/queries.js";
import { visualizationsRouter } from "./routes/visualizations.js";
import { vizRouter } from "./routes/viz.js";
import { seedDefaultAdmin } from "./services/auth.js";
import { pythonEngine } from "./services/pythonEngine.js";

const app = express();
app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json({ limit: "10mb" }));

// One-line request log so "did the request reach the backend?" is a
// trivial tail away. Skip /api/health to keep the log readable.
app.use((req, _res, next) => {
  if (req.path !== "/api/health") {
    console.log(`${new Date().toISOString().slice(11, 19)} ${req.method} ${req.path}`);
  }
  next();
});

app.get("/api/health", async (_req, res) => {
  const engine = await pythonEngine.health().catch((err: Error) => ({
    ok: false,
    body: err.message,
  }));
  res.json({ ok: true, engine });
});

app.use("/api/auth", authRouter);
app.use("/api/connections", connectionsRouter);
app.use("/api/folders", foldersRouter);
app.use("/api/queries", queriesRouter);
app.use("/api/viz", vizRouter);
app.use("/api/visualizations", visualizationsRouter);
app.use("/api/dashboards", dashboardsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/chat", chatRouter);
app.use("/api/git", gitRouter);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const seed = seedDefaultAdmin();
if (seed.created) {
  console.log("");
  console.log("  Default admin account created:");
  console.log(`    email:    ${seed.email}`);
  console.log(`    password: ${seed.password}`);
  console.log("  Sign in, then change the password via POST /api/auth/change-password");
  console.log("  (or the Change password form on the login screen).");
  console.log("");
}

app.listen(config.port, () => {
  console.log(`crunch backend listening on :${config.port}`);
});
