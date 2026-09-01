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

import { app, BrowserWindow, dialog, Menu, shell } from "electron";
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

function appIcon() {
  const packaged = path.join(__dirname, "..", "build", "icon.png");
  if (fs.existsSync(packaged)) return packaged;
  return path.join(repoRoot(), "frontend", "public", "logo.png");
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
  const icon = appIcon();
  if (process.platform === "darwin") {
    app.dock?.setIcon(icon);
  }
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    title: "Crunch",
    icon,
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

let importing = false;

function parseDotEnv(file) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!file || !fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[trimmed.slice(0, eq).trim()] = val;
  }
  return out;
}

function findSourceEnv(sqlitePath) {
  const dir = path.dirname(sqlitePath);
  const candidates = [
    path.join(dir, ".env"),
    path.join(dir, "..", ".env"),
    path.join(dir, "..", "backend", ".env"),
  ];
  return candidates.find((f) => fs.existsSync(f)) ?? "";
}

function findSourceWorkspace(sqlitePath) {
  const dir = path.dirname(sqlitePath);
  const candidates = [
    path.join(dir, "..", "nicemeta-workspace"),
    path.join(dir, "nicemeta-workspace"),
    path.join(dir, "..", "..", "nicemeta-workspace"),
  ];
  return candidates.find((f) => fs.existsSync(f) && fs.statSync(f).isDirectory()) ?? "";
}

function suggestedImportSqlite() {
  const candidates = [
    !app.isPackaged ? path.join(repoRoot(), "backend", "nicemeta.sqlite") : null,
    path.join(os.homedir(), "CursorProjects", "NiceMeta", "backend", "nicemeta.sqlite"),
    path.join(os.homedir(), "Projects", "NiceMeta", "backend", "nicemeta.sqlite"),
    path.join(os.homedir(), "nice-meta", "backend", "nicemeta.sqlite"),
  ].filter(Boolean);
  return candidates.find((f) => fs.existsSync(f)) || os.homedir();
}

function sidecarNode() {
  if (app.isPackaged) {
    return path.join(
      resourcesDir(),
      "node",
      process.platform === "win32" ? "node.exe" : "bin/node",
    );
  }
  return process.env.npm_node_execpath || "node";
}

function importScriptPath() {
  if (app.isPackaged) return path.join(resourcesDir(), "import-instance.mjs");
  return path.join(repoRoot(), "desktop", "scripts", "import-instance.mjs");
}

function backendNodeModules() {
  if (app.isPackaged) return path.join(resourcesDir(), "backend", "node_modules");
  return path.join(repoRoot(), "backend", "node_modules");
}

function runImportScript(extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(sidecarNode(), [importScriptPath()], {
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (buf) => {
      out += buf.toString();
    });
    child.stderr?.on("data", (buf) => {
      err += buf.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        try {
          resolve(JSON.parse(out.trim() || "{}"));
        } catch {
          resolve({ ok: true, raw: out });
        }
      } else {
        reject(new Error((err || out || `import exited ${code}`).trim()));
      }
    });
  });
}

