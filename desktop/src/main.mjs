/**
 * Crunch desktop shell (Mac first).
 *
 * Electron is only the window — like a dedicated browser. It starts the
 * Python engine and the Express backend as child processes, waits until
 * they are healthy, then loads http://127.0.0.1:<port>.
 *
 * Packaged vs repo:
 *   - unpackaged (`npm start` from desktop/): uses the repo's venv + tsx.
 *   - packaged .app: extraResources hold a Node binary, frontend dist,
 *     backend dist, and (if packed) a bundled CPython + site-packages.
 */

import { app, BrowserWindow, dialog, shell } from "electron";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];
/** @type {BrowserWindow | null} */
let mainWindow = null;
let shuttingDown = false;

function repoRoot() {
  // desktop/src/main.mjs → repo root is ../..
  return path.resolve(__dirname, "..", "..");
}

function resourcesDir() {
  if (app.isPackaged) return process.resourcesPath;
  return path.join(repoRoot(), "desktop", ".pack");
}

function userDir() {
  return app.getPath("userData");
}

function log(...args) {
  console.log("[crunch-desktop]", ...args);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function loadOrCreateSecrets() {
  const file = path.join(userDir(), "secrets.json");
  const existing = readJson(file, null);
  if (
    existing &&
    typeof existing.JWT_SECRET === "string" &&
    typeof existing.PYTHON_ENGINE_TOKEN === "string" &&
    typeof existing.DATA_KEY === "string"
  ) {
    return existing;
  }
  const secrets = {
    JWT_SECRET: crypto.randomBytes(32).toString("hex"),
    PYTHON_ENGINE_TOKEN: crypto.randomBytes(32).toString("hex"),
    DATA_KEY: crypto.randomBytes(32).toString("hex"),
  };
  fs.mkdirSync(userDir(), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  return secrets;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on("error", reject);
  });
}

function waitForHttp(url, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) {
          resolve();
          return;
        }
        retry();
      });
      req.on("error", retry);
      req.setTimeout(1500, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`timed out waiting for ${url}`));
        return;
      }
      setTimeout(tick, 300);
    };
    tick();
  });
}

