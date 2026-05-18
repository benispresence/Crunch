import fs from "node:fs";
import path from "node:path";
import cors from "cors";
import express from "express";
import helmet from "helmet";
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
// Helmet sets a sensible baseline of security headers
// (X-Content-Type-Options, Strict-Transport-Security, etc.). We disable
// CSP/COEP since this is a JSON API and the static frontend is served
// separately by Vite/nginx — those layers set their own page-level CSP.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
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
if (seed.created && seed.password) {
  // Write the one-time random password to a file too so a user who
  // missed the boot log can still recover it. The file lives next to
  // the DB and is mode 0600. Sign in once, change the password, then
  // delete the file.
  const bootstrapPath = path.resolve(
    path.dirname(config.databaseFile),
    "FIRST_RUN_ADMIN_PASSWORD",
  );
  try {
    fs.writeFileSync(bootstrapPath, `${seed.email}\n${seed.password}\n`, { mode: 0o600 });
  } catch (e) {
    console.warn(`[seed] could not write ${bootstrapPath}: ${(e as Error).message}`);
  }
  console.log("");
  console.log("  ┌─ Default admin account created ───────────────────────────────┐");
  console.log(`  │  email:    ${seed.email.padEnd(50, " ")}│`);
  console.log(`  │  password: ${seed.password.padEnd(50, " ")}│`);
  console.log("  └───────────────────────────────────────────────────────────────┘");
  console.log("  This password was randomly generated and is shown only once.");
  console.log(`  Also written to: ${bootstrapPath}`);
  console.log("  You MUST change it on first login (the API will block until you do).");
  console.log("");
}

app.listen(config.port, () => {
  console.log(`crunch backend listening on :${config.port}`);
});