async function importFromOtherInstance() {
  if (importing) return;
  const win = mainWindow;
  const picked = await dialog.showOpenDialog(win ?? undefined, {
    title: "Choose the other Crunch database",
    defaultPath: suggestedImportSqlite(),
    properties: ["openFile"],
    filters: [
      { name: "Crunch database", extensions: ["sqlite", "db"] },
      { name: "All files", extensions: ["*"] },
    ],
    message:
      "Pick nicemeta.sqlite from the instance you want to copy. "
      + "The browser/dev app usually stores it at backend/nicemeta.sqlite in the git repo.",
  });
  if (picked.canceled || !picked.filePaths[0]) return;

  const sourceSqlite = picked.filePaths[0];
  const sourceEnvFile = findSourceEnv(sourceSqlite);
  const sourceWorkspace = findSourceWorkspace(sourceSqlite);
  const sourceEnv = parseDotEnv(sourceEnvFile);
  const destDir = path.join(userDir(), "data");
  const destSqlite = path.join(destDir, "nicemeta.sqlite");
  const destWorkspace = path.join(userDir(), "workspace");

  const confirm = await dialog.showMessageBox(win ?? undefined, {
    type: "warning",
    buttons: ["Cancel", "Replace and restart"],
    defaultId: 1,
    cancelId: 0,
    title: "Replace this app's data?",
    message: "This Mac app's queries, connections, dashboards, and users will be replaced.",
    detail: [
      `Source: ${sourceSqlite}`,
      sourceEnvFile ? `Encryption key: ${sourceEnvFile}` : "Encryption key: not found next to the file (dev JWT fallback will be tried).",
      sourceWorkspace ? `Workspace: ${sourceWorkspace}` : "Workspace: none found (queries in SQLite still import).",
      "",
      "Connection passwords and API keys are re-encrypted for this app.",
      "Sign in afterwards with the other instance's account.",
      "A backup of the current database is kept next to it.",
    ].join("\n"),
  });
  if (confirm.response !== 1) return;

  importing = true;
  const tmp = path.join(destDir, `nicemeta.importing-${Date.now()}.sqlite`);
  const secrets = loadOrCreateSecrets();
  let stopped = false;
  try {
    if (win && !win.isDestroyed()) {
      win.setTitle("Crunch — importing…");
    }
    fs.mkdirSync(destDir, { recursive: true });
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);

    const result = await runImportScript({
      CRUNCH_IMPORT_FROM: sourceSqlite,
      CRUNCH_IMPORT_TO: tmp,
      CRUNCH_IMPORT_FROM_DATA_KEY: sourceEnv.DATA_KEY || "",
      CRUNCH_IMPORT_FROM_JWT_SECRET: sourceEnv.JWT_SECRET || "dev-secret-change-me",
      CRUNCH_IMPORT_TO_DATA_KEY: secrets.DATA_KEY,
      CRUNCH_IMPORT_TO_JWT_SECRET: secrets.JWT_SECRET,
      CRUNCH_BACKEND_NODE_MODULES: backendNodeModules(),
      CRUNCH_IMPORT_FROM_WORKSPACE: sourceWorkspace,
      CRUNCH_IMPORT_TO_WORKSPACE: destWorkspace,
    });

    stopChildren();
    stopped = true;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    if (fs.existsSync(destSqlite)) {
      fs.copyFileSync(destSqlite, `${destSqlite}.bak-${stamp}`);
    }
    // Wait until the backend has dropped the SQLite lock, then swap.
    const deadline = Date.now() + 8000;
    let lastErr = null;
    while (Date.now() < deadline) {
      try {
        for (const ext of ["-wal", "-shm"]) {
          const f = destSqlite + ext;
          if (fs.existsSync(f)) fs.unlinkSync(f);
        }
        if (fs.existsSync(destSqlite)) fs.unlinkSync(destSqlite);
        fs.renameSync(tmp, destSqlite);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (lastErr) throw lastErr;

    log("import complete", result);
    await dialog.showMessageBox(win ?? undefined, {
      type: "info",
      title: "Import complete",
      message: "Data copied. Crunch will restart.",
      detail: result && typeof result.rekeyed === "number"
        ? `Re-encrypted ${result.rekeyed} secret${result.rekeyed === 1 ? "" : "s"}.`
        : "",
    });
    app.relaunch();
    app.exit(0);
  } catch (err) {
    importing = false;
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    const msg = err instanceof Error ? err.message : String(err);
    log("import failed", msg);
    await dialog.showMessageBox(win ?? undefined, {
      type: "error",
      title: "Import failed",
      message: msg,
    });
    if (stopped) {
      app.relaunch();
      app.exit(1);
      return;
    }
    if (win && !win.isDestroyed()) win.setTitle("Crunch");
  }
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  /** @type {import('electron').MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        }]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Import from another Crunch instance…",
          click: () => {
            void importFromOtherInstance();
          },
        },
        {
          label: "Reveal data folder",
          click: () => {
            void shell.openPath(userDir());
          },
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
  app.whenReady().then(() => {
    buildMenu();
    return createWindow();
  });
  app.on("before-quit", stopChildren);
  app.on("window-all-closed", () => {
    stopChildren();
    app.quit();
  });
}