function firstExisting(candidates) {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function pythonExecutable() {
  const res = resourcesDir();
  const bundled = process.platform === "win32"
    ? path.join(res, "python", "python.exe")
    : path.join(res, "python", "bin", "python3");
  if (app.isPackaged) {
    return firstExisting([
      bundled,
      path.join(res, "python", "bin", "python"),
    ]) || "python3";
  }
  const root = repoRoot();
  return firstExisting([
    path.join(root, "python-engine", ".venv", "bin", "python"),
    path.join(root, "venv", "bin", "python"),
    path.join(root, "venv", "bin", "python3"),
  ]) || "python3";
}

function spawnLogged(cmd, args, opts) {
  log("spawn", cmd, args.join(" "));
  const child = spawn(cmd, args, {
    ...opts,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = opts.label || path.basename(cmd);
  child.stdout?.on("data", (buf) => process.stdout.write(`[${prefix}] ${buf}`));
  child.stderr?.on("data", (buf) => process.stderr.write(`[${prefix}] ${buf}`));
  child.on("exit", (code, signal) => {
    log(prefix, "exited", { code, signal });
    if (!shuttingDown && code && code !== 0) {
      dialog.showErrorBox(
        "Crunch stopped",
        `${prefix} exited unexpectedly (${signal || code}). Check the log in ${userDir()}.`,
      );
    }
  });
  children.push(child);
  return child;
}

function engineScript() {
  if (app.isPackaged) {
    return path.join(resourcesDir(), "python-engine", "server.py");
  }
  return path.join(repoRoot(), "python-engine", "server.py");
}

function crunchPythonPath() {
  const res = resourcesDir();
  if (app.isPackaged) {
    const pydeps = path.join(res, "pydeps");
    const src = path.join(res, "src");
    return [pydeps, src].filter((p) => fs.existsSync(p)).join(path.delimiter);
  }
  return path.join(repoRoot(), "src");
}

function backendEntry() {
  if (app.isPackaged) {
    return {
      cmd: path.join(resourcesDir(), "node", process.platform === "win32" ? "node.exe" : "bin/node"),
      args: [path.join(resourcesDir(), "backend", "dist", "index.js")],
      cwd: path.join(resourcesDir(), "backend"),
    };
  }
  const root = repoRoot();
  // Always a real Node binary — better-sqlite3 is compiled for Node, not
  // for Electron's ABI.
  const node = process.env.npm_node_execpath || "node";
  const dist = path.join(root, "backend", "dist", "index.js");
  const tsx = path.join(root, "backend", "node_modules", "tsx", "dist", "cli.mjs");
  if (fs.existsSync(dist)) {
    return { cmd: node, args: [dist], cwd: path.join(root, "backend") };
  }
  if (fs.existsSync(tsx)) {
    return { cmd: node, args: [tsx, "src/index.ts"], cwd: path.join(root, "backend") };
  }
  return { cmd: node, args: ["src/index.ts"], cwd: path.join(root, "backend") };
}

function frontendDist() {
  if (app.isPackaged) return path.join(resourcesDir(), "frontend", "dist");
  return path.join(repoRoot(), "frontend", "dist");
}

async function startStack() {
  fs.mkdirSync(userDir(), { recursive: true });
  const secrets = loadOrCreateSecrets();
  const apiPort = await findFreePort();
  const enginePort = await findFreePort();
  const origin = `http://127.0.0.1:${apiPort}`;

  const dataDir = path.join(userDir(), "data");
  const workspaceDir = path.join(userDir(), "workspace");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  const commonEnv = {
    ...process.env,
    CRUNCH_DESKTOP: "1",
    NODE_ENV: app.isPackaged ? "production" : (process.env.NODE_ENV || "development"),
    JWT_SECRET: secrets.JWT_SECRET,
    PYTHON_ENGINE_TOKEN: secrets.PYTHON_ENGINE_TOKEN,
    DATA_KEY: secrets.DATA_KEY,
    BIND_HOST: "127.0.0.1",
    PORT: String(apiPort),
    PYTHON_ENGINE_HOST: "127.0.0.1",
    PYTHON_ENGINE_PORT: String(enginePort),
    PYTHON_ENGINE_URL: `http://127.0.0.1:${enginePort}`,
    ENGINE_ENV: app.isPackaged ? "production" : "development",
    FRONTEND_DIST: frontendDist(),
    DATABASE_FILE: path.join(dataDir, "nicemeta.sqlite"),
    NICEMETA_WORKSPACE_DIR: workspaceDir,
    CORS_ORIGIN: origin,
    NICEMETA_PUBLIC_BASE_URL: origin,
    PYTHONPATH: crunchPythonPath(),
  };

  const py = pythonExecutable();
  if (!py) {
    throw new Error(
      "No Python 3 interpreter found. Install Python 3.11+ (python.org or Homebrew) and reopen Crunch.",
    );
  }
  spawnLogged(py, [engineScript()], {
    cwd: path.dirname(engineScript()),
    env: commonEnv,
    label: "engine",
  });

  const be = backendEntry();
  spawnLogged(be.cmd, be.args, {
    cwd: be.cwd,
    env: commonEnv,
    label: "backend",
  });

  await waitForHttp(`${origin}/api/health`, 45_000);
  return origin;
}

function splashHtml() {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8" /><title>Crunch</title>
<style>
  html,body{height:100%;margin:0;background:#1a1815;color:#f5f1ec;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    display:grid;place-items:center}
  .box{text-align:center}
  h1{font-weight:500;font-size:22px;margin:0 0 8px;letter-spacing:-0.02em}
  p{margin:0;color:#a8a098;font-size:13px}
</style></head>
<body><div class="box"><h1>Crunch</h1><p>Starting the workspace…</p></div></body></html>`)}`;
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    title: "Crunch",
    backgroundColor: "#1a1815",
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  await mainWindow.loadURL(splashHtml());
  try {
    const origin = await startStack();
    await mainWindow.loadURL(origin);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("startup failed", msg);
    await dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "Crunch failed to start",
      message: msg,
      detail:
        "The desktop app starts a local API and a Python query engine, then opens them in this window. "
        + "Python 3.11+ is required unless you packed a bundled interpreter.",
    });
    app.quit();
  }
}

function stopChildren() {
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(createWindow);
  app.on("before-quit", stopChildren);
  app.on("window-all-closed", () => {
    stopChildren();
    app.quit();
  });
}
