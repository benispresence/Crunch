/**
 * Launch the real backend entry point, authenticate like a client,
 * and assert overview + run-detail + cancel payloads.
 *
 * Usage: npx tsx scripts/pipeline-api-launch.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, "..");
const port = Number(process.env.LAUNCH_PORT ?? 3795);
const dbFile = process.env.LAUNCH_DB ?? path.join(os.tmpdir(), `crunch-pipe-api-${port}.sqlite`);

function log(msg: string) {
  console.log(msg);
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function http(pathname: string, init: RequestInit = {}, token?: string) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { ...init, headers });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* raw */ }
  return { status: res.status, body };
}

function startServer(): ChildProcess {
  try { fs.unlinkSync(dbFile); } catch { /* */ }
  const child = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: backendRoot,
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(port),
      BIND_HOST: "127.0.0.1",
      DATABASE_FILE: dbFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => process.stdout.write(`[backend] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[backend] ${d}`));
  return child;
}

async function waitHealth(child: ChildProcess) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`backend exited ${child.exitCode} before health`);
    try {
      const r = await http("/api/health");
      if (r.status === 200) return;
    } catch { /* not up */ }
    await sleep(200);
  }
  throw new Error("backend did not become healthy");
}

async function main() {
  const child = startServer();
  const fail = (msg: string) => {
    child.kill("SIGTERM");
    throw new Error(msg);
  };
  try {
    await waitHealth(child);
    const cfg = await http("/api/auth/config");
    const c = cfg.body as { default_admin_email?: string; default_admin_password?: string };
    if (!c.default_admin_password) fail("no bootstrap password from /api/auth/config");
    const login = await http("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: c.default_admin_email, password: c.default_admin_password }),
    });
    const token = (login.body as { token?: string }).token;
    if (!token) fail(`login failed: ${JSON.stringify(login.body)}`);
    await http("/api/auth/keep-default-password", { method: "POST", body: "{}" }, token);

    const conn = await http("/api/connections", {
      method: "POST",
      body: JSON.stringify({
        name: "analytics",
        type: "sqlite",
        config: { database: ":memory:" },
      }),
    }, token);
    const connId = (conn.body as { id: number }).id;

    const created = await http("/api/pipelines", {
      method: "POST",
      body: JSON.stringify({
        name: "orders-refresh",
        source_type: "custom",
        extract_strategy: "incremental",
        write_behavior: "merge",
        destination_connection_id: connId,
        destination_dataset: "raw",
        primary_key: "order_id",
        cursor_field: "updated_at",
        timezone: "Europe/Berlin",
        schedule: "0 * * * *",
        schedule_enabled: true,
        freshness_threshold_seconds: 3600,
        python_code: "def run():\n    raise RuntimeError('HTTP 429 Too Many Requests')\n",
        code_mode: "custom",
        tags: ["orders"],
      }),
    }, token);
    const pipeId = (created.body as { id: number }).id;
    await http(`/api/pipelines/${pipeId}/publish`, {
      method: "POST",
      body: JSON.stringify({ change_summary: "initial" }),
    }, token);

    const overview = await http("/api/pipelines/overview", {}, token);
    const ov = overview.body as {
      counts?: Record<string, number>;
      pipelines?: Array<Record<string, unknown>>;
    };
    if (!ov.counts) fail(`overview missing counts: ${JSON.stringify(overview.body)}`);
    for (const k of ["needs_attention", "running", "queued", "healthy", "paused"]) {
      if (typeof ov.counts[k] !== "number") fail(`missing count ${k}`);
    }
    const row = ov.pipelines?.find((p) => p.id === pipeId);
    if (!row) fail("pipeline missing from overview");
    for (const k of [
      "execution_health", "freshness", "recent_runs", "last_successful_update",
      "schedule", "timezone", "next_run", "duration_seconds", "rows_loaded",
      "published_version",
    ]) {
      if (!(k in row)) fail(`overview row missing ${k}`);
    }

    const run = await http(`/api/pipelines/${pipeId}/run`, { method: "POST", body: "{}" }, token);
    const runBody = run.body as { id?: number; status?: string };
    if (!runBody.id) fail(`run did not return id: ${JSON.stringify(run.body)}`);

    let d: Record<string, unknown> = {};
    const waitUntil = Date.now() + 20_000;
    while (Date.now() < waitUntil) {
      const detail = await http(`/api/pipelines/${pipeId}/runs/${runBody.id}`, {}, token);
      d = detail.body as Record<string, unknown>;
      const attempts = d.attempts as unknown[] | undefined;
      if (attempts && attempts.length > 0) break;
      if (d.log || d.error_message) break;
      await sleep(150);
    }
    for (const k of ["version_id", "triggered_by", "attempts", "timestamps", "log"]) {
      if (!(k in d)) fail(`run detail missing ${k}: ${JSON.stringify(d)}`);
    }
    log(`overview+run-detail ok run=${runBody.id} status=${d.status}`);

    // Live cancel: a sleeping pipeline.
    const sleeper = await http("/api/pipelines", {
      method: "POST",
      body: JSON.stringify({
        name: "sleeper",
        destination_connection_id: connId,
        python_code: "import time\ndef run():\n    time.sleep(60)\n    return {'rows_loaded': 0}\n",
        code_mode: "custom",
      }),
    }, token);
    const sid = (sleeper.body as { id: number }).id;
    await http(`/api/pipelines/${sid}/publish`, { method: "POST", body: "{}" }, token);
    const live = await http(`/api/pipelines/${sid}/run`, { method: "POST", body: "{}" }, token);
    const liveId = (live.body as { id: number }).id;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const st = await http(`/api/pipelines/${sid}/runs/${liveId}`, {}, token);
      const pid = (st.body as { pid?: number | null }).pid;
      if (pid) break;
      await sleep(100);
    }
    const cancelled = await http(
      `/api/pipelines/${sid}/runs/${liveId}/cancel`,
      { method: "POST", body: "{}" },
      token,
    );
    const cbody = cancelled.body as { status?: string; pid_alive?: boolean };
    log(`cancel payload ${JSON.stringify(cbody)}`);
    if (cbody.status !== "cancelled") fail(`cancel did not yield cancelled: ${JSON.stringify(cbody)}`);
    if (cbody.pid_alive) fail(`cancel left process running: ${JSON.stringify(cbody)}`);
    log("OK");
  } finally {
    child.kill("SIGTERM");
    await sleep(500);
    if (child.exitCode == null) child.kill("SIGKILL");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
