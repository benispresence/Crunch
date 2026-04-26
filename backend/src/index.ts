import cors from "cors";
import express from "express";
import { config } from "./config.js";
import "./db/index.js";
import { authRouter } from "./routes/auth.js";
import { chatRouter } from "./routes/chat.js";
import { connectionsRouter } from "./routes/connections.js";
import { queriesRouter } from "./routes/queries.js";
import { vizRouter } from "./routes/viz.js";
import { pythonEngine } from "./services/pythonEngine.js";

const app = express();
app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json({ limit: "10mb" }));

app.get("/api/health", async (_req, res) => {
  const engine = await pythonEngine.health().catch((err: Error) => ({
    ok: false,
    body: err.message,
  }));
  res.json({ ok: true, engine });
});

app.use("/api/auth", authRouter);
app.use("/api/connections", connectionsRouter);
app.use("/api/queries", queriesRouter);
app.use("/api/viz", vizRouter);
app.use("/api/chat", chatRouter);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(config.port, () => {
  console.log(`nicemeta backend listening on :${config.port}`);
});
